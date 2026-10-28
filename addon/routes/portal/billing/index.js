import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

export default class PortalBillingIndexRoute extends Route {
    @service fetch;

    async model() {
        const options = { namespace: 'customer-portal/int/v1' };
        const [billing, fees] = await Promise.allSettled([this.fetch.get('invoices', {}, options), this.fetch.get('mobile/wallet/invoices', {}, options)]);
        return {
            ...(billing.status === 'fulfilled' ? billing.value : { invoices: [] }),
            feeInvoices: fees.status === 'fulfilled' ? fees.value.invoices : [],
            billingError: billing.status === 'rejected',
            feeInvoicesError: fees.status === 'rejected',
        };
    }
}
