import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { task } from 'ember-concurrency';

export default class WidgetRemainingDueComponent extends Component {
    @service fetch;
    @tracked amount = 0;
    @tracked currency = 'TND';
    @tracked error;

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    get formatted() {
        return `${(Number(this.amount || 0) / 1000).toFixed(3)} ${this.currency}`;
    }

    @task *load() {
        try {
            const response = yield this.fetch.get('wallet', { page: 1, payments_page: 1 }, { namespace: 'customer-portal/int/v1' });
            const finance = response.finance ?? response.wallet;
            this.amount = finance?.remaining_due ?? 0;
            this.currency = finance?.currency ?? 'TND';
            this.error = null;
        } catch {
            this.amount = 0;
            this.error = 'Unable to load remaining due.';
        }
    }
}
