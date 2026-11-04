<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Contact;
use Fleetbase\FleetOps\Models\Vendor;
use Illuminate\Http\Request;

class PortalCustomerConversionService
{
    public function __construct(
        protected PortalOrderService $orderService,
        protected PortalSupportService $supportService,
    ) {
    }

    public function convertContactToVendor(Contact $contact, Request $request): Vendor
    {
        abort(409, 'Instant company conversion has been replaced by business verification. Update the app and submit your business information from Account or Members. Your existing orders and billing have not been moved.');
    }
}
