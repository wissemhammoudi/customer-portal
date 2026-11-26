import Service from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { OSRMv1, Control as RoutingControl } from '@fleetbase/leaflet-routing-machine';
import getRoutingHost from '@fleetbase/ember-core/utils/get-routing-host';

const DEFAULT_FIT_PADDING_BOTTOM_RIGHT = [520, 0];
const SINGLE_POINT_PAN_BY = [260, 0];
const SINGLE_POINT_ZOOM = 18;
const TWO_POINT_MAX_ZOOM = 13;
const MULTI_POINT_MAX_ZOOM = 12;

export default class CustomerPortalOrderRoutePreviewService extends Service {
    @tracked map;
    @tracked route;
    @tracked routePoints = [];
    @tracked selectedOrderRoutePoints = [];
    @tracked routeCoordinates = [];
    @tracked routingError;
    @tracked userLocation = null;
    routingControl;
    userLocationLayer = null;
    signature;

    @action registerMap(eventOrMap) {
        const map = eventOrMap?.target ?? eventOrMap;

        if (!map) {
            return;
        }

        this.map = map;
        if (this.userLocation) {
            this.renderUserLocation(this.userLocation, false);
        }
        requestAnimationFrame(() => map.invalidateSize());
    }

    @action unregisterMap() {
        this.removeUserLocationLayer();
        this.clear();
        this.map = null;
    }

    @action showUserLocation(latitude, longitude, accuracy = null) {
        const next = {
            latitude: Number(latitude),
            longitude: Number(longitude),
            accuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
        };

        if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) {
            return;
        }

        this.userLocation = next;
        this.renderUserLocation(next, true);
    }

    renderUserLocation(location, centerMap = true) {
        const L = globalThis.L;

        if (!this.map || !L) {
            return;
        }

        this.removeUserLocationLayer();

        const radius = Math.min(Math.max(location.accuracy ?? 45, 25), 250);
        const layer = L.layerGroup();

        if (typeof L.circle === 'function') {
            L.circle([location.latitude, location.longitude], {
                radius,
                color: '#2563eb',
                weight: 1,
                fillColor: '#2563eb',
                fillOpacity: 0.14,
                interactive: false,
            }).addTo(layer);
        }

        if (typeof L.circleMarker === 'function') {
            L.circleMarker([location.latitude, location.longitude], {
                radius: 8,
                color: '#ffffff',
                weight: 3,
                fillColor: '#2563eb',
                fillOpacity: 1,
            })
                .bindTooltip('Your location', { direction: 'top', offset: [0, -8] })
                .addTo(layer);
        }

        layer.addTo(this.map);
        this.userLocationLayer = layer;

        if (centerMap && typeof this.map.flyTo === 'function') {
            const zoom = Math.max(this.map.getZoom?.() ?? 11, 15);
            this.map.flyTo([location.latitude, location.longitude], zoom, { animate: true, duration: 0.5 });
        }
    }

    removeUserLocationLayer() {
        if (this.userLocationLayer) {
            this.userLocationLayer.clearLayers?.();
            this.userLocationLayer.remove?.();
            this.userLocationLayer = null;
        }
    }

    get centerCoordinates() {
        const center = this.map?.getCenter?.();

        if (!center) {
            return null;
        }

        return {
            latitude: center.lat,
            longitude: center.lng,
        };
    }

    updateDraft(draft) {
        const routePoints = this.routePointsFromDraft(draft);
        const routeCoordinates = routePoints.map((point) => point.coordinates);
        const signature = `draft:${JSON.stringify(routeCoordinates)}`;

        this.routePoints = routePoints;
        this.routeCoordinates = routeCoordinates;

        if (!this.map || signature === this.signature) {
            return;
        }

        this.signature = signature;

        if (routeCoordinates.length === 0) {
            this.clear();
            return;
        }

        this.focusRoute(routeCoordinates);

        if (routeCoordinates.length < 2) {
            this.removeRoutingControl();
            return;
        }

        this.previewRoute(draft, routeCoordinates);
    }

    updateSelectedOrder(order) {
        const routePoints = this.routePointsFromOrder(order);
        const routeCoordinates = routePoints.map((point) => point.coordinates);
        const signature = `order:${order?.uuid ?? order?.public_id ?? order?.id ?? 'none'}:${JSON.stringify(routeCoordinates)}`;

        this.selectedOrderRoutePoints = routePoints;

        if (!this.map || signature === this.signature) {
            return;
        }

        this.signature = signature;

        if (routeCoordinates.length === 0) {
            this.clearSelectedOrder();
            return;
        }

        this.focusRoute(routeCoordinates, { paddingBottomRight: [560, 0] });

        if (routeCoordinates.length < 2) {
            this.removeRoutingControl();
            return;
        }

        this.previewRouteFromOrder(order, routeCoordinates);
    }

    clearSelectedOrder() {
        this.selectedOrderRoutePoints = [];

        if (this.signature?.startsWith?.('order:')) {
            this.clear();
        }
    }

    routePointsFromDraft(draft) {
        const payload = draft?.payload;

        if (!payload) {
            return [];
        }

        if (draft?.isMultipleDropoffOrder) {
            return (payload.waypoints ?? []).map((waypoint, index) => this.routePointFromPlace(waypoint.place, waypoint.type ?? this.defaultWaypointType(index), index)).filter(Boolean);
        }

        return [this.routePointFromPlace(payload.pickup, 'pickup', 0), this.routePointFromPlace(payload.dropoff, 'dropoff', 1), this.routePointFromPlace(payload.return, 'return', 2)].filter(
            Boolean
        );
    }

    routePointsFromOrder(order) {
        const payload = order?.payload;

        if (!payload) {
            return [];
        }

        const points = [];

        if (payload.pickup) {
            points.push(this.routePointFromPlace(payload.pickup, 'pickup', 0, 'selected'));
        }

        (payload.waypoints ?? []).forEach((waypoint, index) => {
            points.push(this.routePointFromPlace(waypoint.place ?? waypoint, waypoint.type ?? 'waypoint', points.length, 'selected', index + 1));
        });

        if (payload.dropoff) {
            points.push(this.routePointFromPlace(payload.dropoff, 'dropoff', points.length, 'selected'));
        }

        if (payload.return) {
            points.push(this.routePointFromPlace(payload.return, 'return', points.length, 'selected'));
        }

        return points.filter(Boolean);
    }

    routePointFromPlace(place, type, index, source = 'draft', stopNumber = null) {
        const coordinates = this.coordinatesFromPlace(place);

        if (!coordinates) {
            return null;
        }

        return {
            id: `${source}-${type}-${index}`,
            place,
            type,
            label: this.labelForType(type, index, stopNumber),
            index,
            coordinates,
        };
    }

    coordinatesFromPlace(place) {
        const subject = place?.place ?? place;
        const latlng = subject?.latlng;
        const locationCoordinates = subject?.location?.coordinates ?? subject?.coordinates?.coordinates;
        const longitudeFirstCoordinates = Array.isArray(locationCoordinates) && locationCoordinates.length >= 2 ? [locationCoordinates[1], locationCoordinates[0]] : null;
        const latlngCoordinates = Array.isArray(latlng) && latlng.length >= 2 ? [latlng[0], latlng[1]] : null;
        const latitude = Number(subject?.latitude ?? subject?.lat ?? latlngCoordinates?.[0] ?? longitudeFirstCoordinates?.[0]);
        const longitude = Number(subject?.longitude ?? subject?.lng ?? latlngCoordinates?.[1] ?? longitudeFirstCoordinates?.[1]);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return null;
        }

        return [latitude, longitude];
    }

    focusRoute(routeCoordinates, options = {}) {
        if (!this.map || !routeCoordinates.length) {
            return;
        }

        if (routeCoordinates.length === 1) {
            this.map.flyTo(routeCoordinates[0], SINGLE_POINT_ZOOM, { animate: true, duration: 0.5 });
            this.map.once('moveend', () => this.map?.panBy(options.panBy ?? SINGLE_POINT_PAN_BY));
            return;
        }

        this.map.flyToBounds(routeCoordinates, {
            paddingBottomRight: options.paddingBottomRight ?? DEFAULT_FIT_PADDING_BOTTOM_RIGHT,
            maxZoom: routeCoordinates.length === 2 ? TWO_POINT_MAX_ZOOM : MULTI_POINT_MAX_ZOOM,
            animate: true,
        });
    }

    previewRoute(draft, routeCoordinates) {
        this.removeRoutingControl();

        const waypoints = routeCoordinates.map((coordinates) => this.latLng(coordinates));
        const router = new OSRMv1({
            serviceUrl: `${getRoutingHost(this.routingPayloadFromDraft(draft), this.routingWaypointsFromDraft(draft))}/route/v1`,
            profile: 'driving',
        });

        this.routingControl = new RoutingControl({
            router,
            waypoints,
            alternativeClassName: 'hidden',
            addWaypoints: false,
            routeWhileDragging: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,
            show: false,
            createMarker: () => null,
            lineOptions: {
                styles: [
                    { color: '#3485e2', opacity: 0.25, weight: 8 },
                    { color: '#3485e2', opacity: 0.9, weight: 4 },
                ],
            },
        }).addTo(this.map);

        this.routingControl.on('routesfound', ({ routes }) => {
            this.route = routes?.[0] ?? null;
            this.routingError = null;
            this.focusRoute(routeCoordinates);
        });

        this.routingControl.on('routingerror', (error) => {
            this.route = null;
            this.routingError = error;
        });
    }

    previewRouteFromOrder(order, routeCoordinates) {
        this.removeRoutingControl();

        const waypoints = routeCoordinates.map((coordinates) => this.latLng(coordinates));
        const router = new OSRMv1({
            serviceUrl: `${getRoutingHost(order?.payload ?? {}, order?.payload?.waypoints ?? [])}/route/v1`,
            profile: 'driving',
        });

        this.routingControl = new RoutingControl({
            router,
            waypoints,
            alternativeClassName: 'hidden',
            addWaypoints: false,
            routeWhileDragging: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,
            show: false,
            createMarker: () => null,
            lineOptions: {
                styles: [
                    { color: '#1d4ed8', opacity: 0.24, weight: 8 },
                    { color: '#3485e2', opacity: 0.95, weight: 4 },
                ],
            },
        }).addTo(this.map);

        this.routingControl.on('routesfound', ({ routes }) => {
            this.route = routes?.[0] ?? null;
            this.routingError = null;
            this.focusRoute(routeCoordinates, { paddingBottomRight: [560, 0] });
        });

        this.routingControl.on('routingerror', (error) => {
            this.route = null;
            this.routingError = error;
        });
    }

    clear() {
        this.removeRoutingControl();
        this.route = null;
        this.routingError = null;
        this.routePoints = [];
        this.selectedOrderRoutePoints = [];
        this.routeCoordinates = [];
        this.signature = null;
    }

    removeRoutingControl() {
        if (this.routingControl && typeof this.routingControl.remove === 'function') {
            this.routingControl.remove();
        }

        this.routingControl = null;
    }

    labelForType(type, index, stopNumber = null) {
        if (type === 'pickup') {
            return 'Pickup';
        }

        if (type === 'return') {
            return 'Return';
        }

        if (type === 'dropoff' && index <= 1) {
            return 'Dropoff';
        }

        return `Stop ${stopNumber ?? index + 1}`;
    }

    defaultWaypointType(index) {
        return index === 0 ? 'pickup' : 'dropoff';
    }

    latLng(coordinates) {
        const L = globalThis.L;

        if (L?.latLng) {
            return L.latLng(coordinates[0], coordinates[1]);
        }

        return coordinates;
    }

    routingPayloadFromDraft(draft) {
        const payload = draft?.payload ?? {};

        if (!draft?.isMultipleDropoffOrder) {
            return payload;
        }

        const pickup = this.firstWaypointByType(payload.waypoints, 'pickup')?.place ?? payload.waypoints?.[0]?.place;
        const dropoff = this.firstWaypointByType(payload.waypoints, 'dropoff')?.place ?? payload.waypoints?.[1]?.place;

        return {
            ...payload,
            pickup,
            dropoff,
        };
    }

    routingWaypointsFromDraft(draft) {
        if (!draft?.isMultipleDropoffOrder) {
            return draft?.payload?.waypoints ?? [];
        }

        return (draft?.payload?.waypoints ?? []).map((waypoint) => waypoint.place).filter(Boolean);
    }

    firstWaypointByType(waypoints = [], type) {
        return waypoints.find((waypoint) => waypoint?.type === type && waypoint?.place);
    }
}
