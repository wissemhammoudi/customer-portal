import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action, setProperties } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { restartableTask, timeout } from 'ember-concurrency';

export default class ModalsPortalOrderPlaceFormComponent extends Component {
    @service fetch;

    @tracked coordinatesInput;
    @tracked lookupResults = [];
    @tracked phones = this.initialPhones();

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
}
