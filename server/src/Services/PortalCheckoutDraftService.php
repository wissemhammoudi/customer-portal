<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Order;
use Fleetbase\FleetOps\Support\DeliveryOptions;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;

class PortalCheckoutDraftService
{
    public function query(array $context)
    {
        return (new Order())->getConnection()->table('portal_checkout_drafts')
            ->where('company_uuid', session('company'))
            ->where('account_uuid', $context['account']->uuid)
            ->where('user_uuid', session('user'));
    }

    public function find(string $id, array $context, bool $lock = false): object
    {
        $query = $this->query($context)->where('uuid', $id);
        $draft = ($lock ? $query->lockForUpdate() : $query)->first();
        abort_if(!$draft, 404, 'The checkout draft is not available for this account.');
        abort_if(now()->greaterThanOrEqualTo($draft->expires_at), 410, 'The checkout draft expired. Start a new delivery.');

        return $draft;
    }

    public function save(array $input, array $context, ?string $id = null): object
    {
        $input = Arr::only($input, ['order_config', 'type', 'pickup', 'dropoff', 'return', 'waypoints', 'entities',
            'cod_amount', 'cod_currency', 'cod_payment_method', 'scheduled_at', 'notes', 'internal_id', 'meta',
            'pod_required', 'pod_method', 'files', 'service_quote_uuid', 'return_addresses_confirmed']);
        DeliveryOptions::validateInput($input);
        $json = json_encode($input, JSON_THROW_ON_ERROR);
        abort_if(strlen($json) > 262144, 422, 'The checkout draft is too large.');

        return (new Order())->getConnection()->transaction(function () use ($input, $json, $context, $id) {
            if ($id) {
                $draft = $this->find($id, $context, true);
                abort_if($draft->order_uuid, 409, 'This checkout draft already created an order.');
                $this->query($context)->where('uuid', $id)->update(['input' => $json, 'updated_at' => now()]);
            } else {
                $id = (string) Str::uuid();
                $this->query($context)->insert([
                    'uuid' => $id, 'company_uuid' => session('company'), 'account_uuid' => $context['account']->uuid,
                    'user_uuid' => session('user'), 'input' => $json, 'order_uuid' => null,
                    'expires_at' => now()->addDay(), 'created_at' => now(), 'updated_at' => now(),
                ]);
            }

            return $this->find($id, $context);
        });
    }

    public function response(object $draft): array
    {
        return ['uuid' => $draft->uuid, 'input' => json_decode($draft->input, true, 512, JSON_THROW_ON_ERROR),
            'order_uuid' => $draft->order_uuid, 'expires_at' => $draft->expires_at];
    }
}
