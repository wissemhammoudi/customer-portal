import Service from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { arrayFor, valueFor } from '../utils/model-access';
import { samePickup, unsupportedOrder } from '../utils/customer-order-policy';

export default class CustomerPortalOrderCreationService extends Service {
    @tracked draft;
    @tracked routePreview = [];
    pendingReturnOrder = null;
    accountPickup = null;
    draftId = 0;

    rememberCheckoutRedirect(params) {
        const query = Object.fromEntries(
            ['checkout_draft', 'checkout_session_id', 'service_quote', 'creating']
                .filter((key) => typeof params[key] === 'string' && params[key].length <= 512)
                .map((key) => [key, params[key]])
        );
        if (query.checkout_draft) window.sessionStorage.setItem('customer-portal:checkout-redirect', JSON.stringify(query));
    }

    getCheckoutRedirect() {
        const saved = window.sessionStorage.getItem('customer-portal:checkout-redirect');
        if (!saved) return null;
        return JSON.parse(saved);
    }

    takeCheckoutRedirect() {
        const query = this.getCheckoutRedirect();
        window.sessionStorage.removeItem('customer-portal:checkout-redirect');
        return query;
    }

    start(orderConfigs = []) {
        this.draftId++;
        this.pendingReturnOrder = null;
        this.draft = {
            orderConfig: orderConfigs[0],
            meta: {
                delivery: {
                    purpose: 'transportation',
                    service_level: 'standard',
                    opening_allowed: false,
                },
            },
            returnAddressesConfirmed: false,
            payload: {
                pickup: this.accountPickup,
                dropoff: null,
                return: null,
                waypoints: [],
                entities: [],
                cod_amount: null,
                cod_currency: null,
                cod_payment_method: null,
            },
            podRequired: false,
            podMethod: null,
            scheduledAt: null,
            notes: null,
            serviceQuote: null,
            serviceRates: [],
            serviceQuotes: [],
            quoteRevision: 0,
            quotedRevision: null,
            uploadsPending: 0,
            paymentConfig: null,
            purchaseRate: null,
            files: [],
            customFields: null,
            isMultipleDropoffOrder: false,
        };
        this.routePreview = [];

        return this.draft;
    }

    reset() {
        this.draftId++;
        this.draft = null;
        this.routePreview = [];
    }

    restoreCheckoutDraft(saved, orderConfigs, restoreQuote = false) {
        const input = saved.input;
        const orderConfig = orderConfigs.find((item) => [valueFor(item, 'uuid'), valueFor(item, 'id'), valueFor(item, 'public_id')].includes(input.order_config));
        if (!orderConfig) throw new Error('The saved delivery workflow is no longer available.');
        this.start(orderConfigs);
        const intermediate = input.waypoints ?? [];
        const waypoints = intermediate.length && input.pickup && input.dropoff ? [{ ...input.pickup, type: 'pickup' }, ...intermediate, { ...input.dropoff, type: 'dropoff' }] : intermediate;
        const serviceQuote = restoreQuote && input.service_quote_uuid ? { uuid: input.service_quote_uuid } : null;
        this.draft = {
            ...this.draft,
            orderConfig,
            checkoutDraftUuid: saved.uuid,
            meta: input.meta,
            notes: input.notes,
            internalId: input.internal_id,
            scheduledAt: input.scheduled_at,
            podRequired: input.pod_required,
            podMethod: input.pod_method,
            returnAddressesConfirmed: input.return_addresses_confirmed === true,
            isMultipleDropoffOrder: waypoints.length > 0,
            payload: {
                pickup: input.pickup,
                dropoff: input.dropoff,
                return: input.return,
                waypoints: waypoints.map((stop) => ({ place: stop.place ?? stop, type: stop.type ?? 'dropoff' })),
                entities: input.entities ?? [],
                cod_amount: input.cod_amount,
                cod_currency: input.cod_currency,
                cod_payment_method: input.cod_payment_method,
            },
            files: (input.files ?? []).map((uuid) => ({ uuid, original_filename: 'Saved checkout document' })),
            serviceQuote,
            serviceQuotes: serviceQuote ? [serviceQuote] : [],
            quotedRevision: serviceQuote ? 0 : null,
        };
        if (unsupportedOrder(input)) {
            this.draft = {
                ...this.draft,
                blockedReason:
                    'This saved draft contains a return, unsupported service, or intermediate stops. It cannot be submitted. Start a new transportation order; the saved draft has not been changed.',
            };
        } else if (!samePickup(input.pickup, this.accountPickup)) {
            this.draft = { ...this.draft, pickupChanged: true, serviceQuote: null, serviceQuotes: [], quotedRevision: null };
        }
        return this.draft;
    }

    @action acknowledgePickupChange() {
        this.draft = { ...this.draft, pickupChanged: false };
        this.setPayloadField('pickup', this.accountPickup);
    }

    @action setField(field, value) {
        this.draft = { ...this.draft, [field]: value };
        this.invalidateQuotesForField(field);
    }

    @action setPayloadField(field, value) {
        this.draft = {
            ...this.draft,
            payload: {
                ...(this.draft?.payload ?? {}),
                [field]: value,
            },
        };
        if (['pickup', 'dropoff', 'waypoints'].includes(field)) {
            this.draft = { ...this.draft, returnAddressesConfirmed: false };
        }
        this.invalidateQuotesForField(field);
    }

    @action toggleMultiDrop(isMultipleDropoffOrder = !this.draft?.isMultipleDropoffOrder) {
        const payload = this.draft?.payload ?? {};
        let nextPayload = { ...payload };

        if (isMultipleDropoffOrder) {
            const waypoints = payload.waypoints?.length ? payload.waypoints : this.waypointsFromPickupDropoff(payload);
            nextPayload = {
                ...nextPayload,
                pickup: null,
                dropoff: null,
                waypoints: this.ensureRequiredWaypoints(waypoints),
            };
        } else {
            const pickup = this.firstWaypointByType(payload.waypoints, 'pickup')?.place ?? payload.waypoints?.[0]?.place ?? null;
            const dropoff = this.firstWaypointByType(payload.waypoints, 'dropoff')?.place ?? payload.waypoints?.[1]?.place ?? null;
            nextPayload = {
                ...nextPayload,
                pickup,
                dropoff,
                waypoints: [],
            };
        }

        this.draft = { ...this.draft, isMultipleDropoffOrder, payload: nextPayload };
        this.draft = { ...this.draft, returnAddressesConfirmed: false };
        this.invalidateServiceQuotes();
    }

    @action addWaypoint() {
        this.setPayloadField('waypoints', [...(this.draft?.payload?.waypoints ?? []), { place: null, type: 'dropoff' }]);
    }

    @action setWaypoint(index, place) {
        const waypoints = [...(this.draft?.payload?.waypoints ?? [])];
        waypoints[index] = { ...(waypoints[index] ?? {}), place, type: waypoints[index]?.type ?? this.defaultWaypointType(index) };
        this.setPayloadField('waypoints', waypoints);
    }

    @action setWaypointType(index, type) {
        const waypoints = [...(this.draft?.payload?.waypoints ?? [])];
        waypoints[index] = { ...(waypoints[index] ?? {}), type };
        this.setPayloadField('waypoints', waypoints);
    }

    @action sortWaypoints(sourceIndex, targetIndex) {
        if (sourceIndex === targetIndex || sourceIndex < 0 || targetIndex < 0) {
            return;
        }

        const waypoints = [...(this.draft?.payload?.waypoints ?? [])];
        const [waypoint] = waypoints.splice(sourceIndex, 1);
        waypoints.splice(targetIndex, 0, waypoint);
        this.setPayloadField('waypoints', waypoints);
    }

    @action removeWaypoint(index) {
        if (index < 2) {
            return;
        }

        const waypoints = [...(this.draft?.payload?.waypoints ?? [])];
        waypoints.splice(index, 1);
        this.setPayloadField('waypoints', waypoints);
    }

    @action addEntity() {
        this.setPayloadField('entities', [
            ...(this.draft?.payload?.entities ?? []),
            {
                name: null,
                sku: null,
                type: null,
                description: null,
                weight: null,
                weight_unit: 'kg',
                length: null,
                width: null,
                height: null,
                dimensions_unit: 'cm',
            },
        ]);
    }

    @action setEntityField(index, field, value) {
        const entities = [...(this.draft?.payload?.entities ?? [])];
        entities[index] = { ...(entities[index] ?? {}), [field]: value };
        this.setPayloadField('entities', entities);
    }

    @action removeEntity(entity) {
        this.setPayloadField(
            'entities',
            (this.draft?.payload?.entities ?? []).filter((candidate) => candidate !== entity)
        );
    }

    setServiceQuotes(serviceQuotes = [], revision = this.draft?.quoteRevision) {
        if (!this.draft || revision !== this.draft.quoteRevision) return;
        const quotes = arrayFor(serviceQuotes);
        const selected = quotes.length ? [...quotes].sort((a, b) => Number(valueFor(a, 'amount', 0)) - Number(valueFor(b, 'amount', 0)))[0] : null;

        this.draft = {
            ...this.draft,
            serviceQuotes: quotes,
            serviceQuote: selected,
            quotedRevision: revision,
        };
    }

    clearServiceQuotes() {
        if (!this.draft) return;
        this.draft = { ...this.draft, serviceQuotes: [], serviceQuote: null, purchaseRate: null, quotedRevision: null };
    }

    invalidateServiceQuotes() {
        if (!this.draft) {
            return;
        }

        this.draft = {
            ...this.draft,
            serviceQuotes: [],
            serviceQuote: null,
            purchaseRate: null,
            quotedRevision: null,
            quoteRevision: (this.draft.quoteRevision ?? 0) + 1,
        };
    }

    invalidateQuotesForField(field) {
        if (
            [
                'orderConfig',
                'scheduledAt',
                'pickup',
                'dropoff',
                'return',
                'waypoints',
                'entities',
                'meta',
                'returnAddressesConfirmed',
                'cod_amount',
                'cod_currency',
                'cod_payment_method',
            ].includes(field)
        ) {
            this.invalidateServiceQuotes();
        }
    }

    updateRoutePreview(coordinates = []) {
        this.routePreview = coordinates;
    }

    defaultWaypointType(index) {
        return index === 0 ? 'pickup' : 'dropoff';
    }

    waypointsFromPickupDropoff(payload = {}) {
        return [
            { place: payload.pickup ?? null, type: 'pickup' },
            { place: payload.dropoff ?? null, type: 'dropoff' },
        ];
    }

    ensureRequiredWaypoints(waypoints = []) {
        const normalized = waypoints.map((waypoint, index) => ({
            ...waypoint,
            type: waypoint?.type ?? this.defaultWaypointType(index),
        }));

        while (normalized.length < 2) {
            normalized.push({ place: null, type: this.defaultWaypointType(normalized.length) });
        }

        normalized[0] = { ...normalized[0], type: normalized[0].type ?? 'pickup' };
        normalized[1] = { ...normalized[1], type: normalized[1].type ?? 'dropoff' };

        return normalized;
    }

    firstWaypointByType(waypoints = [], type) {
        return waypoints.find((waypoint) => waypoint?.type === type && waypoint?.place);
    }
}
