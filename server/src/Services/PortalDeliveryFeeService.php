<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\CustomerPortal\Support\TunisiaGovernorates;
use Fleetbase\FleetOps\Models\ServiceQuote;

/**
 * Customer delivery fee: one fee per order, chosen by the order's billable parcel volume and
 * how far it travels between Tunisian governorates. Amounts are TND millimes, VAT included.
 * No service fee, COD fee or other line is added to the quote.
 */
class PortalDeliveryFeeService
{
    public const CURRENCY = 'TND';

    public const ZONE_LOCAL = 'local';
    public const ZONE_REGIONAL = 'regional';
    public const ZONE_NATIONAL = 'national';
    public const ZONES = [self::ZONE_LOCAL, self::ZONE_REGIONAL, self::ZONE_NATIONAL];

    /** [size, max billable volume in cm3 (inclusive), [local, regional, national] fee in millimes] */
    public const TIERS = [
        ['S', 15000, [6500, 7500, 8000]],
        ['M', 30000, [7500, 8500, 9000]],
        ['L', 50000, [9000, 10000, 10500]],
        ['XL', 100000, [12500, 14000, 15000]],
    ];

    // Beyond XL, each started 5,000 cm3 (1 kg volumetric) costs 0.800 TND more.
    public const EXTRA_STEP_CM3 = 5000;
    public const EXTRA_STEP_FEE = 800;

    // Volumetric weight: L x W x H (cm) / 5000 = kg, so 1 kg counts as 5,000 cm3.
    public const CM3_PER_KG = 5000;

    /** Assumed volume when a parcel has neither dimensions nor weight. */
    public const PACKAGING_VOLUME_CM3 = [
        'padded_envelope'     => 5000,
        'reinforced_envelope' => 5000,
        'colab_packaging'     => 20000,
        'box'                 => 20000,
    ];

    protected const UNIT_TO_CM = ['mm' => 0.1, 'cm' => 1.0, 'm' => 100.0, 'in' => 2.54, 'ft' => 30.48];
    protected const UNIT_TO_KG = ['g' => 0.001, 'kg' => 1.0, 'lb' => 0.45359237, 'lbs' => 0.45359237, 'oz' => 0.028349523125];

    /** Billable volume: the larger of the measured and the weight-equivalent volume, per parcel line. */
    public function volumeCm3(array $entities): float
    {
        $total = 0.0;
        foreach ($entities as $entity) {
            if (!is_array($entity)) {
                continue;
            }
            $unit = strtolower(trim((string) ($entity['dimensions_unit'] ?? 'cm')));
            $factor = self::UNIT_TO_CM[$unit] ?? 1.0;
            $length = max(0.0, (float) ($entity['length'] ?? 0)) * $factor;
            $width = max(0.0, (float) ($entity['width'] ?? 0)) * $factor;
            $height = max(0.0, (float) ($entity['height'] ?? 0)) * $factor;
            $weightUnit = strtolower(trim((string) ($entity['weight_unit'] ?? 'kg')));
            $weightKg = max(0.0, (float) ($entity['weight'] ?? 0)) * (self::UNIT_TO_KG[$weightUnit] ?? 1.0);
            $volume = max($length * $width * $height, $weightKg * self::CM3_PER_KG);
            if ($volume <= 0) {
                $volume = self::PACKAGING_VOLUME_CM3[data_get($entity, 'meta.parcel.packaging_type')] ?? 0;
            }
            $quantity = max(1, (int) ($entity['quantity'] ?? 1));
            $total += $volume * $quantity;
        }

        return $total;
    }

    public function size(float $volumeCm3): string
    {
        foreach (self::TIERS as [$size, $limit]) {
            if ($volumeCm3 <= $limit) {
                return $size;
            }
        }

        return 'XL+';
    }

    public function feeForVolume(float $volumeCm3, string $zone = self::ZONE_NATIONAL): int
    {
        $column = array_search($zone, self::ZONES, true);
        $column = $column === false ? 2 : $column;
        foreach (self::TIERS as [, $limit, $fees]) {
            if ($volumeCm3 <= $limit) {
                return $fees[$column];
            }
        }
        [, $limit, $fees] = self::TIERS[array_key_last(self::TIERS)];

        return $fees[$column] + (int) ceil(($volumeCm3 - $limit) / self::EXTRA_STEP_CM3) * self::EXTRA_STEP_FEE;
    }

    /** Without route details the order is priced as national, so the fee is never understated. */
    public function feeForEntities(array $entities, array $route = []): int
    {
        return $this->feeForVolume($this->volumeCm3($entities), $this->route($route)['zone']);
    }

    /**
     * The farthest drop decides the zone. Any stop outside a known governorate prices the order as national.
     *
     * @return array{zone: string, origin: ?string, destinations: array<int, ?string>}
     */
    public function route(array $route): array
    {
        $stops = array_values(array_filter([
            $route['pickup'] ?? null,
            ...array_values(array_filter((array) ($route['waypoints'] ?? []))),
            $route['dropoff'] ?? null,
        ], 'is_array'));
        $governorates = array_map(function (array $place) {
            [$latitude, $longitude] = $this->coordinates($place);

            return TunisiaGovernorates::locate($latitude, $longitude, $place['province'] ?? null);
        }, $stops);
        $origin = array_shift($governorates);
        if ($origin === null || $governorates === [] || in_array(null, $governorates, true)) {
            return ['zone' => self::ZONE_NATIONAL, 'origin' => $origin, 'destinations' => $governorates];
        }
        $zone = self::ZONE_LOCAL;
        foreach ($governorates as $destination) {
            $leg = $this->zoneBetween($origin, $destination);
            if (array_search($leg, self::ZONES, true) > array_search($zone, self::ZONES, true)) {
                $zone = $leg;
            }
        }

        return ['zone' => $zone, 'origin' => $origin, 'destinations' => $governorates];
    }

    /** @return array{0: mixed, 1: mixed} [latitude, longitude] */
    protected function coordinates(array $place): array
    {
        if (is_numeric($place['latitude'] ?? null) && is_numeric($place['longitude'] ?? null)) {
            return [$place['latitude'], $place['longitude']];
        }
        $location = $place['location'] ?? null;
        if (is_object($location) && method_exists($location, 'getLat') && method_exists($location, 'getLng')) {
            return [$location->getLat(), $location->getLng()];
        }
        if (is_array($location) && isset($location['coordinates'][0], $location['coordinates'][1])) {
            return [$location['coordinates'][1], $location['coordinates'][0]];
        }

        return [null, null];
    }

    public function zoneBetween(string $from, string $to): string
    {
        if ($from === $to || (in_array($from, TunisiaGovernorates::GRAND_TUNIS, true) && in_array($to, TunisiaGovernorates::GRAND_TUNIS, true))) {
            return self::ZONE_LOCAL;
        }

        return TunisiaGovernorates::region($from) === TunisiaGovernorates::region($to) ? self::ZONE_REGIONAL : self::ZONE_NATIONAL;
    }

    /** Replaces whatever the admin service rate computed with the single delivery fee. */
    public function applyStandardFee(ServiceQuote $quote, array $entities, array $route = []): void
    {
        $volume = $this->volumeCm3($entities);
        $resolved = $this->route($route);
        $amount = $this->feeForVolume($volume, $resolved['zone']);
        $quote->update(['amount' => $amount, 'currency' => self::CURRENCY]);
        $quote->items()->delete();
        $quote->items()->create([
            'amount' => $amount, 'currency' => self::CURRENCY, 'details' => 'Delivery fee', 'code' => 'delivery_fee',
        ]);
        $quote->updateMeta('customer_portal_delivery_fee', [
            'amount' => $amount, 'currency' => self::CURRENCY, 'volume_cm3' => round($volume, 2),
            'size' => $this->size($volume), 'zone' => $resolved['zone'],
            'origin_governorate' => $resolved['origin'], 'destination_governorates' => $resolved['destinations'],
        ]);
    }
}
