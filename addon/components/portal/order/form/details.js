import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { debug } from '@ember/debug';

export default class PortalOrderFormDetailsComponent extends Component {
    @service customerPortalOrderCreation;
    @service customFieldsRegistry;
    @service deliveryOptions;

    podOptions = ['scan', 'signature', 'photo'];

    get serviceLevels() {
        return (this.deliveryOptions.catalogue?.service_levels ?? [{ value: 'standard' }]).filter((item) => item.value === 'standard' && item.available !== false).map((item) => item.value);
    }

    get invalidSchedule() {
        const date = this.args.draft?.scheduledAt;
        return Boolean(date && (!Number.isFinite(Date.parse(date)) || Date.parse(date) <= Date.now()));
    }

    @action setPurpose(purpose) {
        this.customerPortalOrderCreation.setPurpose(purpose);
    }

    @action setServiceLevel(serviceLevel) {
        const meta = this.args.draft.meta;
        this.customerPortalOrderCreation.setField('meta', { ...meta, delivery: { ...meta.delivery, service_level: serviceLevel } });
    }

    @action toggleOpening(value) {
        const meta = this.args.draft.meta;
        this.customerPortalOrderCreation.setField('meta', { ...meta, delivery: { ...meta.delivery, opening_allowed: value } });
    }

    get collectCash() {
        return this.customerPortalOrderCreation.draft?.payload?.cod_payment_method === 'cash';
    }

    @action toggleCollectCash() {
        const enabled = !this.collectCash;
        this.customerPortalOrderCreation.setPayloadField('cod_amount', enabled ? '' : null);
        this.customerPortalOrderCreation.setPayloadField('cod_currency', enabled ? 'TND' : null);
        this.customerPortalOrderCreation.setPayloadField('cod_payment_method', enabled ? 'cash' : null);
    }

    @action setCodAmount(event) {
        this.customerPortalOrderCreation.setPayloadField('cod_amount', event.target.value);
    }

    @action async setOrderConfig(orderConfig) {
        this.customerPortalOrderCreation.setField('orderConfig', orderConfig);
        this.customerPortalOrderCreation.setField('customFields', null);

        if (!orderConfig) {
            return;
        }

        try {
            const customFields = await this.customFieldsRegistry.loadSubjectCustomFields.perform(orderConfig);
            this.customerPortalOrderCreation.setField('customFields', customFields);
        } catch (error) {
            debug(`Error loading customer portal order custom fields: ${error.message}`);
        }
    }

    @action setInput(field, event) {
        this.customerPortalOrderCreation.setField(field, event.target.value);
    }

    @action togglePodRequired() {
        const required = !this.customerPortalOrderCreation.draft?.podRequired;
        this.customerPortalOrderCreation.setField('podRequired', required);
        this.customerPortalOrderCreation.setField('podMethod', required ? 'signature' : null);
    }

    @action setPodMethod(podMethod) {
        this.customerPortalOrderCreation.setField('podMethod', podMethod);
    }
}
