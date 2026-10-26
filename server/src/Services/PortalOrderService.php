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

    public function resolveOrder(string $id, array $context): Order
    {
        return $this->queryForAccount($context)
            ->where(function ($query) use ($id) {
                $query->where('uuid', $id)->orWhere('public_id', $id);
            })
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

    public function resolveOrderConfig(Request $request): ?OrderConfig
    {
        $orderConfigId = $request->input('order_config', $request->input('type'));
        if ($orderConfigId) {
            $orderConfig = OrderConfig::where('company_uuid', session('company'))
                ->where(function ($query) use ($orderConfigId) {
                    $query->where('uuid', $orderConfigId)->orWhere('public_id', $orderConfigId)->orWhere('key', $orderConfigId);
                })
                ->first();

            return $orderConfig;
        }

        return OrderConfig::where('company_uuid', session('company'))->first();
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
        return Place::where('company_uuid', session('company'))
            ->where('owner_uuid', $context['account']->uuid)
            ->where('owner_type', Utils::getMutationType($context['account']))
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
