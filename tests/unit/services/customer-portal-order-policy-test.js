import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';

module('Unit | Service | customer portal order policy', function (hooks) {
    setupTest(hooks);

    test('quote validation enforces phones, pickup coordinates and optional future schedule', function (assert) {
        const creation = this.owner.lookup('service:customer-portal-order-creation');
        const validation = this.owner.lookup('service:customer-portal-order-validation');
        validation.deliveryOptions = { catalogue: {}, isValidEntity: () => true };
        creation.accountPickup = { uuid: 'pickup', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        const draft = creation.start([{ uuid: 'config' }]);
        draft.payload.dropoff = { street1: 'Recipient', phone: '456' };
        draft.payload.entities = [{}];
        assert.true(validation.canQuote(draft));
        draft.scheduledAt = new Date(Date.now() + 86400000).toISOString();
        assert.true(validation.canQuote(draft));
        draft.scheduledAt = '2001-01-01T10:00:00Z';
        assert.false(validation.canQuote(draft));
        draft.scheduledAt = 'invalid';
        assert.false(validation.canQuote(draft));
        draft.scheduledAt = null;
        draft.payload.dropoff.phone = ' ';
        assert.false(validation.canQuote(draft));
        draft.payload.dropoff.phone = '456';
        draft.payload.pickup.latitude = '';
        assert.false(validation.canQuote(draft));
    });

    test('new drafts use the current account pickup and never inherit pending returns', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const pickup = { uuid: 'pickup', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        service.accountPickup = pickup;
        service.pendingReturnOrder = { uuid: 'old-order' };
        const draft = service.start([{ uuid: 'config' }]);
        assert.strictEqual(draft.payload.pickup, pickup);
        assert.strictEqual(draft.meta.delivery.purpose, 'transportation');
        assert.strictEqual(draft.scheduledAt, null);
        assert.deepEqual(draft.payload.waypoints, []);
    });

    test('unsupported drafts preserve their hidden data and are blocked', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const saved = { uuid: 'draft', input: { order_config: 'config', meta: { delivery: { purpose: 'return' } }, return: { street1: 'Return' }, waypoints: [{ street1: 'Stop' }] } };
        const draft = service.restoreCheckoutDraft(saved, [{ uuid: 'config' }]);
        assert.ok(draft.blockedReason);
        assert.deepEqual(draft.payload.return, saved.input.return);
        assert.strictEqual(draft.payload.waypoints.length, 1);
    });

    test('changed profile pickup blocks restoration until explicit acknowledgement and invalidates quote', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        service.accountPickup = { uuid: 'pickup', street1: 'New', phone: '123', latitude: 36, longitude: 10 };
        const saved = {
            uuid: 'draft',
            input: { order_config: 'config', pickup: { uuid: 'pickup', street1: 'Old' }, meta: { delivery: { purpose: 'transportation' } }, service_quote_uuid: 'quote' },
        };
        const draft = service.restoreCheckoutDraft(saved, [{ uuid: 'config' }], true);
        assert.true(draft.pickupChanged);
        assert.strictEqual(draft.payload.pickup.street1, 'Old');
        assert.strictEqual(draft.serviceQuote, null);
        service.acknowledgePickupChange();
        assert.false(service.draft.pickupChanged);
        assert.strictEqual(service.draft.payload.pickup.street1, 'New');
        assert.strictEqual(service.draft.serviceQuote, null);
    });
});
