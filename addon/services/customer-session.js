import Service, { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { task } from 'ember-concurrency';

export default class CustomerSessionService extends Service {
    @service currentUser;
    @service fetch;
    @service notifications;
    @tracked customer = {};
    @tracked account = {};
    @tracked accounts = [];
    @tracked selectionRequired = false;

    @task *loadCustomer() {
        try {
            yield this.promiseCurrentCustomer();
        } catch (error) {
            this.notifications.serverError(error);
        }
    }

    async promiseCurrentCustomer() {
        const portalAccount = await this.fetch.get('account', {}, { namespace: 'customer-portal/int/v1' });
        this.customer = portalAccount.customer ?? {};
        this.selectionRequired = portalAccount.selection_required === true;
        this.account = portalAccount.account ?? {};
        this.accounts = portalAccount.accounts ?? [];
        this.fetch.customerAccount = this.account.uuid ? { user: this.currentUser.id, uuid: this.account.uuid } : null;
        this.currentUser['customer'] = this.customer;
        this.currentUser['customerAccount'] = this.account;
    }

    get capabilities() {
        return this.account?.capabilities ?? {};
    }

    getCustomer() {
        return this.customer;
    }

    getAccount() {
        return this.account || this.customer;
    }

    get accountId() {
        return this.get('uuid') || this.get('id');
    }

    get accountType() {
        return this.get('customer_type') || this.get('type') || 'contact';
    }

    get(key, defaultValue = null) {
        const source = this.account || this.customer || {};
        const value = source[key];
        if (value === undefined) {
            return defaultValue;
        }

        return value;
    }
}
