import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

export default class PortalBillingIndexRoute extends Route {
    @service fetch;
    @service notifications;

    async model() {
        const options = { namespace: 'customer-portal/int/v1' };
        try {
            return await this.fetch.get('invoices', {}, options);
        } catch (error) {
            this.notifications.serverError(error);
            return { invoices: [], billingError: true };
        }
    }
}
