import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import PayoutReceipt from '@fleetbase/customer-portal-engine/components/portal/payout-receipt';

module('Unit | Component | portal payout receipt', function (hooks) {
    setupTest(hooks);
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

    test('only paid office cash can be signed and a request is not receipt proof', function (assert) {
        for (const [status, method, expected] of [
            ['requested', 'office_cash', false],
            ['approved', 'office_cash', false],
            ['paid', 'bank_transfer', false],
            ['paid', 'office_cash', true],
        ]) {
            const component = new PayoutReceipt(this.owner, { payout: { id: 'one', amount: 60000, status, method, paid_at: status === 'paid' ? '2026-11-01' : null }, currency: 'TND' });
            assert.strictEqual(Boolean(component.canSign), expected);
            assert.false(component.received);
            assert.true(component.disabled, 'empty name/signature cannot be submitted');
        }
    });

    test('signature save retains strokes on failure and exact retry creates receipt without another payout request', async function (assert) {
        let reloads = 0;
        const component = new PayoutReceipt(this.owner, {
            payout: { id: 'cash/one', amount: 60000, status: 'paid', method: 'office_cash', paid_at: '2026-11-01' },
            onSigned: () => reloads++,
        });
        component.notifications = { serverError() {} };
        component.name = 'Original recipient';
        component.strokes = [
            [
                [0, 0],
                [100, 50],
            ],
        ];
        component.distance = 100;
        const calls = [];
        component.fetch = {
            post: async (...args) => {
                calls.push(args);
                if (calls.length === 1) throw new Error('Temporary failure');
                return { receipt: { id: 'receipt', signed_at: '2026-11-01' } };
            },
        };
        await component.sign();
        assert.ok(component.error);
        assert.deepEqual(component.strokes, [
            [
                [0, 0],
                [100, 50],
            ],
        ]);
        assert.false(component.busy);
        await component.sign();
        assert.strictEqual(calls[0][0], 'wallet/payouts/cash%2Fone/receipt');
        assert.deepEqual(calls[1][1], {
            signer_name: 'Original recipient',
            signature: [
                [
                    [0, 0],
                    [100, 50],
                ],
            ],
            acknowledged: true,
        });
        assert.true(component.received);
        assert.notOk(component.canSign);
        assert.strictEqual(reloads, 1);
        await component.sign();
        assert.strictEqual(calls.length, 2, 'signed receipt cannot be signed again');
    });

    test('signed PDFs use fresh scoped view/download URLs and errors close blank popup', async function (assert) {
        const component = new PayoutReceipt(this.owner, { payout: { id: 'cash/one', receipt: { uuid: 'receipt' } } });
        component.notifications = { serverError() {} };
        const calls = [];
        component.fetch = {
            get: async (...args) => {
                calls.push(args);
                return { url: 'https://api.example.test/receipt.pdf' };
            },
        };
        await component.open(false);
        await component.open(true);
        assert.strictEqual(calls[0][0], 'wallet/payouts/cash%2Fone/receipt');
        assert.deepEqual(calls[0][1], { download: 0 });
        assert.deepEqual(calls[1][1], { download: 1 });
        assert.strictEqual(calls[0][2].namespace, 'customer-portal/int/v1');
        assert.strictEqual(popup.opener, null);
        component.fetch = { get: async () => ({ url: 'javascript:bad()' }) };
        await component.open();
        assert.true(popup.closed);
        assert.ok(component.error);
        assert.false(component.busy);
    });

    test('pointer capture produces bounded strokes and clear removes signature', function (assert) {
        const component = new PayoutReceipt(this.owner, { payout: {} });
        const context = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
        component.setupCanvas({
            getContext: () => context,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 120 }),
            setPointerCapture() {},
            hasPointerCapture: () => true,
            releasePointerCapture() {},
        });
        component.begin({ pointerId: 1, clientX: 10, clientY: 10, preventDefault() {} });
        component.move({ pointerId: 1, clientX: 100, clientY: 50 });
        component.finish({ pointerId: 1 });
        assert.deepEqual(component.strokes, [
            [
                [20, 20],
                [200, 100],
            ],
        ]);
        assert.ok(component.distance > 30);
        component.clear();
        assert.strictEqual(component.distance, 0);
        assert.deepEqual(component.strokes, []);
    });
});
