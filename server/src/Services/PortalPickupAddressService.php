<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Place;
use Fleetbase\FleetOps\Support\Utils;
use Fleetbase\LaravelMysqlSpatial\Types\Point;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Validator;

class PortalPickupAddressService
{
    public function query(array $context)
    {
        return Place::where('company_uuid', session('company'))
            ->where('owner_uuid', $context['account']->uuid)
            ->where('owner_type', Utils::getMutationType($context['account']));
    }

    public function get(array $context): ?Place
    {
        $id = data_get($context['account']->fresh()->meta, 'customer_portal.pickup_address_uuid');

        return $id ? $this->query($context)->where('uuid', $id)->first() : null;
    }

    public static function validatedInput(array $input): array
    {
        $input['street1'] = $input['street1'] ?? $input['address'] ?? '';
        $input['street1'] = is_string($input['street1']) ? trim($input['street1']) : $input['street1'];
        $input['phone'] = isset($input['phone']) && is_string($input['phone']) ? trim($input['phone']) : ($input['phone'] ?? '');
        $input['latitude'] = $input['latitude'] ?? data_get($input, 'location.coordinates.1');
        $input['longitude'] = $input['longitude'] ?? data_get($input, 'location.coordinates.0');
        Validator::make($input, [
            'street1' => 'required|string',
            'phone' => 'required|string',
            'latitude' => 'required|numeric|between:-90,90',
            'longitude' => 'required|numeric|between:-180,180',
        ])->validate();
        if (preg_match('/^\+?[0-9\s().-]+$/', $input['phone'])) {
            $input['phone'] = preg_replace('/[\s().-]+/', '', $input['phone']);
        }

        return $input;
    }

    public function put(array $input, array $context): Place
    {
        $input = self::validatedInput($input);
        $account = $context['account'];

        return $account->getConnection()->transaction(function () use ($account, $context, $input) {
            $account = $account->newQuery()->where('uuid', $account->uuid)->lockForUpdate()->firstOrFail();
            $id = data_get($account->meta, 'customer_portal.pickup_address_uuid');
            $place = $id ? $this->query($context)->where('uuid', $id)->first() : null;
            $values = Arr::only($input, [
                'name', 'street1', 'street2', 'city', 'province', 'postal_code', 'neighborhood',
                'district', 'building', 'security_access_code', 'country', 'phone',
            ]);
            $matches = function ($candidate) use ($values, $input) {
                if (!$candidate || !$candidate->location ||
                    abs($candidate->location->getLat() - (float) $input['latitude']) > 0.000001 ||
                    abs($candidate->location->getLng() - (float) $input['longitude']) > 0.000001) {
                    return false;
                }
                foreach ($values as $key => $value) {
                    if ((string) $candidate->$key !== (string) $value) {
                        return false;
                    }
                }
                return true;
            };
            if (!$matches($place)) {
                $place = $this->query($context)->where('street1', $input['street1'])
                    ->where('phone', $input['phone'])->get()->first($matches);
            }
            // Replace the default association, never rewrite an address used by historical orders.
            if (!$place) {
                $place = new Place();
                $place->fill($values);
                $place->company_uuid = session('company');
                $place->owner_uuid = $account->uuid;
                $place->owner_type = Utils::getMutationType($account);
                $place->location = new Point((float) $input['latitude'], (float) $input['longitude']);
                $place->save();
            }
            $meta = (array) $account->meta;
            Arr::set($meta, 'customer_portal.pickup_address_uuid', $place->uuid);
            $account->meta = $meta;
            $account->save();

            return $place;
        });
    }
}
