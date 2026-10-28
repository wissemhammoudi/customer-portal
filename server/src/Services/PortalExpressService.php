<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\ServiceQuote;

class PortalExpressService
{
    // Express costs 1.5x the standard delivery fee, rounded half up to 0.5 TND.
    public const MULTIPLIER = '1.5';
    public const ROUNDING = 500;
    public const CURRENCY = 'TND';

    public function expressAmount(int $base, string $currency): int
    {
        abort_if($currency !== self::CURRENCY, 422, 'Express delivery is only priced in TND. Select a TND delivery rate.');
        abort_if($base < 1 || $base > intdiv(PHP_INT_MAX - 1000, 3), 422, 'A valid delivery fee is required for Express.');

        return intdiv($base * 3 + self::ROUNDING, 2 * self::ROUNDING) * self::ROUNDING;
    }

    public function applyPrice(ServiceQuote $quote): void
    {
        abort_if(data_get($quote->meta, 'customer_portal_express_price') !== null, 422, 'Get a fresh Express quote.');
        $base = (int) $quote->amount;
        $amount = $this->expressAmount($base, (string) $quote->currency);
        $quote->update(['amount' => $amount]);
        $quote->items()->delete();
        $quote->items()->create([
            'amount' => $amount, 'currency' => self::CURRENCY, 'details' => 'Express delivery fee', 'code' => 'delivery_fee',
        ]);
        $quote->updateMeta('customer_portal_express_price', [
            'base_amount' => $base, 'amount' => $amount, 'multiplier' => self::MULTIPLIER, 'currency' => self::CURRENCY,
        ]);
    }

    public function assertQuotePrice(ServiceQuote $quote, string $serviceLevel): void
    {
        $price = data_get($quote->meta, 'customer_portal_express_price');
        if ($serviceLevel !== 'express') {
            abort_if($price !== null, 422, 'This is an Express quote. Get a fresh Standard quote.');
            return;
        }
        abort_unless(is_array($price), 422, 'Get a current Express delivery quote.');
        $amount = $this->expressAmount((int) ($price['base_amount'] ?? 0), (string) ($price['currency'] ?? ''));
        abort_if(($price['multiplier'] ?? null) !== self::MULTIPLIER || ($price['amount'] ?? null) !== $amount,
            422, 'The Express fee changed. Get a new quote.');
        if (data_get($quote->meta, 'customer_portal_return_price') !== null) {
            abort_if((int) data_get($quote->meta, 'customer_portal_return_price.base_amount') !== $amount,
                422, 'The Express return quote is inconsistent. Get a new quote.');
            $amount = (new PortalReturnService())->discountedAmount($amount);
        }
        $quote->loadMissing('items');
        abort_if((int) $quote->amount !== $amount || $quote->currency !== self::CURRENCY
            || (int) $quote->items->sum('amount') !== $amount
            || $quote->items->contains(fn ($item) => $item->currency !== self::CURRENCY),
            422, 'The Express quote price is inconsistent. Get a new quote.');
    }
}
