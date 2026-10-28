import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import DetailsComponent from '@fleetbase/customer-portal-engine/components/portal/order/details';
import RouteComponent from '@fleetbase/customer-portal-engine/components/portal/order/form/route';

module('Unit | Component | portal order return flow', function (hooks) {
    setupTest(hooks);

    test('Return is available before or after completion, but not for any cancellation status', function (assert) {
        const component = new DetailsComponent(this.owner, { model: { order: {} } });
        for (const status of ['pending', 'completed', 'delivered', 'in_progress']) {
            component.order = { uuid: 'original', status, payload: { pickup: {}, dropoff: {} } };
            assert.true(component.canReturn, status);
        }
        for (const status of ['cancelled', 'canceled', 'order_canceled', 'order_cancelled']) {
            component.order = { uuid: 'original', status, payload: { pickup: {}, dropoff: {} } };
            assert.false(component.canReturn, status);
        }
        component.order = { status: 'pending', payload: { pickup: {} } };
        assert.false(component.canReturn, 'a route must have both endpoints');
    });

    test('standalone return edits pickup, not the fixed account dropoff', async function (assert) {
        const creation = this.owner.lookup('service:customer-portal-order-creation');
        creation.accountPickup = { uuid: 'warehouse', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        creation.start([{ uuid: 'config' }]);
        creation.setPurpose('return');
        const component = new RouteComponent(this.owner, { draft: creation.draft });
        component.customerPortalOrderCreation = creation;
        component.customerPortalOrderActions = {
            identifier: (place) => place.uuid,
            coordinatesFromPlaces: () => [],
        };
        component.customerPortalOrderRoutePreview = { updateDraft() {} };
        const sender = { uuid: 'sender', street1: 'Return sender', phone: '456', latitude: 35, longitude: 9 };
        assert.strictEqual(component.editableField, 'pickup');
        assert.strictEqual(component.fixedPlace, creation.accountPickup);
        await component.setPayloadPlace('pickup', sender);
        assert.strictEqual(creation.draft.payload.pickup, sender);
        await component.setPayloadPlace('dropoff', sender);
        assert.strictEqual(creation.draft.payload.dropoff, creation.accountPickup);
    });

    test('linked route is read-only and requires explicit confirmation', async function (assert) {
        const creation = this.owner.lookup('service:customer-portal-order-creation');
        const original = {
            uuid: 'original',
            payload: {
                pickup: { uuid: 'historical-warehouse', street1: 'Old warehouse', phone: '123', latitude: 36, longitude: 10 },
                dropoff: { uuid: 'recipient', street1: 'Recipient', phone: '456', latitude: 35, longitude: 9 },
            },
        };
        creation.startReturn([{ uuid: 'config' }], original);
        const component = new RouteComponent(this.owner, { draft: creation.draft });
        component.customerPortalOrderCreation = creation;
        assert.true(component.isLinkedReturn);
        assert.deepEqual(component.actionButtons, []);
        await component.setPayloadPlace('pickup', { uuid: 'changed' });
        await component.setPayloadPlace('dropoff', { uuid: 'changed' });
        assert.strictEqual(creation.draft.payload.pickup, original.payload.dropoff);
        assert.strictEqual(creation.draft.payload.dropoff, original.payload.pickup);
        component.confirmReturnAddresses({ target: { checked: true } });
        assert.true(creation.draft.returnAddressesConfirmed);
    });
});
