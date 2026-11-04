<?php

namespace Fleetbase\CustomerPortal\Http\Middleware;

use Fleetbase\CustomerPortal\Services\PortalAccess;
use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\Models\User;
use Illuminate\Http\Request;

class PortalAccessGuard
{
    public function handle(Request $request, \Closure $next)
    {
        if (!str_contains($request->path(), 'customer-portal/int/v1/')) return $next($request);
        $path = preg_replace('#^.*customer-portal/int/v1/(mobile/)?#', '', $request->path());
        if (str_starts_with($path, 'settings/')) return $next($request);
        $user = $request->user();
        abort_unless($user instanceof User && $user->type === 'customer' && $user->uuid === session('user')
            && $user->company_uuid === session('company'), 403, 'A customer session is required.');
        if (in_array($path, ['account', 'account/choices', 'account/select', 'account/invitations'], true)
            || preg_match('#^account/invitations/[^/]+/accept$#', $path)) return $next($request);
        $context = app(PortalAccountResolver::class)->resolve();
        $write = !$request->isMethod('GET') && !$request->isMethod('HEAD');
        $ability = match (true) {
            str_starts_with($path, 'account/personnel'), str_starts_with($path, 'account/team') => 'members',
            str_starts_with($path, 'account/business') => 'business',
            str_starts_with($path, 'wallet'), str_starts_with($path, 'invoices') => $write ? 'finance_write' : 'finance',
            str_starts_with($path, 'issues') => 'support',
            $path === 'pending-actions' => 'orders_read',
            str_starts_with($path, 'account/pickup-address') => $write ? 'resources_write' : 'orders_read',
            str_starts_with($path, 'notification-preferences') => $write ? 'business' : null,
            str_starts_with($path, 'account/change-password'), str_starts_with($path, 'notifications'),
            str_starts_with($path, 'devices') => null,
            str_starts_with($path, 'orders'), str_starts_with($path, 'checkout-drafts') => $write ? 'orders_write' : 'orders_read',
            str_starts_with($path, 'service-quotes'), str_starts_with($path, 'payments') => 'orders_write',
            str_starts_with($path, 'places'), str_starts_with($path, 'saved-parcels') => $write ? 'resources_write' : 'orders_read',
            in_array($path, ['documents', 'address-book', 'order-configs', 'delivery-options'], true) => 'orders_read',
            default => 'business',
        };
        if ($ability) PortalAccess::authorize($context, $ability);

        return $next($request);
    }
}
