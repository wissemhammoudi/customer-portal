import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';

export default class PortalInvoicePdfActionsComponent extends Component {
    @service fetch;
    @tracked busy = false;
    @tracked error = null;

    get unavailable() {
        return this.args.invoice?.status === 'draft';
    }

    @action async open(download = false) {
        if (this.busy || this.unavailable) return;
        const invoice = this.args.invoice;
        const id = invoice?.public_id || invoice?.id || invoice?.uuid;
        if (!id) return;
        const popup = window.open('', '_blank');
        if (popup) popup.opener = null;
        this.busy = true;
        this.error = null;
        try {
            const prefix = this.args.kind === 'cod' ? 'mobile/wallet/invoices' : 'invoices';
            const result = await this.fetch.get(`${prefix}/${encodeURIComponent(id)}/pdf`, { download: download ? 1 : 0 }, { namespace: 'customer-portal/int/v1' });
            if (!result.url) throw new Error('Invoice PDF is unavailable. Please try again.');
            if (popup) popup.location.href = result.url;
            else {
                const link = document.createElement('a');
                link.href = result.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.click();
            }
        } catch {
            if (popup) popup.close();
            this.error = 'Unable to open this invoice PDF. Please try again.';
        } finally {
            this.busy = false;
        }
    }
}
