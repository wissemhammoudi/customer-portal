/* eslint-env node */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

// Run the focused QUnit logic tests without the host app's broken Ember vendor bundle.
const cache = new Map();
const root = path.resolve(__dirname, '..', '..');
let moduleName;
const assertions = {
    true: (value) => assert.equal(value, true),
    false: (value) => assert.equal(value, false),
    ok: (value) => assert.ok(value),
    strictEqual: (actual, expected) => assert.equal(actual, expected),
    deepEqual: (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected))),
};

function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
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
        if (id === '@ember/service') return { default: class Service {}, inject() {} };
        if (id === '@ember/object') return { get: (subject, key) => key.split('.').reduce((value, part) => value?.[part], subject), action() {} };
        if (id === '@glimmer/tracking') return { tracked() {} };
        if (id === 'ember-qunit') return { setupTest() {} };
        if (id === 'qunit')
            return {
                module(name, callback) {
                    moduleName = name;
                    callback({});
                },
                test(name, callback) {
                    test(`${moduleName}: ${name}`, () =>
                        callback.call(
                            {
                                owner: {
                                    lookup(service) {
                                        const Service = load(path.join(root, 'addon', 'services', `${service.replace('service:', '')}.js`)).default;
                                        return new Service();
                                    },
                                },
                            },
                            assertions
                        ));
                },
            };
        const target = id.startsWith('@fleetbase/customer-portal-engine/')
            ? path.join(root, 'addon', id.replace('@fleetbase/customer-portal-engine/', ''))
            : path.resolve(path.dirname(filename), id);
        return load(`${target}.js`);
    };
    vm.runInNewContext(code, { exports, require: requireModule, window: { sessionStorage: {} } }, { filename });
    return exports;
}

load(path.join(root, 'tests', 'unit', 'utils', 'customer-order-policy-test.js'));
load(path.join(root, 'tests', 'unit', 'services', 'customer-portal-order-policy-test.js'));
