<?php

namespace Fleetbase\CustomerPortal\Services;

use Fleetbase\FleetOps\Models\Contact;
use Fleetbase\FleetOps\Models\Vendor;
use Fleetbase\FleetOps\Models\VendorPersonnel;
use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class PortalBusinessProfileService
{
    public const GOVERNORATES = [
        'Ariana', 'Beja', 'Ben Arous', 'Bizerte', 'Gabes', 'Gafsa', 'Jendouba', 'Kairouan',
        'Kasserine', 'Kebili', 'Kef', 'Mahdia', 'Manouba', 'Medenine', 'Monastir', 'Nabeul',
        'Sfax', 'Sidi Bouzid', 'Siliana', 'Sousse', 'Tataouine', 'Tozeur', 'Tunis', 'Zaghouan',
    ];

    private function connection(): Connection
    {
        return DB::connection(config('fleetbase.connection.db', 'mysql'));
    }

    private function subject(array $context): Contact|Vendor
    {
        $account = $context['account'] ?? null;
        abort_unless(session('user') && session('company')
            && ($account instanceof Contact || $account instanceof Vendor)
            && $account->type === 'customer'
            && $account->company_uuid === session('company'), 403, 'A customer account in the current organization is required.');

        return $account;
    }

    private function canSubmit(Contact|Vendor $account): bool
    {
        if ($account instanceof Contact) {
            return $account->type === 'customer' && $account->user_uuid === session('user');
        }

        $owner = data_get($account->meta, 'customer_portal.owner_contact_uuid')
            ?? data_get($account->meta, 'converted_from_contact_uuid');
        if (!$owner) {
            return false;
        }

        return VendorPersonnel::where('vendor_uuid', $account->uuid)->where('contact_uuid', $owner)
            ->where('status', 'active')->where('role', 'admin')
            ->whereHas('contact', fn ($query) => $query->where('user_uuid', session('user'))
                ->where('company_uuid', session('company'))->where('type', 'customer'))->exists();
    }

    private function query(Contact|Vendor $account): Builder
    {
        return $this->connection()->table('portal_business_profiles')->where('company_uuid', session('company'))
            ->where(fn ($query) => $query->where('account_uuid', $account->uuid)
                ->when($account instanceof Vendor, fn ($query) => $query->orWhere('activated_vendor_uuid', $account->uuid)));
    }

    public function read(array $context): array
    {
        $account = $this->subject($context);
        $canSubmit = $this->canSubmit($account);
        $row = $this->query($account)->first();

        return $this->payload($row, $account, $canSubmit);
    }

    private function payload(?object $row, Contact|Vendor $account, bool $canSubmit): array
    {
        return [
            'account_uuid' => $account->uuid,
            'account_type' => $account instanceof Vendor ? 'business' : 'individual',
            'status' => $row->status ?? ($account instanceof Vendor ? 'legacy_incomplete' : 'not_submitted'),
            'revision' => $row->revision ?? 0,
            'can_submit' => $canSubmit,
            'profile' => $canSubmit && $row ? json_decode($row->profile, true, 512, JSON_THROW_ON_ERROR) : null,
            'submitted_at' => $row->submitted_at ?? null,
            'review_note' => $canSubmit ? ($row->review_note ?? null) : null,
            'activated_vendor_uuid' => $canSubmit ? ($row->activated_vendor_uuid ?? null) : null,
        ];
    }

    public static function validatedProfile(array $input): array
    {
        $profile = $input['profile'] ?? null;
        if (is_array($profile)) {
            foreach ($profile as $key => $value) {
                if (is_string($value)) $profile[$key] = trim($value);
            }
            if (is_string($profile['tax_id'] ?? null)) {
                $profile['tax_id'] = strtoupper(preg_replace('/[\s\/-]+/', '', $profile['tax_id']));
            }
            if (is_string($profile['phone'] ?? null)) {
                $profile['phone'] = preg_replace('/[\s().-]+/', '', $profile['phone']);
                if (preg_match('/^[2-9][0-9]{7}$/', $profile['phone'])) $profile['phone'] = '+216' . $profile['phone'];
                if (str_starts_with($profile['phone'], '00216')) $profile['phone'] = '+' . substr($profile['phone'], 2);
            }
            $input['profile'] = $profile;
        }

        $fields = [
            'legal_name', 'trade_name', 'legal_form', 'legal_form_other', 'tax_id', 'rne_applicable', 'rne_id',
            'rne_exemption_reason', 'activity', 'representative_name', 'email', 'phone', 'street1', 'city', 'governorate', 'postal_code',
        ];
        $validated = Validator::make($input, [
            'revision' => ['required', 'integer', 'min:0'],
            'declaration' => ['required', 'accepted'],
            'profile' => ['required', 'array:' . implode(',', $fields)],
            'profile.legal_name' => ['required', 'string', 'max:150'],
            'profile.trade_name' => ['nullable', 'string', 'max:150'],
            'profile.legal_form' => ['required', Rule::in(['individual_business', 'suarl', 'sarl', 'sa', 'other'])],
            'profile.legal_form_other' => ['nullable', 'required_if:profile.legal_form,other', 'string', 'max:100'],
            'profile.tax_id' => ['required', 'string', 'regex:/^[0-9]{7}[A-Z]{3}[0-9]{3}$/'],
            'profile.rne_applicable' => ['required', 'boolean'],
            'profile.rne_id' => ['nullable', 'required_if:profile.rne_applicable,true,1', 'string', 'max:50'],
            'profile.rne_exemption_reason' => ['nullable', 'required_if:profile.rne_applicable,false,0', 'string', 'max:500'],
            'profile.activity' => ['required', 'string', 'max:255'],
            'profile.representative_name' => ['required', 'string', 'max:150'],
            'profile.email' => ['required', 'email', 'max:254'],
            'profile.phone' => ['required', 'string', 'regex:/^\+216[2-9][0-9]{7}$/'],
            'profile.street1' => ['required', 'string', 'max:255'],
            'profile.city' => ['required', 'string', 'max:100'],
            'profile.governorate' => ['required', Rule::in(self::GOVERNORATES)],
            'profile.postal_code' => ['required', 'string', 'regex:/^[1-9][0-9]{3}$/'],
        ])->validate();
        $profile = $validated['profile'];
        $profile['country'] = 'TN';
        $profile['rne_applicable'] = (bool) $profile['rne_applicable'];
        $profile['rne_id'] = $profile['rne_applicable'] ? $profile['rne_id'] : null;
        $profile['rne_exemption_reason'] = $profile['rne_applicable'] ? null : $profile['rne_exemption_reason'];
        $profile['legal_form_other'] = $profile['legal_form'] === 'other' ? $profile['legal_form_other'] : null;
        $profile['trade_name'] = $profile['trade_name'] ?? null;

        return ['revision' => (int) $validated['revision'], 'profile' => $profile];
    }

    public function submit(array $context, array $input): array
    {
        $account = $this->subject($context);
        abort_unless($this->canSubmit($account), 403, 'Only the account owner can submit business information. Contact support if ownership has not been established.');
        $input = self::validatedProfile($input);

        return $this->connection()->transaction(function () use ($account, $input) {
            $locked = $account->newQuery()->where('company_uuid', session('company'))->where('uuid', $account->uuid)->lockForUpdate()->firstOrFail();
            abort_unless($this->canSubmit($locked), 403, 'Account access changed. Refresh before submitting business information.');
            $query = $this->query($locked);
            $row = $query->lockForUpdate()->first();
            abort_if($row && !in_array($row->status, ['pending_review', 'changes_requested'], true), 409, 'This business profile cannot be changed through an application.');
            if ($row && $row->status === 'pending_review'
                && json_decode($row->profile, true, 512, JSON_THROW_ON_ERROR) == $input['profile']) {
                return $this->payload($row, $locked, true);
            }
            abort_unless(($row->revision ?? 0) === $input['revision'], 409, 'Business information changed. Refresh before submitting again.');
            $revision = ($row->revision ?? 0) + 1;
            $history = $row ? json_decode($row->history, true, 512, JSON_THROW_ON_ERROR) : [];
            $history[] = ['revision' => $revision, 'actor_uuid' => session('user'), 'action' => 'submitted', 'at' => now()->toISOString()];
            $values = [
                'profile' => json_encode($input['profile'], JSON_THROW_ON_ERROR),
                'history' => json_encode($history, JSON_THROW_ON_ERROR),
                'revision' => $revision, 'status' => 'pending_review', 'submitted_by_uuid' => session('user'),
                'submitted_at' => now(), 'updated_at' => now(),
            ];
            if ($row) {
                $query->update($values);
            } else {
                $this->connection()->table('portal_business_profiles')->insert($values + [
                    'uuid' => (string) Str::uuid(), 'company_uuid' => session('company'), 'account_uuid' => $locked->uuid,
                    'account_type' => $locked instanceof Vendor ? 'vendor' : 'contact', 'created_at' => now(),
                ]);
            }

            return $this->payload($this->query($locked)->first(), $locked, true);
        }, 3);
    }
}
