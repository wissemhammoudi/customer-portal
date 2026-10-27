import { valueFor } from './model-access';

export function hasPhone(place) {
    const phone = valueFor(place, 'phone');
    return typeof phone === 'string' && phone.trim().length > 0;
}

export function validPickup(place) {
    const latitude = valueFor(place, 'latitude') ?? valueFor(place, 'location.coordinates.1');
    const longitude = valueFor(place, 'longitude') ?? valueFor(place, 'location.coordinates.0');
    const street = valueFor(place, 'street1') ?? valueFor(place, 'address');
    return Boolean(
        typeof street === 'string' &&
        street.trim() &&
        hasPhone(place) &&
        latitude !== null &&
        latitude !== undefined &&
        latitude !== '' &&
        longitude !== null &&
        longitude !== undefined &&
        longitude !== '' &&
        Number.isFinite(Number(latitude)) &&
        Math.abs(Number(latitude)) <= 90 &&
        Number.isFinite(Number(longitude)) &&
        Math.abs(Number(longitude)) <= 180
    );
}

export function unsupportedOrder(input) {
    const payload = input?.payload ?? input ?? {};
    const delivery = input?.meta?.delivery;
    return Boolean(
        (delivery?.purpose && delivery.purpose !== 'transportation') ||
        delivery?.original_order_uuid ||
        (delivery?.service_level && !['standard', 'express'].includes(delivery.service_level)) ||
        payload.return ||
        payload.waypoints?.length ||
        input?.isMultipleDropoffOrder
    );
}

export function samePickup(first, second) {
    return ['uuid', 'street1', 'phone', 'latitude', 'longitude'].every((key) => String(valueFor(first, key) ?? '') === String(valueFor(second, key) ?? ''));
}
