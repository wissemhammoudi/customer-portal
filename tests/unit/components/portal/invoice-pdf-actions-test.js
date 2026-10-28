import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import InvoicePdfActions from '@fleetbase/customer-portal-engine/components/portal/invoice-pdf-actions';
import { formatInvoiceMoney } from '@fleetbase/customer-portal-engine/helpers/invoice-money';

module('Unit | Component | portal invoice PDF actions', function (hooks) {
    setupTest(hooks);
    test('invoice money respects TND millimes as well as two-decimal and zero-decimal currencies', function (assert) {
        assert.strictEqual(formatInvoiceMoney(11900, 'TND'), 'TND\u00a011.900');
        assert.strictEqual(formatInvoiceMoney(1190, 'EUR'), '€11.90');
        assert.strictEqual(formatInvoiceMoney(1190, 'JPY'), 'JP¥1,190');
        assert.strictEqual(formatInvoiceMoney(0, 'TND'), 'TND\u00a00.000');
    });
    let originalOpen;
    let popup;
    hooks.beforeEach(function () {
        originalOpen = window.open;
        popup = {
            opener: {},
            location: {},
            close() {
                this.closed = true;
            },
        };
        window.open = () => popup;
    });
    hooks.afterEach(function () {
        window.open = originalOpen;
    });

    test('each view and download requests a fresh authenticated link for the correct invoice type', async function (assert) {
        for (const kind of ['ledger', 'cod']) {
            const component = new InvoicePdfActions(this.owner, { invoice: { id: 'invoice/one', status: 'sent' }, kind });
            const calls = [];
            component.fetch = {
                get: async (...args) => {
                    calls.push(args);
                    return { url: `https://api.example.com/${calls.length}.pdf` };
                },
            };
            await component.open(false);
            await component.open(true);
            const prefix = kind === 'cod' ? 'mobile/wallet/invoices' : 'invoices';
            assert.strictEqual(calls[0][0], `${prefix}/invoice%2Fone/pdf`);
            assert.deepEqual(calls[0][1], { download: 0 });
            assert.deepEqual(calls[1][1], { download: 1 });
            assert.strictEqual(calls[0][2].namespace, 'customer-portal/int/v1');
            assert.strictEqual(popup.location.href, 'https://api.example.com/2.pdf');
            assert.strictEqual(popup.opener, null);
            assert.false(component.busy);
        }
    });

    test('errors close the blank viewer and leave actions retryable; drafts do not request PDFs', async function (assert) {
        const component = new InvoicePdfActions(this.owner, { invoice: { id: 'invoice_1', status: 'sent' } });
        component.fetch = {
            get: async () => {
                throw new Error('Forbidden');
            },
        };
        await component.open();
        assert.true(popup.closed);
        assert.ok(component.error);
        assert.false(component.busy);
        const draft = new InvoicePdfActions(this.owner, { invoice: { id: 'draft', status: 'draft' } });
        draft.fetch = { get: () => assert.ok(false, 'draft must not request PDF') };
        await draft.open();
        assert.true(draft.unavailable);
    });
});
