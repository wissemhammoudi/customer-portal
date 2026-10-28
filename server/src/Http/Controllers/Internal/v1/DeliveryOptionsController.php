<?php

namespace Fleetbase\CustomerPortal\Http\Controllers\Internal\v1;

use Fleetbase\FleetOps\Support\DeliveryOptions;
use Fleetbase\Http\Controllers\Controller;

class DeliveryOptionsController extends Controller
{
    public function index()
    {
        $catalogue = DeliveryOptions::catalogue();
        $catalogue['purposes'] = [
            ['value' => 'transportation', 'label' => 'Transportation'],
            ['value' => 'return', 'label' => 'Return'],
        ];
        $catalogue['service_levels'] = [
            ['value' => 'standard', 'label' => 'Standard', 'available' => true],
            ['value' => 'express', 'label' => 'Express', 'available' => true,
                'description' => 'Priority handling at 1.5x the standard delivery fee, before any return discount.'],
        ];

        return response()->json($catalogue);
    }
}
