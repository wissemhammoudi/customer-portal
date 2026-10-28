<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\CustomerPortal\Services\PortalConfigService;
use Fleetbase\CustomerPortal\Services\PortalDeliveryFeeService;
use Fleetbase\CustomerPortal\Services\PortalOrderService;
use Fleetbase\CustomerPortal\Services\PortalReturnService;
use Fleetbase\CustomerPortal\Services\PortalExpressService;
use Fleetbase\FleetOps\Http\Controllers\Internal\v1\ServiceQuoteController as FleetOpsServiceQuoteController;
use Fleetbase\FleetOps\Http\Resources\v1\ServiceQuote as ServiceQuoteResource;
use Fleetbase\FleetOps\Models\Place;
use Fleetbase\FleetOps\Models\PurchaseRate;
use Fleetbase\FleetOps\Models\ServiceQuote;
use Fleetbase\FleetOps\Models\ServiceRate;
use Fleetbase\FleetOps\Support\DeliveryOptions;
use Fleetbase\FleetOps\Support\Utils;
use Fleetbase\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;

class ServiceQuoteController extends Controller
{
    public function __construct(
        protected PortalAccountResolver $accountResolver,
        protected PortalOrderService $orderService,
        protected PortalConfigService $portalConfig,
        protected FleetOpsServiceQuoteController $fleetOpsServiceQuotes,
    ) {
    }

    public function preliminary(Request $request)
    {
        return (new ServiceQuote())->getConnection()->transaction(fn () => $this->preliminaryInTransaction($request));
    }

    protected function preliminaryInTransaction(Request $request)
    {
        $context = $this->accountResolver->resolve();
        $this->orderService->validateNewOrder($request, $context);
        DeliveryOptions::validateInput($request->all());
        $enabledConfigs = $this->portalConfig->enabledOrderConfigIds();
        $config = $this->orderService->resolveOrderConfig($request, $enabledConfigs);
        abort_if(!$config, 422, 'The selected transportation workflow is unavailable.');
        abort_if(is_array($enabledConfigs) && !in_array($config->uuid, $enabledConfigs, true)
            && !in_array($config->public_id, $enabledConfigs, true), 422, 'This delivery workflow is disabled.');
        $cod = PortalOrderService::codAttributes(DeliveryOptions::payloadInput($request->all()));
        $fingerprint = DeliveryOptions::fingerprint($request->all());
        $routeFingerprint = $this->orderService->resolvedRouteFingerprint($request->all(), $context);
        $payload = $this->portalPayload($request, $context);
        $payload = array_merge($payload, $cod);

        if ($this->stopCount($payload) < 2) {
            return response()->apiError('Pickup and dropoff or at least two waypoints are required.');
        }

        // Never allow customer-supplied distance/time or integrated-vendor parameters to set the base fare.
        $request->replace(Arr::except($request->all(), ['distance', 'time', 'facilitator', 'cod']));
        if ($cod !== []) {
            $request->merge(['cod' => true]);
        }
        $request->merge([
            'payload'            => $payload,
            'service_type'       => $request->input('service_type'),
            'scheduled_at'       => $request->input('scheduled_at'),
            'currency'           => $request->input('currency'),
            'is_route_optimized' => $request->boolean('is_route_optimized', true),
            'single'             => $request->boolean('single', false),
        ]);

        $isReturn = $request->input('meta.delivery.purpose') === 'return';
        $originalId = $request->input('meta.delivery.original_order_uuid');
        $returns = new PortalReturnService();
        $express = new PortalExpressService();
        $serviceLevel = $request->input('meta.delivery.service_level', 'standard');
        if ($isReturn && $originalId) {
            $original = $this->orderService->resolveOrder($originalId, $context);
            $price = $returns->originalPrice($original, $serviceLevel);
            $price['original_order_uuid'] = $original->uuid;
            $quote = ServiceQuote::create([
                'company_uuid' => session('company'), 'service_rate_uuid' => $price['service_rate_uuid'],
                'amount' => $price['standard_amount'],
                'currency' => $price['currency'], 'expired_at' => now()->addMinutes(30),
            ]);
            if ($serviceLevel === 'express') {
                $express->applyPrice($quote);
            }
            $returns->applyPrice($quote, $price);
            $quoteIds = [$quote->uuid];
        } else {
            $quoteIds = $this->queryAllowedServiceQuotes($request);
            // One flat delivery fee by parcel volume; keep a single quote and drop the rest.
            $quoteIds = array_slice($quoteIds, 0, 1);
            $fees = new PortalDeliveryFeeService();
            ServiceQuote::whereIn('uuid', $quoteIds)->get()->each(fn ($quote) => $fees->applyStandardFee($quote, $payload['entities'] ?? []));
            if ($serviceLevel === 'express') {
                ServiceQuote::whereIn('uuid', $quoteIds)->get()->each(fn ($quote) => $express->applyPrice($quote));
            }
            if ($isReturn) {
                ServiceQuote::whereIn('uuid', $quoteIds)->get()->each(function ($quote) use ($returns, $serviceLevel) {
                    $returns->applyPrice($quote, ['amount' => $quote->amount, 'currency' => $quote->currency, 'service_level' => $serviceLevel]);
                });
            }
        }
        $this->markQuotesForPortal($quoteIds, $context, $fingerprint);
        ServiceQuote::whereIn('uuid', $quoteIds)->get()->each(function ($quote) use ($routeFingerprint, $serviceLevel) {
            $quote->updateMeta('customer_portal.resolved_route_fingerprint', $routeFingerprint);
            $quote->updateMeta('customer_portal.service_level', $serviceLevel);
        });

        $quotes = ServiceQuote::with(['items', 'serviceRate'])
            ->whereIn('uuid', $quoteIds)
            ->get()
            ->sortBy(fn ($quote) => array_search($quote->uuid, $quoteIds, true))
            ->values();

        return response()->json([
            'service_quotes' => ServiceQuoteResource::collection($quotes)->resolve(),
        ]);
    }

    protected function queryAllowedServiceQuotes(Request $request): array
    {
        $enabledServiceRateIds = $this->portalConfig->enabledServiceRateIds();

        if (is_array($enabledServiceRateIds) && count($enabledServiceRateIds) === 0) {
            return [];
        }

        $config = $this->orderService->resolveOrderConfig($request, $this->portalConfig->enabledOrderConfigIds());
        $serviceRateUuids = ServiceRate::where('company_uuid', session('company'))
            ->where(function ($query) use ($config) {
                $query->whereNull('order_config_uuid')->orWhere('order_config_uuid', $config->uuid);
            })
            ->when(is_array($enabledServiceRateIds), function ($query) use ($enabledServiceRateIds) {
                $query->where(function ($query) use ($enabledServiceRateIds) {
                    $query->whereIn('uuid', $enabledServiceRateIds)->orWhereIn('public_id', $enabledServiceRateIds);
                });
            })
            ->pluck('uuid')
            ->values()
            ->all();

        $quoteIds = [];
        foreach ($serviceRateUuids as $serviceRateUuid) {
            $quoteRequest = clone $request;
            $quoteRequest->merge(['service' => $serviceRateUuid, 'single' => false]);
            $response = $this->fleetOpsServiceQuotes->preliminaryQuery($quoteRequest);

            if ($response->getStatusCode() >= 400) {
                abort($response->getStatusCode(), implode(' ', data_get($response->getData(true), 'errors', [])));
            }

            $quoteIds = array_merge($quoteIds, $this->quoteIdsFromResponse($response->getData(true)));
        }

        return array_values(array_unique($quoteIds));
    }

    public function createStripeCheckoutSession(Request $request)
    {
        $context = $this->accountResolver->resolve();
        $quote   = $this->resolvePortalQuote($request->input('service_quote'), $context);

        if (!$quote) {
            return response()->apiError('The service quote to purchase does not exist.');
        }
        (new PortalExpressService())->assertQuotePrice($quote, data_get($quote->meta, 'customer_portal.service_level', 'standard'));
        abort_if($quote->expired_at && now()->greaterThanOrEqualTo($quote->expired_at), 422, 'This quote expired. Get a new quote.');
        abort_if($this->orderService->queryForAccount($context)->where('meta->customer_portal->service_quote_uuid', $quote->uuid)->exists(),
            409, 'This quote has already created a delivery.');
        if (data_get($quote->meta, 'customer_portal_return_price')) {
            $originalId = data_get($quote->meta, 'customer_portal_return_price.original_order_uuid');
            $original = $originalId ? $this->orderService->resolveOrder($originalId, $context) : null;
            if ($original) {
                (new PortalReturnService())->assertEligible($original);
            }
            (new PortalReturnService())->assertQuotePrice($quote, $original);
        }

        $request->merge(['service_quote' => $quote->uuid]);

        return $this->fleetOpsServiceQuotes->createStripeCheckoutSession($request);
    }

    public function getStripeCheckoutSessionStatus(Request $request)
    {
        $context = $this->accountResolver->resolve();
        $quote   = $this->resolvePortalQuote($request->input('service_quote'), $context);

        if (!$quote) {
            return response()->apiError('The service quote to purchase does not exist.');
        }

        $request->merge(['service_quote' => $quote->uuid]);
        $response = $this->fleetOpsServiceQuotes->getStripeCheckoutSessionStatus($request);

        if ($response->getStatusCode() < 400) {
            $data             = $response->getData(true);
            $purchaseRate     = data_get($data, 'purchaseRate');
            $purchaseRateUuid = data_get($purchaseRate, 'uuid');

            if (!$purchaseRateUuid) {
                $purchaseRateUuid = PurchaseRate::where('company_uuid', session('company'))
                    ->where('service_quote_uuid', $quote->uuid)
                    ->value('uuid');
            }

            if ($purchaseRateUuid) {
                $purchaseRate = PurchaseRate::with(['serviceQuote.items'])
                    ->where('uuid', $purchaseRateUuid)
                    ->first();

                $purchaseRate?->update([
                    'customer_uuid' => $context['account']->uuid,
                    'customer_type' => Utils::getMutationType($context['account']),
                ]);

                $data['purchaseRate'] = $purchaseRate?->fresh(['serviceQuote.items'])?->toArray();

                return response()->json($data);
            }
        }

        return $response;
    }

    protected function portalPayload(Request $request, array $context): array
    {
        $payload = DeliveryOptions::payloadInput($request->all());

        return [
            'pickup'    => $this->placePayload($this->resolvePlace($payload['pickup'] ?? null, $context)),
            'dropoff'   => $this->placePayload($this->resolvePlace($payload['dropoff'] ?? null, $context)),
            'return'    => $this->placePayload($this->resolvePlace($payload['return'] ?? null, $context)),
            'waypoints' => $this->waypointPayloads($payload['waypoints'] ?? [], $context),
            'entities'  => array_values(array_filter($payload['entities'] ?? [])),
        ];
    }

    protected function resolvePlace($place, array $context): ?Place
    {
        if (!$place) {
            return null;
        }

        return $this->orderService->resolveDeliveryPlace($place, $context);
    }

    protected function waypointPayloads(array $waypoints, array $context): array
    {
        return collect($this->orderService->resolveAccountWaypoints($waypoints, $context))
            ->map(function ($waypoint) {
                return [
                    ...$this->placePayload($waypoint['place']),
                    'type' => $waypoint['type'],
                ];
            })
            ->values()
            ->all();
    }

    protected function placePayload(?Place $place): ?array
    {
        if (!$place) {
            return null;
        }

        return [
            'uuid'        => $place->uuid,
            'public_id'   => $place->public_id,
            'name'        => $place->name,
            'address'     => $place->address,
            'street1'     => $place->street1,
            'street2'     => $place->street2,
            'city'        => $place->city,
            'province'    => $place->province,
            'postal_code' => $place->postal_code,
            'country'     => $place->country,
            'latitude'    => $place->latitude,
            'longitude'   => $place->longitude,
            'location'    => $place->location,
        ];
    }

    protected function stopCount(array $payload): int
    {
        return (int) filled(data_get($payload, 'pickup')) + (int) filled(data_get($payload, 'dropoff')) + count(data_get($payload, 'waypoints', []));
    }

    protected function quoteIdsFromResponse(array $data): array
    {
        $quotes = Arr::isAssoc($data) ? [$data] : $data;

        return collect($quotes)
            ->map(fn ($quote) => data_get($quote, 'uuid'))
            ->filter()
            ->values()
            ->all();
    }

    protected function markQuotesForPortal(array $quoteIds, array $context, ?string $fingerprint = null): void
    {
        ServiceQuote::whereIn('uuid', $quoteIds)->get()->each(function (ServiceQuote $quote) use ($context, $fingerprint) {
            $quote->updateMeta('customer_portal', [
                'account_uuid'    => $context['account']->uuid,
                'account_type'    => Utils::getMutationType($context['account']),
                'created_by_uuid' => session('user'),
                'created_at'      => now()->toISOString(),
                'delivery_fingerprint' => $fingerprint,
            ]);
        });
    }

    protected function resolvePortalQuote($id, array $context): ?ServiceQuote
    {
        if (!$id) {
            return null;
        }

        return ServiceQuote::where('company_uuid', session('company'))
            ->where(function ($query) use ($id) {
                $query->where('uuid', $id)->orWhere('public_id', $id);
            })
            ->where('meta->customer_portal->account_uuid', $context['account']->uuid)
            ->where('meta->customer_portal->account_type', Utils::getMutationType($context['account']))
            ->first();
    }
}
