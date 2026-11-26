<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\CustomerPortal\Services\PortalOrderService;
use Fleetbase\FleetOps\Support\OrderChatChannel;
use Fleetbase\Http\Controllers\Controller;
use Illuminate\Http\Request;

class OrderChatController extends Controller
{
    public function __construct(
        protected PortalAccountResolver $accountResolver,
        protected PortalOrderService $orderService
    ) {
    }

    public function show(string $id)
    {
        $context = $this->accountResolver->resolve();
        $order   = $this->orderService->resolveOrder($id, $context);

        if (!OrderChatChannel::isActiveForOrder($order)) {
            return response()->json([
                'active'       => false,
                'channel'      => null,
                'participants' => [],
                'messages'     => [],
            ]);
        }

        $channel = OrderChatChannel::ensureForOrder($order, null, null, (string) session('user'));

        return response()->json(OrderChatChannel::serializeChannel($channel, $order, (string) session('user')));
    }

    public function sendMessage(string $id, Request $request)
    {
        $context = $this->accountResolver->resolve();
        $order   = $this->orderService->resolveOrder($id, $context);

        abort_unless(OrderChatChannel::isActiveForOrder($order), 409, 'Messaging opens once a pickup or delivery is underway.');

        $result = OrderChatChannel::sendMessage($order, (string) session('user'), $request);

        return response()->json(['message' => $result['message']] + $result['payload']);
    }
}
