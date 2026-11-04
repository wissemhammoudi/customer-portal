<?php

namespace Fleetbase\CustomerPortal\Http\Resources;

use Fleetbase\FleetOps\Models\Vendor;

class Order extends \Fleetbase\FleetOps\Http\Resources\v1\Order
{
    protected function transformOrderCustomerResource($model)
    {
        if ($model instanceof Vendor) {
            return ['id' => $model->public_id, 'uuid' => $model->uuid, 'public_id' => $model->public_id,
                'name' => $model->name, 'email' => $model->email, 'phone' => $model->phone];
        }

        return parent::transformOrderCustomerResource($model);
    }
}
