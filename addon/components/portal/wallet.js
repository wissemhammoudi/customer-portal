import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { dropTask } from 'ember-concurrency';
import { DEFAULT_FINANCE_BALANCES, FINANCE_BALANCES } from '../../utils/customer-parity';

const API = { namespace: 'customer-portal/int/v1' };

export default class PortalWalletComponent extends Component {
    @service fetch;
    @service notifications;
    @service intl;
    @tracked data = null;
    @tracked invoices = [];
    @tracked feeInvoices = [];
    @tracked error = '';
    @tracked period = '';
    @tracked selectedPeriod = '';
    @tracked orderPage = 1;
    @tracked paymentPage = 1;
    @tracked section = 'overview';
    @tracked showBreakdown = false;

    @action selectSection(section) {
        this.section = section;
    }

    @action toggleBreakdown() {
        this.showBreakdown = !this.showBreakdown;
    }

    get visibleBalances() {
        return this.balances.filter((balance) => this.showBreakdown || DEFAULT_FINANCE_BALANCES.includes(balance.key));
    }

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    money(amount) {
        return new Intl.NumberFormat(this.intl.primaryLocale, { style: 'currency', currency: this.data.finance.currency, minimumFractionDigits: 3 }).format(amount / 1000);
    }

    get balances() {
        if (!this.data) return [];
        return FINANCE_BALANCES.map(([key, label]) => ({ key, label: this.intl.t(`customer-finances.${label}`), amount: this.money(this.data.finance[key] ?? 0) }));
    }

    get orders() {
        return (this.data?.orders.data ?? []).map((order) => ({
            ...order,
            grossDisplay: this.money(order.gross),
            feeDisplay: this.money(order.fee),
            vatDisplay: this.money(order.vat),
            netDisplay: this.money(order.net),
        }));
    }

    get payouts() {
        return (this.data?.payments.data ?? []).map((payment) => ({
            ...payment,
            formattedAmount: this.money(payment.paid_at || payment.status === 'paid' || payment.is_reversed ? payment.paid_amount : payment.amount),
            originalAmount: this.money(payment.amount),
            amountChanged: (payment.paid_at || payment.status === 'paid' || payment.is_reversed) && payment.paid_amount !== payment.amount,
            methodLabel: this.intl.t(`customer-finances.${payment.method === 'bank_transfer' ? 'bank-transfer' : 'office-cash'}`),
        }));
    }

    get firstOrderPage() {
        return !this.data || this.data.orders.page <= 1;
    }
    get lastOrderPage() {
        return !this.data || this.data.orders.page >= this.data.orders.last_page;
    }
    get firstPaymentPage() {
        return !this.data || this.data.payments.page <= 1;
    }
    get lastPaymentPage() {
        return !this.data || this.data.payments.page >= this.data.payments.last_page;
    }

    @action applyPeriod() {
        if (this.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(this.period.trim())) {
            this.error = this.intl.t('customer-finances.invalid-period');
            return;
        }
        this.selectedPeriod = this.period.trim();
        this.orderPage = 1;
        this.load.perform();
    }

    @action page(kind, offset) {
        if (kind === 'orders') this.orderPage += offset;
        else this.paymentPage += offset;
        this.load.perform();
    }

    @dropTask *load() {
        this.error = '';
        this.data = null;
        try {
            const [data, invoices, feeInvoices] = yield Promise.all([
                this.fetch.get('wallet', { page: this.orderPage, payments_page: this.paymentPage, ...(this.selectedPeriod ? { period: this.selectedPeriod } : {}) }, API),
                this.fetch.get('invoices', {}, API),
                this.fetch.get('wallet/invoices', {}, API),
            ]);
            if (!data.finance || !data.orders || !data.payments) throw new Error('The backend financial reporting release must be deployed with this Console.');
            this.data = data;
            this.invoices = invoices.invoices;
            this.feeInvoices = feeInvoices.invoices;
        } catch (error) {
            this.error = this.intl.t('customer-finances.error');
            this.notifications.serverError(error);
        }
    }
}
