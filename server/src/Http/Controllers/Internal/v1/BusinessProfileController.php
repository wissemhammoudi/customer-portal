<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\CustomerPortal\Services\PortalAccountResolver;
use Fleetbase\CustomerPortal\Services\PortalBusinessProfileService;
use Fleetbase\Http\Controllers\Controller;
use Fleetbase\Models\User;
use Illuminate\Http\Request;

class BusinessProfileController extends Controller
{
    public function __construct(protected PortalAccountResolver $accounts, protected PortalBusinessProfileService $profiles)
    {
    }

    private function context(Request $request): array
    {
        $user = $request->user();
        abort_unless($user instanceof User && $user->type === 'customer'
            && $user->uuid === session('user') && $user->company_uuid === session('company'), 403, 'A customer session in the current organization is required.');

        return $this->accounts->resolve();
    }

    public function index(Request $request)
    {
        return response()->json(['business_profile' => $this->profiles->read($this->context($request))]);
    }

    public function store(Request $request)
    {
        return response()->json(['business_profile' => $this->profiles->submit($this->context($request), $request->all())]);
    }
}
