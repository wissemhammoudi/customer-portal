import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action, setProperties } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { restartableTask, timeout } from 'ember-concurrency';
import { getBrowserCurrentLocation } from '../../utils/current-location';

export default class ModalsPortalOrderPlaceFormComponent extends Component {
    @service fetch;
    @service notifications;
    @service customerPortalOrderRoutePreview;

    @tracked coordinatesInput;
    @tracked lookupResults = [];
    @tracked phones = this.initialPhones();
    @tracked isLocating = false;

    initialPhones() {
        const place = this.args.options?.place ?? {};
        const list = Array.isArray(place.phones) && place.phones.length ? place.phones : [place.phone ?? ''];
        return list.length ? [...list] : [''];
    }

    syncPhones(phones) {
        this.phones = phones;
        const clean = phones.map((value) => String(value ?? '').trim()).filter(Boolean);
        this.place.phones = clean;
        this.place.phone = clean[0] ?? '';
        this.place.primary_phone = clean[0] ?? '';
    }

    @action setPhone(index, value) {
        this.syncPhones(this.phones.map((item, i) => (i === index ? value : item)));
    }

    @action addPhone() {
        this.phones = [...this.phones, ''];
    }

    @action removePhone(index) {
        const next = this.phones.filter((_, i) => i !== index);
        this.syncPhones(next.length ? next : ['']);
    }

    @action makePrimary(index) {
        this.syncPhones([this.phones[index], ...this.phones.filter((_, i) => i !== index)]);
    }

    get place() {
        const place = this.args.options.place;

        if (place && typeof place.setProperties !== 'function') {
            place.setProperties = (properties = {}) => setProperties(place, properties);
        }

        return place;
    }

    get hasLookupResults() {
        return this.lookupResults.length > 0;
    }

    @restartableTask *lookupPlaces(query) {
        if (!query || query.length < 2) {
            this.lookupResults = [];
            return [];
        }

        yield timeout(250);

        const results = yield this.fetch.get('places/lookup', { query }, { namespace: 'customer-portal/int/v1' });
        this.lookupResults = Array.isArray(results) ? results : (results.places ?? []);

        return this.lookupResults;
    }

    @action searchStreet(event) {
        const query = event.target.value;
        this.place.setProperties({ street1: query });
        this.lookupPlaces.perform(query);
    }

    @action onAutocomplete(selected) {
        this.place.setProperties({ ...selected });
        this.lookupResults = [];

        if (this.coordinatesInput && selected.location) {
            this.coordinatesInput.updateCoordinates(selected.location);
        }
    }

    @action async useCurrentLocation() {
        if (this.isLocating) {
            return;
        }

        this.isLocating = true;

        try {
            const { latitude, longitude, accuracy } = await getBrowserCurrentLocation();
            this.customerPortalOrderRoutePreview.showUserLocation(latitude, longitude, accuracy);

            let resolved = {};
            try {
                const response = await this.fetch.get('places/reverse', { latitude, longitude }, { namespace: 'customer-portal/int/v1' });
                if (response?.place && typeof response.place === 'object') {
                    resolved = response.place;
                }
            } catch {
                // Keep raw GPS coordinates even if reverse geocoding is unavailable.
            }

            const location = { type: 'Point', coordinates: [longitude, latitude] };
            this.place.setProperties({
                ...resolved,
                latitude,
                longitude,
                location,
                country: resolved.country || this.place.country || 'TN',
            });
            this.lookupResults = [];

            if (this.coordinatesInput) {
                this.coordinatesInput.updateCoordinates(location);
            }
        } catch (error) {
            this.notifications.warning(error?.message || 'Unable to determine your current location.');
        } finally {
            this.isLocating = false;
        }
    }
}
