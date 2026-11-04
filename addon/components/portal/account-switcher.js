import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { task } from 'ember-concurrency';

export default class PortalAccountSwitcherComponent extends Component {
    @service fetch;
    @service customerSession;
    @service notifications;
    @tracked accounts = [];
    @tracked error;

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    @task *load() {
        try {
            const result = yield this.fetch.get('account/choices', {}, { namespace: 'customer-portal/int/v1' });
            this.accounts = result.accounts;
            this.customerSession.accounts = result.accounts;
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }

    @task({ drop: true }) *select(event) {
        const id = event.target.value;
        if (!id || id === this.customerSession.accountId) return;
        try {
            yield this.fetch.post('account/select', { account_uuid: id }, { namespace: 'customer-portal/int/v1' });
            window.location.reload();
        } catch (error) {
            this.error = error.message;
            event.target.value = this.customerSession.accountId;
            this.notifications.serverError(error);
        }
    }
}
