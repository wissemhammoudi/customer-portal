<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Order;
use Fleetbase\FleetOps\Models\Place;
use Fleetbase\FleetOps\Models\ServiceQuote;
use Illuminate\Validation\ValidationException;

class PortalReturnService
{
    public const CANCELLED_STATUSES = ['cancelled', 'canceled', 'order_canceled', 'order_cancelled'];
    public const DISCOUNT_PERCENT = 40;
    // Customer pays 60% of the delivery fee; expressed in tenths (x6 / 10) for integer maths.
    public const PAYABLE_PERCENT = 60;

    public function assertEligible(Order $original): void
    {
        if (in_array(strtolower((string) $original->status), self::CANCELLED_STATUSES, true)) {
            throw ValidationException::withMessages(['meta.delivery.original_order_uuid' => 'A cancelled delivery cannot be returned.']);
        }
        $original->loadMissing(['payload.pickup', 'payload.dropoff', 'payload.waypointMarkers']);
        if (!$original->payload?->pickup || !$original->payload?->dropoff || $original->payload->waypointMarkers->isNotEmpty()) {
            throw ValidationException::withMessages(['meta.delivery.original_order_uuid' => 'The original delivery must have one pickup and one dropoff.']);
        }
    }

    public function assertReversedRoute(Order $original, ?Place $pickup, ?Place $dropoff): void
    {
        $this->assertEligible($original);
        $this->assertSameEndpoint($pickup, $original->payload->dropoff, 'pickup');
        $this->assertSameEndpoint($dropoff, $original->payload->pickup, 'dropoff');
    }

    public function assertSameEndpoint(?Place $selected, Place $expected, string $field): void
    {
        if (!$selected || !$selected->location || !$expected->location
            || trim((string) $selected->street1) !== trim((string) $expected->street1)
            || trim((string) $selected->phone) !== trim((string) $expected->phone)
            || abs($selected->location->getLat() - $expected->location->getLat()) > 0.000001
            || abs($selected->location->getLng() - $expected->location->getLng()) > 0.000001) {
            throw ValidationException::withMessages([$field => 'The return route changed. Reload the current delivery addresses and request a new quote.']);
        }
    }

    public function originalPrice(Order $original, string $serviceLevel = 'standard'): array
    {
        $original->loadMissing(['purchaseRate.serviceQuote', 'transaction']);
        $quote = $original->purchaseRate?->serviceQuote;
        $amount = $original->transaction?->amount
            ?? data_get($original->purchaseRate?->meta, 'locked_price')
            ?? $quote?->amount;
        $currency = $original->transaction?->currency ?? $quote?->currency;
        $this->discountedAmount($amount);
        if (!is_string($currency) || !preg_match('/^[A-Z]{3}$/', $currency)) {
            throw ValidationException::withMessages(['meta.delivery.original_order_uuid' => 'The original delivery has no valid delivery fee currency. Contact support.']);
        }

        $amount = (int) $amount;
        $standardAmount = $amount;
        if (data_get($original->meta, 'delivery.service_level') === 'express') {
            abort_unless($quote, 422, 'The original Express delivery has no verifiable quote. Contact support.');
            (new PortalExpressService())->assertQuotePrice($quote, 'express');
            // Back out the Express multiplier: the verified standard base is stored with the quote.
            $standardAmount = (int) data_get($quote->meta, 'customer_portal_express_price.base_amount');
            if (data_get($quote->meta, 'customer_portal_return_price') !== null) {
                $standardAmount = $this->discountedAmount($standardAmount);
            }
            $this->discountedAmount($standardAmount);
        }
        $amount = $standardAmount;
        if ($serviceLevel === 'express') {
            $amount = (new PortalExpressService())->expressAmount($standardAmount, $currency);
        }

        return ['amount' => $amount, 'standard_amount' => $standardAmount, 'currency' => $currency,
            'service_rate_uuid' => $quote?->service_rate_uuid, 'service_level' => $serviceLevel];
    }

    public function discountedAmount($amount): int
    {
        // Integer minor units, rounded half up, without floating-point multiplication.
        if ((!is_int($amount) && !(is_string($amount) && ctype_digit($amount))) || $amount <= 0 || $amount > intdiv(PHP_INT_MAX - 5, self::PAYABLE_PERCENT / 10)) {
            throw ValidationException::withMessages(['return_price' => 'A positive delivery fee in integer minor units is required to price this return. Contact support if the original price is missing or zero.']);
        }

        return intdiv((int) $amount * (self::PAYABLE_PERCENT / 10) + 5, 10);
    }

    public function applyPrice(ServiceQuote $quote, array $price): void
    {
        $amount = $this->discountedAmount($price['amount']);
        abort_if($amount < 1 || $amount >= (int) $price['amount'], 422, 'The original fee is too small to apply the ' . self::DISCOUNT_PERCENT . '% return discount in minor units.');
        $quote->update(['amount' => $amount, 'currency' => $price['currency']]);
        $quote->items()->delete();
        $quote->items()->create([
            'amount' => $amount, 'currency' => $price['currency'],
            'details' => 'Return delivery (' . self::DISCOUNT_PERCENT . '% discount)', 'code' => 'return_delivery_fee',
        ]);
        $quote->updateMeta('customer_portal_return_price', [
            'base_amount' => (int) $price['amount'], 'amount' => $amount, 'currency' => $price['currency'],
            'original_order_uuid' => $price['original_order_uuid'] ?? null,
            'service_level' => $price['service_level'] ?? 'standard',
        ]);
    }

    public function assertQuotePrice(ServiceQuote $quote, ?Order $original): void
    {
        $price = data_get($quote->meta, 'customer_portal_return_price');
        abort_if(!is_array($price), 422, 'Get a current return delivery quote.');
        if ($original) {
            $current = $this->originalPrice($original, $price['service_level'] ?? 'standard');
            abort_if(($price['original_order_uuid'] ?? null) !== $original->uuid
                || (int) ($price['base_amount'] ?? 0) !== $current['amount']
                || ($price['currency'] ?? null) !== $current['currency'], 422, 'The original delivery fee changed. Get a new return quote.');
        } else {
            abort_if(!empty($price['original_order_uuid']), 422, 'This quote belongs to a linked return.');
        }
        $amount = $this->discountedAmount($price['base_amount'] ?? null);
        $quote->loadMissing('items');
        abort_if((int) $quote->amount !== $amount || $quote->currency !== ($price['currency'] ?? null)
            || $quote->items->count() !== 1 || (int) $quote->items->sum('amount') !== $amount
            || $quote->items->first()->currency !== $quote->currency, 422, 'The return quote price is inconsistent. Get a new quote.');
    }
}
