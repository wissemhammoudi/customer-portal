/* eslint-env node */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');
const root = path.resolve(__dirname, '..', '..');

function load(relative, window = {}) {
    const filename = path.join(root, relative);
    const exports = {};
    const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
        filename,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ['decorators'] },
        plugins: [
            ({ types: t }) => ({
                visitor: {
                    Decorator(node) {
                        node.remove();
                    },
                    ImportDeclaration(node) {
                        node.replaceWithMultiple(
                            node.node.specifiers.map((item) =>
                                t.variableDeclaration('const', [
                                    t.variableDeclarator(
                                        item.local,
                                        t.memberExpression(
                                            t.callExpression(t.identifier('require'), [node.node.source]),
                                            t.identifier(item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported.name)
                                        )
                                    ),
                                ])
                            )
                        );
                    },
                    ExportDefaultDeclaration(node) {
                        node.replaceWith(
                            t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('exports'), t.identifier('default')), t.toExpression(node.node.declaration)))
                        );
                    },
                    ExportNamedDeclaration(node) {
                        const declaration = node.node.declaration;
                        node.replaceWithMultiple([
                            declaration,
                            t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('exports'), declaration.id), declaration.id)),
                        ]);
                    },
                },
            }),
        ],
    });
    const requireModule = (id) => {
        if (id === '@glimmer/component')
            return {
                default: class Component {
                    constructor(owner, args) {
                        this.args = args;
                    }
                },
            };
        if (id === '@ember/routing/route') return { default: class Route {} };
        if (id === '@ember/component/helper') return { helper: (callback) => callback };
        return { inject() {}, tracked() {}, action() {} };
    };
    vm.runInNewContext(code, { exports, require: requireModule, window, Intl, encodeURIComponent }, { filename });
    return exports;
}

test('invoice currency formatting respects TND millimes, EUR cents, JPY and zero', () => {
    const { formatInvoiceMoney } = load('addon/helpers/invoice-money.js');
    assert.equal(formatInvoiceMoney(11900, 'TND'), 'TND\u00a011.900');
    assert.equal(formatInvoiceMoney(1190, 'EUR'), '€11.90');
    assert.equal(formatInvoiceMoney(1190, 'JPY'), 'JP¥1,190');
    assert.equal(formatInvoiceMoney(0, 'TND'), 'TND\u00a00.000');
});

test('both invoice types request fresh authenticated view/download URLs', async () => {
    const popup = { opener: {}, location: {}, close() {} };
    const Component = load('addon/components/portal/invoice-pdf-actions.js', { open: () => popup }).default;
    for (const kind of ['ledger', 'cod']) {
        const component = new Component({}, { invoice: { id: 'invoice/one', status: 'sent' }, kind });
        const calls = [];
        component.fetch = {
            get: async (...args) => {
                calls.push(args);
                return { url: `https://api.example.com/${calls.length}.pdf` };
            },
        };
        await component.open(false);
        await component.open(true);
        assert.equal(calls[0][0], `${kind === 'cod' ? 'mobile/wallet/invoices' : 'invoices'}/invoice%2Fone/pdf`);
        assert.equal(calls[0][1].download, 0);
        assert.equal(calls[1][1].download, 1);
        assert.equal(calls[0][2].namespace, 'customer-portal/int/v1');
        assert.equal(popup.location.href, 'https://api.example.com/2.pdf');
        assert.equal(popup.opener, null);
        assert.equal(component.busy, false);
    }
});

test('failed PDF requests close the viewer, remain retryable and drafts do not request', async () => {
    const popup = {
        location: {},
        close() {
            this.closed = true;
        },
    };
    const Component = load('addon/components/portal/invoice-pdf-actions.js', { open: () => popup }).default;
    const component = new Component({}, { invoice: { id: 'invoice_1', status: 'sent' } });
    component.fetch = {
        get: async () => {
            throw new Error('Forbidden');
        },
    };
    await component.open();
    assert.equal(popup.closed, true);
    assert.ok(component.error);
    assert.equal(component.busy, false);
    component.fetch.get = async () => ({ url: 'https://api.example.com/retry.pdf' });
    await component.open();
    assert.equal(component.error, null);
    const draft = new Component({}, { invoice: { id: 'draft', status: 'draft' } });
    draft.fetch = { get: () => assert.fail('Draft must not request PDF') };
    await draft.open();
    assert.equal(draft.unavailable, true);
});

test('billing loads fee invoices independently of Ledger availability', async () => {
    const Route = load('addon/routes/portal/billing/index.js').default;
    const route = new Route();
    route.fetch = { get: async (endpoint) => (endpoint === 'invoices' ? { available: false, invoices: [] } : { invoices: [{ number: 'FA-2026-1' }] }) };
    let result = await route.model();
    assert.equal(result.feeInvoices[0].number, 'FA-2026-1');
    assert.equal(result.available, false);
    route.fetch.get = async (endpoint) => {
        if (endpoint === 'invoices') throw new Error('Ledger unavailable');
        return { invoices: [{ number: 'FA-2026-1' }] };
    };
    result = await route.model();
    assert.equal(result.billingError, true);
    assert.equal(result.feeInvoicesError, false);
    assert.equal(result.feeInvoices[0].number, 'FA-2026-1');
});
