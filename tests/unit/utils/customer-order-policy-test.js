import { module, test } from 'qunit';
import { hasPhone, samePickup, unsupportedOrder, validPickup } from '@fleetbase/customer-portal-engine/utils/customer-order-policy';

module('Unit | Utils | customer order policy', function () {
    test('pickup requires street, phone and valid coordinates including zero', function (assert) {
        const place = { street1: 'Warehouse', phone: '+21612345678', latitude: 0, longitude: 0 };
        assert.true(validPickup(place));
        assert.false(validPickup({ ...place, phone: ' ' }));
        assert.false(validPickup({ ...place, street1: ' ' }));
        assert.false(validPickup({ ...place, latitude: '' }));
        assert.false(validPickup({ ...place, longitude: 181 }));
        assert.true(validPickup({ street1: 'Warehouse', phone: '123', location: { coordinates: [10, 36] } }));
        assert.false(hasPhone({ phone: ' ' }));
    });

    test('hidden route or return data never becomes a supported new order', function (assert) {
        assert.false(unsupportedOrder({ meta: { delivery: { purpose: 'transportation', service_level: 'standard' } } }));
        assert.false(unsupportedOrder({ meta: { delivery: { service_level: 'express' } } }));
        assert.true(unsupportedOrder({ meta: { delivery: { purpose: 'return' } } }));
        assert.true(unsupportedOrder({ meta: { delivery: { original_order_uuid: 'old-order' } } }));
        assert.true(unsupportedOrder({ return: { street1: 'Warehouse' } }));
        assert.true(unsupportedOrder({ payload: { waypoints: [{ place: 'a' }] } }));
        assert.true(unsupportedOrder({ meta: { delivery: { service_level: 'overnight' } } }));
    });

    test('changed account pickup requires acknowledgement even for same record', function (assert) {
        const first = { uuid: 'account-pickup', street1: 'Warehouse', phone: '123', latitude: 36, longitude: 10 };
        assert.true(samePickup(first, { ...first }));
        assert.false(samePickup(first, { ...first, phone: '456' }));
        assert.false(samePickup(first, { ...first, latitude: 37 }));
        assert.false(samePickup(first, null));
    });
});
