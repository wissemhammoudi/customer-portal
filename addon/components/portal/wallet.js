import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { dropTask } from 'ember-concurrency';

const API = { namespace: 'customer-portal/int/v1' };

export default class PortalWalletComponent extends Component {
    @service fetch;
    @service notifications;
    @tracked data;
    @tracked amount = '';
    @tracked method = 'bank_transfer';
    @tracked rib = '';
    @tracked error = '';

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    money(amount) {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: this.data.wallet.currency, minimumFractionDigits: 3 }).format(amount / 1000);
    }

    get balances() {
        if (!this.data) return [];
        return [
            ['Available to withdraw', 'available'],
            ['Pending driver cash', 'pending'],
            ['Reserved for payouts', 'reserved'],
            ['Already paid out', 'paid_out'],
        ].map(([label, key]) => ({ label, amount: this.money(this.data.wallet[key]) }));
    }

    get minimum() {
        return this.data ? this.money(this.data.wallet.minimum_payout) : '';
    }

    get payouts() {
        return (this.data?.payouts ?? []).map((payout) => ({
            ...payout,
            formattedAmount: this.money(payout.amount),
            methodLabel: payout.method === 'bank_transfer' ? 'Bank transfer' : 'Cash at office',
        }));
    }

    @action setMethod(event) {
        this.method = event.target.value;
    }

    @action submitForm(event) {
        event.preventDefault();
        this.submit.perform();
    }

    @dropTask *load() {
        this.error = '';
        try {
            this.data = yield this.fetch.get('wallet', {}, API);
        } catch (error) {
            this.error = 'Could not load your wallet. Please try again.';
            this.notifications.serverError(error);
        }
    }

    @dropTask *submit() {
        this.error = '';
        const input = this.amount.trim().replace(',', '.');
        if (!/^\d+(\.\d{1,3})?$/.test(input)) {
            this.error = 'Enter a valid amount with at most three decimal places.';
            return;
        }
        const [whole, fraction = ''] = input.split('.');
        const amount = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
        if (!Number.isSafeInteger(amount) || amount < this.data.wallet.minimum_payout || amount > this.data.wallet.available) {
            this.error = 'The amount must meet the minimum payout and not exceed your available balance.';
            return;
        }
        if (this.method === 'bank_transfer' && !/^\d{20}$/.test(this.rib.trim())) {
            this.error = 'Enter a 20-digit RIB without spaces.';
            return;
        }
        try {
            yield this.fetch.post('wallet/payouts', { amount, method: this.method, ...(this.method === 'bank_transfer' ? { rib: this.rib.trim() } : {}) }, API);
            this.amount = '';
            this.rib = '';
            this.notifications.success('Payout requested. It is awaiting administrator approval.');
            yield this.load.perform();
        } catch (error) {
            this.error = 'Could not request the payout. Check the error and refresh before retrying.';
            this.notifications.serverError(error);
        }
    }
}
