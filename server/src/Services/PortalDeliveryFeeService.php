<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\ServiceQuote;

/**
 * Customer delivery fee: a single flat fee per order, chosen by the total parcel volume.
 * Amounts are TND millimes. No service fee, VAT or other line is added to the quote.
 */
class PortalDeliveryFeeService
{
    public const CURRENCY = 'TND';

    /** [max volume in cm3 (inclusive), fee in millimes] */
    public const TIERS = [
        [30000, 8000],
        [60000, 10000],
        [120000, 15000],
    ];
    public const LARGEST_FEE = 20000;

    protected const UNIT_TO_CM = ['mm' => 0.1, 'cm' => 1.0, 'm' => 100.0, 'in' => 2.54, 'ft' => 30.48];

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
            $quantity = max(1, (int) ($entity['quantity'] ?? 1));
            $total += $length * $width * $height * $quantity;
        }

        return $total;
    }

    public function feeForVolume(float $volumeCm3): int
    {
        foreach (self::TIERS as [$limit, $fee]) {
            if ($volumeCm3 <= $limit) {
                return $fee;
            }
        }

        return self::LARGEST_FEE;
    }

    public function feeForEntities(array $entities): int
    {
        return $this->feeForVolume($this->volumeCm3($entities));
    }

    /** Replaces whatever the admin service rate computed with the single flat delivery fee. */
    public function applyStandardFee(ServiceQuote $quote, array $entities): void
    {
        $volume = $this->volumeCm3($entities);
        $amount = $this->feeForVolume($volume);
        $quote->update(['amount' => $amount, 'currency' => self::CURRENCY]);
        $quote->items()->delete();
        $quote->items()->create([
            'amount' => $amount, 'currency' => self::CURRENCY, 'details' => 'Delivery fee', 'code' => 'delivery_fee',
        ]);
        $quote->updateMeta('customer_portal_delivery_fee', [
            'amount' => $amount, 'currency' => self::CURRENCY, 'volume_cm3' => round($volume, 2),
        ]);
    }
}
