import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';

export default class PortalOrderFormPayloadComponent extends Component {
    @service customerPortalOrderCreation;
    @service fetch;
    @service notifications;
    @tracked parcelRevision = 0;
    @tracked savingParcel = false;

    entityTypes = [
        { label: 'Entity', value: 'entity', description: 'Standard generic entity representing an item.' },
        { label: 'Parcel', value: 'parcel', description: 'Standard parcel or package used by parcel-based pricing.' },
        { label: 'Package', value: 'package', description: 'Box, parcel, envelope, or general package.' },
        { label: 'Product', value: 'product', description: 'Sellable product or catalog item.' },
        { label: 'Item', value: 'item', description: 'Generic inventory item when no stronger type applies.' },
        { label: 'SKU / Inventory Unit', value: 'sku', description: 'Stock keeping unit or tracked inventory piece.' },
        { label: 'Document', value: 'document', description: 'Paperwork, labels, or documents.' },
        { label: 'Envelope', value: 'envelope', description: 'Flat document mailer or envelope.' },
        { label: 'Box', value: 'box', description: 'Single boxed shipment unit.' },
        { label: 'Carton', value: 'carton', description: 'Single carton, box, or case.' },
        { label: 'Case', value: 'case', description: 'Case-packed goods or packaged case.' },
        { label: 'Bundle', value: 'bundle', description: 'Bundled or strapped items shipped together.' },
        { label: 'Bag', value: 'bag', description: 'Bagged goods, sacks, or pouches.' },
        { label: 'Tote', value: 'tote', description: 'Reusable tote, bin, or container.' },
        { label: 'Crate', value: 'crate', description: 'Rigid crate or caged shipment unit.' },
        { label: 'Pallet', value: 'pallet', description: 'Palletized freight or grouped cargo.' },
        { label: 'Container', value: 'container', description: 'Containerized shipment or storage container.' },
        { label: 'Freight', value: 'freight', description: 'Loose freight or larger shipment unit.' },
        { label: 'Cargo', value: 'cargo', description: 'General cargo not classified more specifically.' },
        { label: 'Equipment', value: 'equipment', description: 'Tools, machines, or operational equipment.' },
        { label: 'Machinery', value: 'machinery', description: 'Industrial machinery or large mechanical unit.' },
        { label: 'Asset', value: 'asset', description: 'Tracked business asset or returnable item.' },
        { label: 'Return', value: 'return', description: 'Returned goods or reverse-logistics item.' },
        { label: 'Sample', value: 'sample', description: 'Sample item for trial, demo, or inspection.' },
        { label: 'Spare Part', value: 'spare_part', description: 'Replacement component or service part.' },
        { label: 'Medical Supply', value: 'medical_supply', description: 'Healthcare, lab, or medical delivery item.' },
        { label: 'Food', value: 'food', description: 'Prepared food, meal, or grocery item.' },
        { label: 'Beverage', value: 'beverage', description: 'Drink, liquid refreshment, or bottled shipment.' },
        { label: 'Retail Goods', value: 'retail_goods', description: 'General consumer or retail merchandise.' },
    ];
    weightUnits = ['kg', 'lb'];
    dimensionUnits = ['cm', 'in'];

    get actionButtons() {
        return [
            {
                text: 'Add Item',
                icon: 'square-plus',
                size: 'xs',
                onClick: this.addEntity,
                wrapperClass: 'portal-order-panel-action-button',
            },
        ];
    }

    @action addEntity() {
        this.customerPortalOrderCreation.addEntity();
    }

    @action addSavedParcel(parcel) {
        const entities = this.args.draft?.payload?.entities ?? [];
        if (entities.length >= 20) return this.notifications.warning('You can add up to 20 parcel lines per order.');
        const onlyEmpty =
            entities.length === 1 &&
            !entities[0].meta?.parcel?.category &&
            [null, undefined, 1, '1'].includes(entities[0].quantity) &&
            ['name', 'description', 'sku', 'type', 'weight', 'length', 'width', 'height'].every((field) => [null, undefined, ''].includes(entities[0][field]));
        this.customerPortalOrderCreation.setPayloadField('entities', [...(onlyEmpty ? [] : entities), structuredClone(parcel)]);
    }

    @action async saveParcel(entity) {
        if (this.savingParcel) return;
        this.savingParcel = true;
        try {
            await this.fetch.post(
                'saved-parcels',
                {
                    name: entity.name,
                    description: entity.description,
                    weight: entity.weight,
                    weight_unit: entity.weight_unit || 'kg',
                    length: entity.length,
                    width: entity.width,
                    height: entity.height,
                    dimensions_unit: entity.dimensions_unit || 'cm',
                    meta: entity.meta,
                },
                { namespace: 'customer-portal/int/v1' }
            );
            this.parcelRevision++;
            this.notifications.success('Parcel saved to your account.');
        } catch (error) {
            this.notifications.serverError(error);
        } finally {
            this.savingParcel = false;
        }
    }

    @action setEntityValue(index, field, value) {
        this.customerPortalOrderCreation.setEntityField(index, field, value?.value ?? value);
    }

    @action setEntityInput(index, field, event) {
        this.customerPortalOrderCreation.setEntityField(index, field, event.target.value);
    }

    @action removeEntity(entity) {
        this.customerPortalOrderCreation.removeEntity(entity);
    }
}
