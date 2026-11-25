import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { isBlank } from '@ember/utils';
import { validPickup, hasPhone } from '../../../utils/customer-order-policy';

export default class PortalOrderFormComponent extends Component {
    @service customerPortalOrderActions;
    @service customerPortalOrderCreation;
    @service customerPortalOrderValidation;
    @service deliveryOptions;
    @service currentUser;
    @service hostRouter;
    @service notifications;
    @service intl;

    @tracked lastQuotedRevision = null;
    @tracked step = 0;
    @tracked showAdditional = false;

    get stepTitle() {
        return this.intl.t(`customer-ux.${['recipient', 'parcels', 'service', 'review'][this.step]}`);
    }

    get stepNumber() {
        return this.step + 1;
    }

    get canContinue() {
        const payload = this.draft?.payload ?? {};
        if (this.draft?.blockedReason || this.draft?.pickupChanged || this.customerPortalOrderActions.createOrder.isRunning) return false;
        if (this.step === 0) {
            if (this.draft?.meta?.delivery?.original_order_uuid && !this.draft.returnAddressesConfirmed) return false;
            if (this.draft?.isMultipleDropoffOrder) return payload.waypoints?.length >= 2 && payload.waypoints.every((stop) => validPickup(stop.place));
            return validPickup(payload.pickup) && hasPhone(payload.dropoff) && Boolean(payload.dropoff?.street1 || payload.dropoff?.address);
        }
        if (this.step === 1)
            return (
                payload.entities?.length > 0 &&
                payload.entities.every((entity) => {
                    if (typeof this.deliveryOptions.isValidEntity === 'function') return this.deliveryOptions.isValidEntity(entity, true);
                    return this.deliveryOptions.isValidParcel(entity);
                })
            );
        return this.canQuote;
    }

    @action nextStep() {
        if (!this.canContinue || this.step >= 3) {
            this.notifications.warning(this.intl.t('customer-ux.step-help'));
            return;
        }
        this.step++;
    }

    @action previousStep() {
        if (this.step > 0 && !this.customerPortalOrderActions.createOrder.isRunning) this.step--;
    }

    @action toggleAdditional() {
        this.showAdditional = !this.showAdditional;
    }

    get draft() {
        return this.customerPortalOrderCreation.draft ?? this.args.model?.draft;
    }

    get canSubmit() {
        return this.customerPortalOrderValidation.canCreate(this.draft) && !this.isLoadingServiceQuotes && !this.customerPortalOrderActions.createOrder.isRunning;
    }

    get isLoadingServiceQuotes() {
        return this.customerPortalOrderActions.loadServiceQuotes.isRunning;
    }

    get canQuote() {
        return this.customerPortalOrderValidation.canQuote(this.draft);
    }

    get quoteRevision() {
        return this.draft?.quoteRevision;
    }

    get selectedServiceQuoteId() {
        const serviceQuote = this.draft?.serviceQuote;
        return serviceQuote?.uuid ?? serviceQuote?.id ?? serviceQuote;
    }

    get hasServiceQuote() {
        return !isBlank(this.selectedServiceQuoteId);
    }

    @action async initialize() {
        await this.deliveryOptions.load.perform();
        await this.refreshServiceQuotes();
    }

    @action async refreshServiceQuotes() {
        if (!this.canQuote) {
            return;
        }

        const revision = this.quoteRevision;
        if (this.lastQuotedRevision === revision) {
            return;
        }
        this.lastQuotedRevision = revision;
        const draft = this.draft;
        const draftId = this.customerPortalOrderCreation.draftId;
        this.customerPortalOrderCreation.clearServiceQuotes();

        try {
            const serviceQuotes = await this.customerPortalOrderActions.loadServiceQuotes.perform(draft);
            if (this.customerPortalOrderCreation.draftId === draftId && this.draft?.quoteRevision === revision) {
                this.customerPortalOrderCreation.setServiceQuotes(serviceQuotes, revision);
            }
        } catch (error) {
            if (error?.name !== 'TaskCancelation' && this.customerPortalOrderCreation.draftId === draftId && this.draft?.quoteRevision === revision) {
                this.lastQuotedRevision = null;
                this.notifications.serverError(error);
            }
        }
    }

    @action retryServiceQuotes() {
        this.lastQuotedRevision = null;
        return this.refreshServiceQuotes();
    }

    @action cancel() {
        this.customerPortalOrderCreation.reset();
        this.hostRouter.transitionTo('customer-portal.portal.orders.index');
    }

    @action async submit() {
        if (!this.canSubmit) {
            return this.notifications.warning(
                'Complete the route, named parcels and packaging, COD and proof settings. Select a current delivery quote and wait for document uploads to finish.'
            );
        }

        try {
            const order = await this.customerPortalOrderActions.createOrder.perform(this.draft);
            this.notifications.success('Order created.');
            this.customerPortalOrderCreation.reset();
            this.hostRouter.transitionTo('customer-portal.portal.orders.details', this.customerPortalOrderActions.identifier(order));
            return order;
        } catch (error) {
            this.notifications.serverError(error);
        }
    }
}
