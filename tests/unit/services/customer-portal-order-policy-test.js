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

    test('standalone return uses account pickup as dropoff and clears COD when changing purpose', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const accountPickup = { uuid: 'account', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        service.accountPickup = accountPickup;
        service.start([{ uuid: 'config' }]);
        service.setPayloadField('cod_amount', '25');
        service.setPayloadField('cod_currency', 'TND');
        service.setPayloadField('cod_payment_method', 'cash');
        service.setServiceQuotes([{ uuid: 'old-quote', amount: 10 }]);
        service.setPurpose('return');
        assert.strictEqual(service.draft.meta.delivery.purpose, 'return');
        assert.strictEqual(service.draft.payload.pickup, null);
        assert.strictEqual(service.draft.payload.dropoff, accountPickup);
        assert.strictEqual(service.draft.payload.cod_amount, null);
        assert.strictEqual(service.draft.payload.cod_currency, null);
        assert.strictEqual(service.draft.payload.cod_payment_method, null);
        assert.strictEqual(service.draft.serviceQuote, null);
        service.setPurpose('transportation');
        assert.strictEqual(service.draft.payload.pickup, accountPickup);
        assert.strictEqual(service.draft.payload.dropoff, null);
    });

    test('mobile standalone return restores its current quote and can proceed with payment and submission', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const validation = this.owner.lookup('service:customer-portal-order-validation');
        const actions = this.owner.lookup('service:customer-portal-order-actions');
        validation.deliveryOptions = { catalogue: {}, isValidEntity: () => true };
        service.accountPickup = { uuid: 'account', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        const input = {
            order_config: 'config',
            pickup: { uuid: 'recipient', street1: 'Recipient', phone: '456', latitude: 35, longitude: 9 },
            dropoff: { ...service.accountPickup },
            meta: { delivery: { purpose: 'return', service_level: 'standard' } },
            entities: [{ name: 'Parcel', type: 'parcel' }],
            service_quote_uuid: 'server-discounted-quote',
        };
        const draft = service.restoreCheckoutDraft({ uuid: 'mobile-draft', input }, [{ uuid: 'config' }], true);
        assert.notOk(draft.blockedReason);
        assert.notOk(draft.pickupChanged);
        assert.true(validation.canQuote(draft));
        assert.true(validation.canCreate(draft));
        const serialized = actions.serializeDraft(draft);
        assert.strictEqual(serialized.checkout_draft_uuid, 'mobile-draft');
        assert.strictEqual(serialized.service_quote_uuid, 'server-discounted-quote');
        assert.strictEqual(serialized.meta.delivery.purpose, 'return');
        assert.deepEqual(serialized.pickup, input.pickup);
        assert.deepEqual(serialized.dropoff, input.dropoff);
    });

    test('Express remains unavailable even if a package catalogue advertises it', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const validation = this.owner.lookup('service:customer-portal-order-validation');
        validation.deliveryOptions = {
            catalogue: { service_levels: [{ value: 'standard' }, { value: 'express', available: true }] },
            isValidEntity: () => true,
        };
        service.accountPickup = { street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        const draft = service.start([{ uuid: 'config' }]);
        draft.payload.dropoff = { street1: 'Recipient', phone: '456' };
        draft.payload.entities = [{}];
        assert.true(validation.canQuote(draft));
        draft.meta.delivery.service_level = 'express';
        assert.false(validation.canQuote(draft));
        draft.meta.delivery.service_level = 'standard';
        validation.deliveryOptions.catalogue.service_levels = [{ value: 'standard', available: false }];
        assert.false(validation.canQuote(draft));
    });

    test('changed account address acknowledgement updates only the standalone return dropoff', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        service.accountPickup = { uuid: 'account', street1: 'New warehouse', phone: '123', latitude: 36, longitude: 10 };
        const pickup = { uuid: 'recipient', street1: 'Return sender', phone: '456', latitude: 35, longitude: 9 };
        const input = {
            order_config: 'config',
            pickup,
            dropoff: { ...service.accountPickup, street1: 'Old warehouse' },
            meta: { delivery: { purpose: 'return' } },
            service_quote_uuid: 'old-quote',
        };
        const draft = service.restoreCheckoutDraft({ uuid: 'draft', input }, [{ uuid: 'config' }], true);
        assert.true(draft.pickupChanged);
        assert.strictEqual(draft.payload.pickup, pickup);
        assert.strictEqual(draft.payload.dropoff.street1, 'Old warehouse');
        assert.strictEqual(draft.serviceQuote, null);
        service.acknowledgePickupChange();
        assert.false(service.draft.pickupChanged);
        assert.strictEqual(service.draft.payload.pickup, pickup);
        assert.strictEqual(service.draft.payload.dropoff, service.accountPickup);
        assert.strictEqual(service.draft.quotedRevision, null);
    });

    test('linked return reverses saved addresses without copying COD and requires route review', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const validation = this.owner.lookup('service:customer-portal-order-validation');
        const actions = this.owner.lookup('service:customer-portal-order-actions');
        validation.deliveryOptions = { catalogue: {}, isValidEntity: () => true };
        service.accountPickup = { street1: 'Current warehouse', phone: '999', latitude: 37, longitude: 11 };
        const original = {
            uuid: 'original',
            status: 'pending',
            payload: {
                pickup: { street1: 'Historical warehouse', phone: '123', latitude: 36, longitude: 10 },
                dropoff: { street1: 'Recipient', phone: '456', latitude: 35, longitude: 9 },
                cod_amount: '50',
                cod_currency: 'TND',
                cod_payment_method: 'cash',
            },
        };
        service.startReturn([{ uuid: 'config' }], original);
        assert.strictEqual(service.draft.meta.delivery.original_order_uuid, 'original');
        assert.strictEqual(service.draft.payload.pickup, original.payload.dropoff);
        assert.strictEqual(service.draft.payload.dropoff, original.payload.pickup);
        assert.strictEqual(service.draft.payload.cod_amount, null);
        assert.strictEqual(service.draft.payload.cod_currency, null);
        assert.strictEqual(service.draft.payload.cod_payment_method, null);
        service.setPayloadField('entities', [{ name: 'Returned parcel', type: 'parcel' }]);
        assert.false(validation.canQuote(service.draft));
        service.setField('returnAddressesConfirmed', true);
        assert.true(validation.canQuote(service.draft));
        assert.true(actions.serializeQuoteRequest(service.draft).return_addresses_confirmed);
        service.setPurpose('transportation');
        assert.strictEqual(service.draft.meta.delivery.purpose, 'return', 'linked purpose is fixed');
    });

    test('linked mobile return keeps both historical addresses and its paid quote after account pickup changes', function (assert) {
        const service = this.owner.lookup('service:customer-portal-order-creation');
        const validation = this.owner.lookup('service:customer-portal-order-validation');
        validation.deliveryOptions = { catalogue: {}, isValidEntity: () => true };
        service.accountPickup = { uuid: 'current', street1: 'New warehouse', phone: '999', latitude: 37, longitude: 11 };
        const input = {
            order_config: 'config',
            pickup: { uuid: 'recipient', street1: 'Recipient', phone: '456', latitude: 35, longitude: 9 },
            dropoff: { uuid: 'old', street1: 'Historical warehouse', phone: '123', latitude: 36, longitude: 10 },
            meta: { delivery: { purpose: 'return', service_level: 'standard', original_order_uuid: 'original' } },
            entities: [{ name: 'Parcel', type: 'parcel' }],
            service_quote_uuid: 'paid-quote',
        };
        const draft = service.restoreCheckoutDraft({ uuid: 'mobile-draft', input }, [{ uuid: 'config' }], true);
        assert.notOk(draft.blockedReason);
        assert.notOk(draft.pickupChanged);
        assert.deepEqual(draft.payload.pickup, input.pickup);
        assert.deepEqual(draft.payload.dropoff, input.dropoff);
        assert.strictEqual(draft.serviceQuote.uuid, 'paid-quote');
        draft.purchaseRate = { uuid: 'paid-purchase' };
        assert.false(validation.canCreate(draft), 'mobile drafts require an explicit route review');
        service.setField('returnAddressesConfirmed', true);
        assert.true(validation.canCreate(service.draft));
        assert.strictEqual(service.draft.serviceQuote.uuid, 'paid-quote', 'route review is not a fare change');
        assert.strictEqual(service.draft.purchaseRate.uuid, 'paid-purchase', 'route review preserves the existing payment');
        service.acknowledgePickupChange();
        assert.deepEqual(service.draft.payload.dropoff, input.dropoff, 'account acknowledgement cannot replace a historical linked endpoint');
        assert.strictEqual(service.draft.serviceQuote.uuid, 'paid-quote');
    });
});
