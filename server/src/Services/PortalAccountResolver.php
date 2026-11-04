<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Contact;
use Fleetbase\FleetOps\Models\Vendor;
use Illuminate\Support\Facades\DB;

class PortalAccountResolver
{
    public function resolve(bool $useSelection = true, bool $allowSelectionRequired = false): array
    {
        $userUuid = session('user');
        abort_unless($userUuid && session('company'), 403, 'A customer session is required.');
        $contact  = Contact::where(['user_uuid' => $userUuid, 'type' => 'customer', 'company_uuid' => session('company')])->first();
        $vendors  = Vendor::where('company_uuid', session('company'))->where('type', 'customer')->whereHas('vendorPersonnel', function ($query) use ($userUuid) {
            $query->where('status', 'active')->whereHas('contact', function ($contactQuery) use ($userUuid) {
                $contactQuery->where('user_uuid', $userUuid)->where('type', 'customer')->where('company_uuid', session('company'));
            });
        })->get();

        $accounts = collect();
        if ($contact) {
            $accounts->push($this->accountPayload($contact, 'contact'));
        }
        foreach ($vendors as $vendor) {
            $accounts->push($this->accountPayload($vendor, 'vendor'));
        }

        $selected = $useSelection ? request()->header('X-Customer-Account') : null;
        if ($useSelection && !$selected) {
            $selected = DB::connection(config('fleetbase.connection.db', 'mysql'))->table('portal_customer_accounts')
                ->where(['company_uuid' => session('company'), 'user_uuid' => $userUuid])->value('account_uuid');
        }
        $account = $selected ? ($contact?->uuid === $selected ? $contact : $vendors->firstWhere('uuid', $selected)) : ($contact ?: $vendors->first());
        if ($selected && !$account && $allowSelectionRequired) {
            return ['contact' => $contact, 'account' => null, 'accounts' => $accounts->values(), 'selection_required' => true];
        }
        abort_if($selected && !$account, 403, 'The selected customer account is no longer available. Choose another account.');
        $accountType = $account instanceof Vendor ? 'vendor' : 'contact';

        abort_if(!$account, 404, 'No customer account found for user account.');

        $role = $account instanceof Vendor ? PortalAccess::role($account, $contact) : 'individual';
        return [
            'contact'      => $contact,
            'account'      => $account,
            'account_type' => $accountType,
            'accounts'     => $accounts->values(),
            'role' => $role,
            'capabilities' => PortalAccess::capabilities($role),
        ];
    }

    protected function accountPayload($account, string $type): array
    {
        return [
            'id'            => $account->public_id,
            'uuid'          => $account->uuid,
            'name'          => $account->name,
            'customer_type' => $type,
        ];
    }
}
