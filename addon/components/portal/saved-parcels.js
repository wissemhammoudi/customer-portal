import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';

const API = { namespace: 'customer-portal/int/v1' };

export default class PortalSavedParcelsComponent extends Component {
    @service fetch;
    @service notifications;
    @tracked parcels = [];
    @tracked nextPage = null;
    @tracked busy = false;
    @tracked loading = false;
    @tracked error = null;
    @tracked quantity = '1';
    @tracked editing = null;
    @tracked query = '';

    get filteredParcels() {
        const query = this.query.trim().toLocaleLowerCase();
        return this.parcels.filter(({ parcel }) => `${parcel.name ?? ''} ${parcel.description ?? ''}`.toLocaleLowerCase().includes(query));
    }

    @action setQuery(event) {
        this.query = event.target.value;
    }

    @action create() {
        this.editing = { name: '', weight_unit: 'kg', dimensions_unit: 'cm' };
    }

    @action async load() {
        this.loading = true;
        this.error = null;
        try {
            const result = await this.fetch.get('saved-parcels', {}, API);
            if (!Array.isArray(result.parcels)) throw new Error('Saved parcels could not be loaded. Please try again.');
            if (this.isDestroying || this.isDestroyed) return;
            this.parcels = result.parcels;
            this.nextPage = result.next_page;
        } catch (error) {
            if (!this.isDestroying && !this.isDestroyed) this.error = error;
            this.notifications.serverError(error);
        } finally {
            if (!this.isDestroying && !this.isDestroyed) this.loading = false;
        }
    }

    @action async more() {
        if (this.loading || !this.nextPage) return;
        this.loading = true;
        try {
            const result = await this.fetch.get('saved-parcels', { page: this.nextPage }, API);
            if (!Array.isArray(result.parcels)) throw new Error('Saved parcels could not be loaded. Please try again.');
            this.parcels = [...this.parcels, ...result.parcels];
            this.nextPage = result.next_page;
        } catch (error) {
            this.notifications.serverError(error);
        } finally {
            this.loading = false;
        }
    }

    @action setQuantity(event) {
        this.quantity = event.target.value;
    }

    @action select(template) {
        const quantity = Number(this.quantity);
        if (!/^[1-9]\d*$/.test(this.quantity) || !Number.isSafeInteger(quantity)) {
            return this.notifications.warning('Choose a positive whole-number quantity.');
        }
        this.args.onSelect?.({ ...structuredClone(template.parcel), quantity });
    }

    @action edit(template) {
        this.editing = { uuid: template.uuid, ...structuredClone(template.parcel) };
    }

    @action setField(field, event) {
        this.editing = { ...this.editing, [field]: event.target.value };
    }

    @action setMeta(meta) {
        this.editing = { ...this.editing, meta };
    }

    @action cancel() {
        this.editing = null;
    }

    @action async save() {
        if (this.busy || !this.editing) return;
        this.busy = true;
        try {
            const { uuid, ...parcel } = this.editing;
            if (!parcel.name?.trim()) {
                this.notifications.warning('Enter a parcel name.');
                return;
            }
            if (uuid) {
                await this.fetch.put(`saved-parcels/${encodeURIComponent(uuid)}`, parcel, API);
            } else {
                await this.fetch.post('saved-parcels', parcel, API);
            }
            this.editing = null;
            this.notifications.success(uuid ? 'Saved parcel updated.' : 'Saved parcel created.');
            await this.load();
        } catch (error) {
            this.notifications.serverError(error);
        } finally {
            this.busy = false;
        }
    }

    @action async remove(template) {
        if (this.busy || !window.confirm('Delete this saved parcel? Existing orders will not change.')) return;
        this.busy = true;
        try {
            await this.fetch.delete(`saved-parcels/${encodeURIComponent(template.uuid)}`, {}, API);
            if (this.editing?.uuid === template.uuid) this.editing = null;
            this.notifications.success('Saved parcel deleted.');
            await this.load();
        } catch (error) {
            this.notifications.serverError(error);
        } finally {
            this.busy = false;
        }
    }
}
