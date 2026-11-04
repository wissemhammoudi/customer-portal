<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Contact;
use Fleetbase\FleetOps\Models\Vendor;
use Fleetbase\FleetOps\Models\VendorPersonnel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class PortalAccess
{
    public const ROLES = ['operations', 'operator', 'accountant', 'viewer'];

    public static function owner(Vendor $vendor): ?string
    {
        return data_get($vendor->meta, 'customer_portal.owner_contact_uuid')
            ?? data_get($vendor->meta, 'converted_from_contact_uuid');
    }

    public static function role(Vendor $vendor, ?Contact $contact): string
    {
        abort_unless($contact && $contact->company_uuid === $vendor->company_uuid, 403, 'Company membership is required.');
        $member = VendorPersonnel::where('vendor_uuid', $vendor->uuid)->where('contact_uuid', $contact->uuid)
            ->where('status', 'active')->first();
        abort_unless($member, 403, 'Company access has been suspended or removed.');
        if (self::owner($vendor) === $contact->uuid && $member->role === 'admin') return 'owner';

        return match ($member->role) {
            'admin' => 'operations',
            'member' => 'operator',
            'operations', 'operator', 'accountant', 'viewer' => $member->role,
            default => 'restricted',
        };
    }

    public static function capabilities(string $role): array
    {
        return [
            'orders_read' => in_array($role, ['individual', 'owner', 'operations', 'operator', 'accountant', 'viewer'], true),
            'orders_write' => in_array($role, ['individual', 'owner', 'operations', 'operator'], true),
            'orders_all' => in_array($role, ['individual', 'owner', 'operations', 'accountant', 'viewer'], true),
            'finance' => in_array($role, ['individual', 'owner', 'accountant'], true),
            'finance_write' => in_array($role, ['individual', 'owner'], true),
            'support' => in_array($role, ['individual', 'owner', 'operations', 'operator'], true),
            'resources_write' => in_array($role, ['individual', 'owner', 'operations'], true),
            'members' => $role === 'owner',
            'business' => in_array($role, ['individual', 'owner'], true),
        ];
    }

    public static function authorize(array $context, string $ability): void
    {
        abort_unless(($context['capabilities'] ?? self::capabilities($context['account'] instanceof Vendor ? 'restricted' : 'individual'))[$ability] ?? false,
            403, 'Your company role does not allow this action.');
    }

    public static function audit(string $account, string $action, array $details = []): void
    {
        DB::connection(config('fleetbase.connection.db', 'mysql'))->table('portal_business_audit')->insert([
            'uuid' => (string) Str::uuid(), 'company_uuid' => session('company'), 'account_uuid' => $account,
            'actor_uuid' => session('user'), 'action' => $action, 'details' => json_encode($details, JSON_THROW_ON_ERROR), 'created_at' => now(),
        ]);
    }
}
