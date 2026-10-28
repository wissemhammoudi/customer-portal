import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { dropTask } from 'ember-concurrency';

const API = { namespace: 'customer-portal/int/v1/mobile' };

export default class PortalNotificationInboxComponent extends Component {
    @service fetch;
    @service notifications;
    @tracked data;
    @tracked error = '';
    @tracked page = 1;

    constructor() {
        super(...arguments);
        this.load.perform(1);
    }

    get previousPage() {
        return Math.max(1, this.page - 1);
    }
    get nextPage() {
        return this.page + 1;
    }
    get firstPage() {
        return this.page === 1;
    }

    @dropTask *load(page = this.page) {
        this.error = '';
        try {
            this.data = yield this.fetch.get('notifications', { page }, API);
            this.page = page;
        } catch (error) {
            this.error = 'Could not load notifications. Please refresh.';
            this.notifications.serverError(error);
        }
    }

    @dropTask *read(id) {
        try {
            yield this.fetch.put('notifications/read', { notifications: [id] }, API);
            yield this.load.perform();
        } catch (error) {
            this.notifications.serverError(error);
        }
    }
}
