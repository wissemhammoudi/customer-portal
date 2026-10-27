import Service, { inject as service } from '@ember/service';
import { valueFor } from '../utils/model-access';
import { hasPhone, unsupportedOrder, validPickup } from '../utils/customer-order-policy';

export default class CustomerPortalOrderValidationService extends Service {
    @service deliveryOptions;

    canCreate(draft) {
        const quote = draft?.serviceQuote;
        const id = quote?.uuid ?? quote?.id ?? quote;
        return Boolean(this.canQuote(draft) && id && draft.serviceQuotes?.includes(quote) && draft.quotedRevision === draft.quoteRevision && !draft.uploadsPending);
    }

    canQuote(draft) {
        if (!draft?.orderConfig) {
            return false;
        }
        if (draft.blockedReason || draft.pickupChanged || unsupportedOrder(draft) || !validPickup(draft.payload?.pickup) || !hasPhone(draft.payload?.dropoff)) {
            return false;
        }

        const required = Boolean(draft.meta?.delivery);
        if (draft.meta?.delivery?.service_level === 'express') {
            return false;
        }
        if (draft.meta?.delivery?.purpose === 'return' && draft.meta.delivery.original_order_uuid && !draft.returnAddressesConfirmed) {
            return false;
        }
        const entities = draft.payload?.entities ?? [];
        if ((required && (!this.deliveryOptions.catalogue || !entities.length)) || !entities.every((entity) => this.deliveryOptions.isValidEntity(entity, required))) {
            return false;
        }
        if (draft.scheduledAt && (!Number.isFinite(Date.parse(draft.scheduledAt)) || Date.parse(draft.scheduledAt) <= Date.now())) return false;
        if (draft.podRequired && !['scan', 'signature', 'photo'].includes(draft.podMethod)) return false;
        const payload = draft.payload ?? {};
        if (
            (payload.cod_amount != null || payload.cod_currency || payload.cod_payment_method) &&
            !this.deliveryOptions.isValidCod(payload.cod_amount, payload.cod_currency, payload.cod_payment_method)
        )
            return false;

        if (draft.isMultipleDropoffOrder) {
            const stops = draft.payload?.waypoints ?? [];
            return stops.length >= 2 && stops.every((waypoint) => this.hasPlace(waypoint?.place) && ['pickup', 'dropoff'].includes(waypoint.type));
        }

        return this.hasPlace(draft.payload?.pickup) && this.hasPlace(draft.payload?.dropoff);
    }

    hasPlace(place) {
        return Boolean(valueFor(place, 'uuid') || valueFor(place, 'id') || valueFor(place, 'public_id') || valueFor(place, 'street1')?.trim() || valueFor(place, 'address')?.trim());
    }
}
