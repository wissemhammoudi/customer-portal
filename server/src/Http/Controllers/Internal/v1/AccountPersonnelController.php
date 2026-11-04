<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\CustomerPortal\Services\PortalAccess;
use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\FleetOps\Models\Vendor;
use Fleetbase\FleetOps\Models\VendorPersonnel;
use Fleetbase\Http\Controllers\Controller;
use Illuminate\Http\Request;

class AccountPersonnelController extends Controller
{
    public function __construct(protected PortalAccountResolver $accountResolver)
    {
    }

    public function index()
    {
        $vendor = $this->resolveVendorAccount();
        return response()->json(['personnels' => VendorPersonnel::where('vendor_uuid', $vendor->uuid)->with('contact')->latest()->get()
            ->map(fn ($member) => ['uuid' => $member->contact_uuid, 'name' => $member->contact?->name, 'email' => $member->contact?->email,
                'role' => $member->role, 'status' => $member->status])->values()]);
    }

    public function candidates()
    {
        abort(410, 'Customer discovery has been removed. Invite an employee by email instead.');
    }

    public function store(Request $request)
    {
        abort(409, 'Direct member creation has been replaced by owner invitations.');
    }

    public function destroy(string $contactId)
    {
        $vendor = $this->resolveVendorAccount();
        return $vendor->getConnection()->transaction(function () use ($vendor, $contactId) {
            Vendor::where('uuid', $vendor->uuid)->lockForUpdate()->firstOrFail();
            $member = VendorPersonnel::where('vendor_uuid', $vendor->uuid)
                ->whereHas('contact', fn ($query) => $query->where('company_uuid', session('company'))
                    ->where(fn ($query) => $query->where('uuid', $contactId)->orWhere('public_id', $contactId)))
                ->lockForUpdate()->firstOrFail();
            abort_if(PortalAccess::owner($vendor) === $member->contact_uuid, 422, 'The company owner cannot be removed.');
            $member->delete();
            PortalAccess::audit($vendor->uuid, 'team.removed', ['contact_uuid' => $member->contact_uuid]);
            return response()->json(['status' => 'ok']);
        });
    }

    protected function resolveVendorAccount(): Vendor
    {
        $context = $this->accountResolver->resolve();
        PortalAccess::authorize($context, 'members');
        abort_unless($context['account'] instanceof Vendor, 403, 'A company customer account is required to manage personnel.');
        return $context['account'];
    }
}
