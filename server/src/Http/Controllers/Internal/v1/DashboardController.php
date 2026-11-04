<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\CustomerPortal\Services\PortalBillingService;
use Fleetbase\CustomerPortal\Services\PortalCheckoutDraftService;
use Fleetbase\CustomerPortal\Services\PortalOrderService;
use Fleetbase\CustomerPortal\Services\PortalPickupAddressService;
use Fleetbase\CustomerPortal\Services\PortalSupportService;
use Fleetbase\Http\Controllers\Controller;

class DashboardController extends Controller
{
    public function __construct(
        protected PortalAccountResolver $accountResolver,
        protected PortalBillingService $billingService,
        protected PortalSupportService $supportService,
        protected PortalOrderService $orderService,
    ) {
    }

    public function pendingActions()
    {
        $context = $this->accountResolver->resolve();
        $actions = [];

        $billing        = ($context['capabilities']['finance'] ?? true) ? $this->billingService->summary() : [];
        $unpaidInvoices = (int) data_get($billing, 'unpaid', 0);
        if ($unpaidInvoices > 0) {
            $actions[] = [
                'title'       => $unpaidInvoices . ' unpaid ' . ($unpaidInvoices === 1 ? 'invoice' : 'invoices'),
                'description' => 'Review outstanding billing for this account.',
                'icon'        => 'file-invoice-dollar',
                'type'        => 'billing',
                'route'       => 'portal.billing',
            ];
        }

        $openIssues = ($context['capabilities']['support'] ?? true) ? $this->supportService->queryForAccount($context)->whereNotIn('status', ['resolved', 'closed'])->count() : 0;
        if ($openIssues > 0) {
            $actions[] = [
                'title'       => $openIssues . ' open support ' . ($openIssues === 1 ? 'ticket' : 'tickets'),
                'description' => 'Support is reviewing your open requests.',
                'icon'        => 'headset',
                'type'        => 'support',
                'route'       => 'portal.support',
            ];
        }

        $pickup = (new PortalPickupAddressService())->get($context);
        if (!$pickup || !trim((string) ($pickup->street1 ?? '')) || !trim((string) ($pickup->phone ?? '')) || !$pickup->location) {
            $actions[] = [
                'title'       => 'Set up your pickup address',
                'description' => 'Drivers need a pickup address before you can create deliveries.',
                'icon'        => 'location-dot',
                'type'        => 'pickup_address',
                'route'       => 'portal.settings.account',
            ];
        }

        $drafts = (new PortalCheckoutDraftService())->query($context)->whereNull('order_uuid')->where('expires_at', '>', now())->count();
        if ($drafts > 0) {
            $actions[] = [
                'title'       => 'Resume a saved checkout',
                'description' => $drafts . ' saved ' . ($drafts === 1 ? 'checkout is' : 'checkouts are') . ' waiting to be completed.',
                'icon'        => 'cart-shopping',
                'type'        => 'checkout_draft',
                'route'       => 'portal.orders.new',
            ];
        }

        $orders = $this->orderService->queryForAccount($context)
            ->whereNotIn('status', ['completed', 'done', 'canceled', 'cancelled', 'delivered'])
            ->latest()
            ->limit(100)
            ->get();
        $attention = $orders->filter(fn ($order) => in_array(data_get($order->meta, 'collection_workflow.state'), self::ATTENTION_STATES, true))->take(3);
        foreach ($attention as $order) {
            $state     = data_get($order->meta, 'collection_workflow.state');
            $actions[] = [
                'title'       => ($state === 'awaiting_preparation' ? 'Prepare order ' : 'Review order ') . $order->public_id,
                'description' => self::ATTENTION_STATES_DESCRIPTION[$state],
                'icon'        => $state === 'awaiting_preparation' ? 'box-open' : 'triangle-exclamation',
                'type'        => 'order',
                'state'       => $state,
                'route'       => 'portal.orders.details',
                'model'       => $order->public_id,
            ];
        }

        return response()->json(['actions' => $actions]);
    }

    private const ATTENTION_STATES = ['awaiting_preparation', 'pickup_exception', 'depot_hold'];

    private const ATTENTION_STATES_DESCRIPTION = [
        'awaiting_preparation' => 'Prepare your parcels, then confirm they are ready.',
        'pickup_exception'     => 'Pickup needs your attention. Open the order for the next step.',
        'depot_hold'           => 'The parcel is held at the depot. Contact support if you need help.',
    ];
}
