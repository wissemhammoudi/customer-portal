<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\ServiceQuote;

class PortalExpressService
{
    public const SURCHARGE = 4000;
    public const CURRENCY = 'TND';

    public function addSurcharge(int $amount, string $currency): int
    {
        abort_if($currency !== self::CURRENCY, 422, 'Express delivery is only priced in TND. Select a TND delivery rate.');
        abort_if($amount < 1 || $amount > PHP_INT_MAX - self::SURCHARGE, 422, 'A valid delivery fee is required for Express.');

        return $amount + self::SURCHARGE;
    }

    public function applyPrice(ServiceQuote $quote): void
    {
        abort_if(data_get($quote->meta, 'customer_portal_express_price') !== null, 422, 'Get a fresh Express quote.');
        $base = (int) $quote->amount;
        $amount = $this->addSurcharge($base, $quote->currency);
        $quote->update(['amount' => $amount]);
        $quote->items()->create([
            'amount' => self::SURCHARGE, 'currency' => self::CURRENCY,
            'details' => 'Express delivery surcharge', 'code' => 'express_surcharge',
        ]);
        $quote->updateMeta('customer_portal_express_price', [
            'base_amount' => $base, 'amount' => $amount, 'surcharge' => self::SURCHARGE, 'currency' => self::CURRENCY,
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
        $amount = $this->addSurcharge((int) ($price['base_amount'] ?? 0), (string) ($price['currency'] ?? ''));
        abort_if(($price['surcharge'] ?? null) !== self::SURCHARGE || ($price['amount'] ?? null) !== $amount,
            422, 'The Express surcharge changed. Get a new quote.');
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
