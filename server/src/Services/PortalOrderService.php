<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Entity;
use Fleetbase\FleetOps\Models\Order;
use Fleetbase\FleetOps\Models\OrderConfig;
use Fleetbase\FleetOps\Models\Payload;
use Fleetbase\FleetOps\Models\Place;
use Fleetbase\FleetOps\Models\Waypoint;
use Fleetbase\FleetOps\Support\Utils;
use Fleetbase\FleetOps\Support\DeliveryOptions;
use Fleetbase\LaravelMysqlSpatial\Types\Point;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;
use Money\Currencies\ISOCurrencies;
use Money\Currency;
use Money\Parser\DecimalMoneyParser;

class PortalOrderService
{
    public function validateNewOrder(Request $request, array $context): void
    {
        $input = DeliveryOptions::payloadInput($request->all());
        Validator::make($request->all(), [
            'meta.delivery.purpose' => 'nullable|in:transportation,return',
            'meta.delivery.service_level' => 'nullable|in:standard,express',
            'meta.delivery.original_order_uuid' => 'nullable|string|max:64|prohibited_unless:meta.delivery.purpose,return',
            'scheduled_at' => 'nullable|date|after:now',
        ])->validate();
        if (!empty($input['return']) || !empty($input['waypoints']) || $request->boolean('is_multiple_dropoff_order')) {
            throw ValidationException::withMessages(['payload' => 'Customer deliveries support one pickup and one dropoff only. Intermediate stops are not supported.']);
        }
        if ($request->input('meta.delivery.purpose') === 'return') {
            $this->validateReturn($request, $context, $input);
            return;
        }
        $pickup = (new PortalPickupAddressService())->get($context);
        if (!$pickup) {
            throw ValidationException::withMessages(['pickup' => 'Save your account pickup address in Profile/Settings before requesting a delivery.']);
        }
        PortalPickupAddressService::validatedInput([
            'street1' => $pickup->street1, 'phone' => $pickup->phone,
            'latitude' => $pickup->location?->getLat(), 'longitude' => $pickup->location?->getLng(),
        ]);
        $selected = $this->resolveDeliveryPlace($input['pickup'] ?? null, $context);
        $rawPickup = $input['pickup'] ?? null;
        if (is_array($rawPickup) && (isset($rawPickup['latitude']) || isset($rawPickup['longitude']))) {
            Validator::make($rawPickup, [
                'latitude' => 'required|numeric|between:-90,90',
                'longitude' => 'required|numeric|between:-180,180',
            ])->validate();
            if (abs((float) $rawPickup['latitude'] - $pickup->location->getLat()) > 0.000001 ||
                abs((float) $rawPickup['longitude'] - $pickup->location->getLng()) > 0.000001) {
                throw ValidationException::withMessages(['pickup' => 'The pickup coordinates changed. Reload your account pickup and get a new quote.']);
            }
        }
        if (!$selected || $selected->uuid !== $pickup->uuid || $selected->street1 !== $pickup->street1
            || $selected->phone !== $pickup->phone || !$selected->location
            || abs($selected->location->getLat() - $pickup->location->getLat()) > 0.000001
            || abs($selected->location->getLng() - $pickup->location->getLng()) > 0.000001) {
            throw ValidationException::withMessages(['pickup' => 'Your account pickup address changed. Reload the current pickup address from Profile/Settings and request a new quote.']);
        }
        $dropoff = $this->resolveDeliveryPlace($input['dropoff'] ?? null, $context);
        if (!$dropoff || !is_string($dropoff->phone) || trim($dropoff->phone) === '') {
            throw ValidationException::withMessages(['dropoff.phone' => 'A dropoff address and contact phone are required.']);
        }
    }

    protected function validateReturn(Request $request, array $context, array $input): void
    {
        $returns = new PortalReturnService();
        $originalId = $request->input('meta.delivery.original_order_uuid');
        $pickup = $this->resolveDeliveryPlace($input['pickup'] ?? null, $context);
        if ($originalId) {
            $original = $this->resolveOrder($originalId, $context);
            $meta = $request->input('meta', []);
            data_set($meta, 'delivery.original_order_uuid', $original->uuid);
            $request->merge(['meta' => $meta]);
            $returns->assertReversedRoute($original, $pickup, $this->resolveDeliveryPlace($input['dropoff'] ?? null, $context));
            $returns->originalPrice($original);
        } else {
            $saved = (new PortalPickupAddressService())->get($context);
            if (!$saved) {
                throw ValidationException::withMessages(['dropoff' => 'Save your account address in Profile/Settings before requesting a return.']);
            }
            PortalPickupAddressService::validatedInput([
                'street1' => $saved->street1, 'phone' => $saved->phone,
                'latitude' => $saved->location?->getLat(), 'longitude' => $saved->location?->getLng(),
            ]);
            if (empty($input['dropoff'])) {
                if (is_array($request->input('payload'))) {
                    $payload = $request->input('payload');
                    $payload['dropoff'] = $saved->uuid;
                    $request->merge(['payload' => $payload]);
                } else {
                    $request->merge(['dropoff' => $saved->uuid]);
                }
                $input['dropoff'] = $saved->uuid;
            }
            $returns->assertSameEndpoint($this->resolveDeliveryPlace($input['dropoff'], $context), $saved, 'dropoff');
        }
        if (!$pickup || !is_string($pickup->phone) || trim($pickup->phone) === '') {
            throw ValidationException::withMessages(['pickup.phone' => 'A return pickup address and contact phone are required.']);
        }
    }

    public function deliveryOrderConfigs()
    {
        return OrderConfig::where('company_uuid', session('company'))->where('key', 'transport')
            ->where(function ($query) {
                $query->whereNull('namespace')->orWhere('namespace', 'not like', '%storefront%');
            });
    }

    public function queryForAccount(array $context)
    {
        $accountCustomerUuids = $this->accountCustomerUuids($context);

        // Fleet-Ops order creation paths can persist equivalent polymorphic types
        // differently. The customer UUID is canonical; company scoping preserves
        // tenant isolation without hiding orders because of a type representation.
        return Order::where('company_uuid', session('company'))
            ->whereIn('customer_uuid', $accountCustomerUuids)
            ->whereNull('deleted_at')
            ->withoutGlobalScopes();
    }

    public function resolveOrder(string $id, array $context, bool $lock = false): Order
    {
        return $this->queryForAccount($context)
            ->where(function ($query) use ($id) {
                $query->where('uuid', $id)->orWhere('public_id', $id);
            })
            ->when($lock, fn ($query) => $query->lockForUpdate())
            ->firstOrFail();
    }

    public function resolveOrderUuid($order, array $context): ?string
    {
        $orderId = is_array($order) ? data_get($order, 'uuid', data_get($order, 'id')) : $order;
        if (!$orderId) {
            return null;
        }

        return $this->queryForAccount($context)
            ->where(function ($query) use ($orderId) {
                $query->where('uuid', $orderId)->orWhere('public_id', $orderId);
            })
            ->value('uuid');
    }

    public function resolveOrderConfig(Request $request, ?array $enabled = null): ?OrderConfig
    {
        $orderConfigId = $request->input('order_config', $request->input('type'));
        if ($orderConfigId) {
            $orderConfig = $this->deliveryOrderConfigs()
                ->where(function ($query) use ($orderConfigId) {
                    $query->where('uuid', $orderConfigId)->orWhere('public_id', $orderConfigId)->orWhere('key', $orderConfigId);
                })
                ->first();

            return $orderConfig;
        }

        return $this->deliveryOrderConfigs()->when(is_array($enabled), function ($query) use ($enabled) {
            $query->where(function ($query) use ($enabled) {
                $query->whereIn('uuid', $enabled)->orWhereIn('public_id', $enabled);
            });
        })->first();
    }

    public function resolvedRouteFingerprint(array $input, array $context): string
    {
        $payload = DeliveryOptions::payloadInput($input);
        $route = [];
        foreach (['pickup', 'dropoff'] as $field) {
            $place = $this->resolveDeliveryPlace($payload[$field] ?? null, $context);
            $route[$field] = $place ? [
                'street1' => $place->street1, 'phone' => $place->phone,
                'latitude' => $place->location?->getLat(), 'longitude' => $place->location?->getLng(),
            ] : null;
        }

        return hash('sha256', json_encode($route, JSON_THROW_ON_ERROR));
    }

    public function buildPayloadFromInput(array $payloadInput, array $context): Payload
    {
        $payload   = new Payload();
        $entities  = data_get($payloadInput, 'entities', []);
        $waypoints = data_get($payloadInput, 'waypoints', []);
        $pickup    = $this->resolveDeliveryPlace(data_get($payloadInput, 'pickup'), $context);
        $dropoff   = $this->resolveDeliveryPlace(data_get($payloadInput, 'dropoff'), $context);
        $return    = $this->resolveDeliveryPlace(data_get($payloadInput, 'return'), $context);
        $waypoints = $this->resolveAccountWaypoints($waypoints, $context);
        if (($pickup === null) !== ($dropoff === null) || (!$pickup && count($waypoints) < 2)) {
            throw ValidationException::withMessages(['payload' => 'Select valid pickup and dropoff addresses or at least two route stops.']);
        }

        $payload->company_uuid = session('company');
        $payload->fill(self::codAttributes($payloadInput));

        if ($pickup) {
            $payload->setPickup($pickup, [
                'callback' => function ($pickup, $payload) {
                    $payload->setCurrentWaypoint($pickup, false);
                },
            ]);
        }

        if ($dropoff) {
            $payload->setDropoff($dropoff);
        }

        if ($return) {
            $payload->setReturn($return);
        }

        $payload->save();
        $payload->setWaypoints($waypoints);
        $payload->setEntities($entities);

        $firstWaypoint = $payload->getPickupOrFirstWaypoint();
        if ($firstWaypoint instanceof Place) {
            $payload->setCurrentWaypoint($firstWaypoint);
        }

        return $payload;
    }

    public static function codAttributes(array $input): array
    {
        if (!isset($input['cod_amount'])) {
            return [];
        }
        Validator::make($input, [
            'cod_amount' => ['required', 'numeric', 'gt:0', 'regex:/^\d+(\.\d{1,3})?$/'],
            'cod_currency' => ['required', 'string', 'regex:/^[A-Z]{3}$/'],
            'cod_payment_method' => ['required', 'in:cash'],
        ])->validate();
        $currencies = new ISOCurrencies();
        $currency = new Currency($input['cod_currency']);
        if (!$currencies->contains($currency)) {
            throw ValidationException::withMessages(['cod_currency' => 'Select a supported ISO currency.']);
        }
        $precision = $currencies->subunitFor($currency);
        $parts = explode('.', (string) $input['cod_amount']);
        if (strlen($parts[1] ?? '') > $precision) {
            throw ValidationException::withMessages(['cod_amount' => 'The amount has too many decimal places for this currency.']);
        }
        $amount = $parts[0] . ($precision ? '.' . str_pad($parts[1] ?? '', $precision, '0') : '');
        $minor = (new DecimalMoneyParser($currencies))->parse($amount, $currency)->getAmount();
        // payloads.cod_amount is a signed SQL INT, stored in minor units.
        $maximum = '2147483647';
        if (strlen($minor) > strlen($maximum) || (strlen($minor) === strlen($maximum) && strcmp($minor, $maximum) > 0)) {
            throw ValidationException::withMessages(['cod_amount' => 'The cash amount exceeds the supported integer range.']);
        }

        return ['cod_amount' => $amount, 'cod_currency' => $currency->getCode(), 'cod_payment_method' => 'cash'];
    }

    public static function creationFingerprint(array $input): string
    {
        $files = $input['files'] ?? [];
        sort($files);

        return hash('sha256', json_encode([
            'delivery' => DeliveryOptions::fingerprint($input),
            'notes' => $input['notes'] ?? null,
            'internal_id' => $input['internal_id'] ?? null,
            'pod_required' => (bool) ($input['pod_required'] ?? false),
            'pod_method' => $input['pod_method'] ?? null,
            'purchase_rate_uuid' => $input['purchase_rate_uuid'] ?? null,
            'files' => $files,
        ], JSON_THROW_ON_ERROR));
    }

    public function existingOrderForQuote(string $quoteUuid, string $fingerprint, array $context): ?Order
    {
        // The caller holds the service-quote row lock until creation commits.
        $order = Order::withoutGlobalScopes()
            ->where('company_uuid', session('company'))
            ->whereIn('customer_uuid', $this->accountCustomerUuids($context))
            ->where(function ($query) use ($quoteUuid) {
                $query->where('meta->customer_portal->service_quote_uuid', $quoteUuid)
                    ->orWhereHas('purchaseRate', fn ($rate) => $rate->withoutGlobalScopes()->where('service_quote_uuid', $quoteUuid));
            })
            ->lockForUpdate()
            ->first();
        if ($order) {
            abort_if($order->trashed(), 409, 'This quote has already been used by a deleted delivery. Get a new quote.');
            abort_unless(data_get($order->meta, 'customer_portal.creation_fingerprint') === $fingerprint, 409, 'This quote already created a different delivery. Get a new quote before creating another order.');
        }

        return $order;
    }

    public function resolveAccountWaypoints(array $waypoints, array $context): array
    {
        return collect($waypoints)
            ->map(function ($waypoint, $index) use ($context) {
                $placeInput = data_get($waypoint, 'place', $waypoint);
                $place = $this->resolveDeliveryPlace($placeInput, $context);

                if (!$place instanceof Place) {
                    throw ValidationException::withMessages(["waypoints.$index" => 'Select a valid address for this route stop.']);
                }

                return [
                    ...$waypoint,
                    'place'      => $place,
                    'place_uuid' => $place->uuid,
                    'type'       => data_get($waypoint, 'type', 'dropoff'),
                ];
            })
            ->values()
            ->all();
    }

    public function resolveDeliveryPlace($input, array $context): ?Place
    {
        if (!$input) {
            return null;
        }
        $identifier = is_array($input) ? data_get($input, 'place_uuid', data_get($input, 'uuid', data_get($input, 'id', data_get($input, 'public_id')))) : $input;
        $existing = is_string($identifier) ? $this->findAccountPlaceByIdentifier($identifier, $context) : null;
        if ($identifier && !$existing && (!is_array($input) || !filled(data_get($input, 'street1', data_get($input, 'address'))))) {
            throw ValidationException::withMessages(['payload' => 'A selected address is no longer available for this account.']);
        }
        $place = $existing ? clone $existing : new Place();
        if (is_array($input)) {
            $values = $this->accountPlaceValues($input, $context);
            $place->fill($existing ? array_intersect_key($values, $input) : $values);
        }
        if (!is_string($place->street1) || trim($place->street1) === '') {
            throw ValidationException::withMessages(['payload' => 'Provide a street address for each stop.']);
        }

        return $place;
    }

    public function resolveAccountPlace($place, array $context): ?Place
    {
        if (!$place) {
            return null;
        }

        if ($place instanceof Place) {
            return $this->ensureAccountPlace($place, $context);
        }

        if (!is_array($place)) {
            $resolved = is_string($place) ? $this->findAccountPlaceByIdentifier($place, $context) : null;
            if (!$resolved) {
                throw ValidationException::withMessages(['payload' => 'A selected address is no longer available for this account.']);
            }

            return $resolved;
        }

        $identifier = data_get($place, 'uuid', data_get($place, 'id', data_get($place, 'public_id')));
        if ($identifier && ($existingPlace = $this->findAccountPlaceByIdentifier($identifier, $context))) {
            return $existingPlace;
        }

        $values = $this->accountPlaceValues($place, $context);
        if (!is_string($values['street1'] ?? null) || trim($values['street1']) === '') {
            throw ValidationException::withMessages(['payload' => 'Select a saved address or provide a street address for each stop.']);
        }

        $existingPlace = $this->findMatchingAccountPlace($values, $context);
        if ($existingPlace instanceof Place) {
            $existingPlace->fill(array_filter($values, fn ($value) => $value !== null && $value !== ''));
            $existingPlace->save();

            return $existingPlace;
        }

        $place = new Place();
        $place->fill($values);
        $place->save();

        return $place;
    }

    public function ensureAccountPlace(Place $place, array $context): Place
    {
        $account = $context['account'];

        if ($place->owner_uuid === $account->uuid && $place->owner_type === Utils::getMutationType($account)) {
            return $place;
        }

        return $this->resolveAccountPlace($place->toArray(), $context);
    }

    protected function findAccountPlaceByIdentifier($identifier, array $context): ?Place
    {
        $owned = Place::where('company_uuid', session('company'))
            ->where('owner_uuid', $context['account']->uuid)->where('owner_type', Utils::getMutationType($context['account']))
            ->where(function ($query) use ($identifier) {
                $query->where('uuid', $identifier)->orWhere('public_id', $identifier);
            })->first();
        if ($owned) {
            return $owned;
        }
        $payloads = Payload::where('company_uuid', session('company'))
            ->whereIn('uuid', $this->queryForAccount($context)->select('payload_uuid'));
        return Place::withoutGlobalScopes()->where('company_uuid', session('company'))
            ->where(function ($query) use ($payloads) {
                $query->whereIn('uuid', (clone $payloads)->select('pickup_uuid'))
                    ->orWhereIn('uuid', (clone $payloads)->select('dropoff_uuid'));
            })
            ->where(function ($query) use ($identifier) {
                $query->where('uuid', $identifier)->orWhere('public_id', $identifier);
            })
            ->first();
    }

    protected function findMatchingAccountPlace(array $values, array $context): ?Place
    {
        $street1 = data_get($values, 'street1');
        $city    = data_get($values, 'city');
        $country = data_get($values, 'country');

        if (!$street1) {
            return null;
        }

        return Place::where('company_uuid', session('company'))
            ->where('owner_uuid', $context['account']->uuid)
            ->where('owner_type', Utils::getMutationType($context['account']))
            ->where('street1', $street1)
            ->when($city, fn ($query) => $query->where('city', $city))
            ->when($country, fn ($query) => $query->where('country', $country))
            ->first();
    }

    protected function accountPlaceValues(array $place, array $context): array
    {
        $account = $context['account'];
        $values  = Place::mergeStructuredPlaceAttributes($place);
        $street1 = data_get($values, 'street1', data_get($values, 'address'));

        $values['street1']      = $street1;
        $values['company_uuid'] = session('company');
        $values['owner_uuid']   = $account->uuid;
        $values['owner_type']   = Utils::getMutationType($account);

        if (empty($values['location'])) {
            $values['location'] = new Point(0, 0);
        }

        return $values;
    }

    protected function accountCustomerUuids(array $context): array
    {
        $uuids = collect();

        if ($context['contact'] ?? null) {
            $uuids->push($context['contact']->uuid);
        }

        if ($context['account'] ?? null) {
            $uuids->push($context['account']->uuid);
        }

        foreach ($context['accounts'] ?? [] as $account) {
            $uuid = data_get($account, 'uuid');
            if ($uuid) {
                $uuids->push($uuid);
            }
        }

        return $uuids
            ->filter(fn ($uuid) => filled($uuid))
            ->unique()
            ->values()
            ->all();
    }

    public function migrateCustomerOwnership($contact, $vendor, string $vendorType): void
    {
        $contactType = Utils::getMutationType($contact);
        $filter      = ['customer_uuid' => $contact->uuid, 'customer_type' => $contactType];
        $replacement = ['customer_uuid' => $vendor->uuid, 'customer_type' => $vendorType];

        Order::where($filter)->update($replacement);
        \Fleetbase\FleetOps\Models\PurchaseRate::where($filter)->update($replacement);
        Entity::where($filter)->update($replacement);
        Waypoint::where($filter)->update($replacement);
        Place::where('owner_uuid', $contact->uuid)->update(['owner_uuid' => $vendor->uuid, 'owner_type' => $vendorType]);
    }
}
