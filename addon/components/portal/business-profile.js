import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { restartableTask, dropTask } from 'ember-concurrency';

const NAMESPACE = 'customer-portal/int/v1';
const FIELDS = [
    'legal_name',
    'trade_name',
    'legal_form_other',
    'tax_id',
    'rne_id',
    'rne_exemption_reason',
    'activity',
    'representative_name',
    'email',
    'phone',
    'street1',
    'city',
    'postal_code',
];

export default class PortalBusinessProfileComponent extends Component {
    @service fetch;
    @service customerSession;
    @service notifications;
    @service intl;
    @tracked data;
    @tracked error;
    @tracked draft = {};
    @tracked declaration = false;
    @tracked reviewing = false;

    legalForms = ['individual_business', 'suarl', 'sarl', 'sa', 'other'];
    governorates = [
        'Ariana',
        'Beja',
        'Ben Arous',
        'Bizerte',
        'Gabes',
        'Gafsa',
        'Jendouba',
        'Kairouan',
        'Kasserine',
        'Kebili',
        'Kef',
        'Mahdia',
        'Manouba',
        'Medenine',
        'Monastir',
        'Nabeul',
        'Sfax',
        'Sidi Bouzid',
        'Siliana',
        'Sousse',
        'Tataouine',
        'Tozeur',
        'Tunis',
        'Zaghouan',
    ];

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    get fields() {
        return FIELDS.filter((name) => {
            if (name === 'legal_form_other') return this.draft.legal_form === 'other';
            if (name === 'rne_id') return this.draft.rne_applicable;
            if (name === 'rne_exemption_reason') return !this.draft.rne_applicable;
            return true;
        }).map((name) => ({
            name,
            label: `customer-business.fields.${name}`,
            value: this.draft[name] ?? '',
            type: name === 'email' ? 'email' : name === 'phone' ? 'tel' : 'text',
            required: name !== 'trade_name',
        }));
    }

    get formOptions() {
        return this.legalForms.map((value) => ({ value, label: `customer-business.forms.${value}` }));
    }

    get statusKey() {
        return `customer-business.status.${this.data?.status ?? 'not_submitted'}`;
    }

    get busy() {
        return this.load.isRunning || this.save.isRunning;
    }

    get editable() {
        return this.data?.can_submit && ['not_submitted', 'legacy_incomplete', 'pending_review', 'changes_requested'].includes(this.data.status);
    }

    accept(result) {
        const data = result.business_profile;
        if (
            !data ||
            !data.account_uuid ||
            !Number.isInteger(data.revision) ||
            typeof data.can_submit !== 'boolean' ||
            !['individual', 'business'].includes(data.account_type) ||
            (data.profile !== null && (typeof data.profile !== 'object' || Array.isArray(data.profile))) ||
            !['not_submitted', 'legacy_incomplete', 'pending_review', 'changes_requested', 'verified', 'rejected'].includes(data.status)
        ) {
            throw new Error(this.intl.t('customer-business.invalid-response'));
        }
        this.data = data;
        this.draft = Object.fromEntries(FIELDS.map((field) => [field, data.profile?.[field] ?? '']));
        this.draft = {
            ...this.draft,
            legal_form: data.profile?.legal_form ?? 'individual_business',
            governorate: data.profile?.governorate ?? 'Tunis',
            rne_applicable: data.profile?.rne_applicable ?? true,
        };
        this.declaration = false;
        this.reviewing = false;
    }

    @action accountChanged() {
        this.data = null;
        this.draft = {};
        this.declaration = false;
        this.reviewing = false;
        this.load.perform();
    }

    @restartableTask *load() {
        const account = this.customerSession.accountId;
        this.data = null;
        this.reviewing = false;
        this.declaration = false;
        this.error = null;
        try {
            const result = yield this.fetch.get('account/business-profile', {}, { namespace: NAMESPACE });
            if (account === this.customerSession.accountId) this.accept(result);
        } catch (error) {
            if (account !== this.customerSession.accountId) return;
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }

    @action update(name, event) {
        this.draft = { ...this.draft, [name]: name === 'rne_applicable' ? event.target.checked : event.target.value };
    }

    @action declare(event) {
        this.declaration = event.target.checked;
    }

    @action review(event) {
        event.preventDefault();
        this.reviewing = true;
    }

    @action cancelReview() {
        this.reviewing = false;
    }

    @dropTask *save() {
        if (!this.editable || !this.reviewing || !this.declaration || this.load.isRunning) return;
        const account = this.customerSession.accountId;
        this.error = null;
        try {
            const result = yield this.fetch.post(
                'account/business-profile',
                {
                    revision: this.data.revision,
                    declaration: this.declaration,
                    profile: this.draft,
                },
                { namespace: NAMESPACE }
            );
            if (account !== this.customerSession.accountId) return;
            if (result.business_profile?.status !== 'pending_review' || result.business_profile.account_uuid !== this.data.account_uuid) {
                throw new Error(this.intl.t('customer-business.invalid-response'));
            }
            this.accept(result);
            this.notifications.success(this.intl.t('customer-business.submitted'));
        } catch (error) {
            if (account !== this.customerSession.accountId) return;
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }
}
