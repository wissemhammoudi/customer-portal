<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Tracking\Providers\GoogleRoutesTrackingProvider;
use Fleetbase\LaravelMysqlSpatial\Types\Point;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\ValidationException;

class PortalRoutePreviewService
{
    public function __construct(
        protected PortalOrderService $orders,
        protected GoogleRoutesTrackingProvider $routing,
    ) {
    }

    public function preview(Request $request, array $context): array
    {
        $request->validate([
            'pickup' => 'required', 'dropoff' => 'required',
            'waypoints' => 'sometimes|array|max:23',
        ]);
        $inputs = [$request->input('pickup'), ...$request->input('waypoints', []), $request->input('dropoff')];
        $points = [];
        foreach ($inputs as $index => $input) {
            $input = data_get($input, 'place', $input);
            if (is_array($input) && (isset($input['latitude']) || isset($input['longitude']) || isset($input['location']))) {
                $latitude = $input['latitude'] ?? data_get($input, 'location.coordinates.1');
                $longitude = $input['longitude'] ?? data_get($input, 'location.coordinates.0');
                if (!is_numeric($latitude) || !is_numeric($longitude)) {
                    throw ValidationException::withMessages(['route' => "Valid coordinates are required for stop $index."]);
                }
                $point = new Point((float) $latitude, (float) $longitude);
            } else {
                $point = $this->orders->resolveDeliveryPlace($input, $context)?->location;
            }
            if (!$point || !is_finite($point->getLat()) || !is_finite($point->getLng())
                || abs($point->getLat()) > 90 || abs($point->getLng()) > 180) {
                throw ValidationException::withMessages(['route' => "Valid coordinates are required for stop $index."]);
            }
            // A newly entered street without coordinates must never route to the model's (0,0) default.
            if (is_array($input) && !data_get($input, 'uuid') && !data_get($input, 'id') && !data_get($input, 'public_id') && !data_get($input, 'place_uuid')
                && !data_get($input, 'location') && (!isset($input['latitude']) || !isset($input['longitude']))) {
                throw ValidationException::withMessages(['route' => "Coordinates are required for stop $index."]);
            }
            $points[] = $point;
        }
        try {
            $key = 'portal-road-route:' . hash('sha256', json_encode([
                session('company'), data_get($context, 'account.uuid'),
                array_map(fn ($point) => [$point->getLng(), $point->getLat()], $points),
            ], JSON_THROW_ON_ERROR));
            $result = Cache::remember($key, 60, fn () => $this->routing->preview($points));
            $coordinates = $result->coordinates;
            if (count($coordinates) < 2) {
                throw new \RuntimeException('No road geometry was returned.');
            }
            foreach ($coordinates as $coordinate) {
                if (!is_array($coordinate) || count($coordinate) < 2 || !is_numeric($coordinate[0]) || !is_numeric($coordinate[1])
                    || !is_finite((float) $coordinate[0]) || !is_finite((float) $coordinate[1])
                    || abs($coordinate[0]) > 180 || abs($coordinate[1]) > 90) {
                    throw new \RuntimeException('Invalid road geometry.');
                }
            }
        } catch (\RuntimeException | \Illuminate\Http\Client\ConnectionException $exception) {
            report($exception);
            abort(503, 'Road route preview is unavailable. Try again later.');
        }

        return ['route' => [
            'geometry' => ['type' => 'LineString', 'coordinates' => $coordinates],
            'distance_m' => $result->distanceMeters, 'duration_s' => $result->durationSeconds,
            'provider' => $result->provider,
        ]];
    }
}
