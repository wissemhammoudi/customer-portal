import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { later } from '@ember/runloop';
import { timeout } from 'ember-concurrency';
import { isBlank } from '@ember/utils';
import config from 'ember-get-config';

export default class PortalOrderFormComponent extends Component {
    @service customerPortalOrderActions;
    @service customerPortalOrderCreation;
    @service customerPortalOrderValidation;
    @service deliveryOptions;
    @service customerPayment;
    @service currentUser;
    @service hostRouter;
    @service modalsManager;
    @service notifications;
    @service urlSearchParams;

    @tracked lastQuotedRevision = null;
    @tracked checkoutStarting = false;

    get draft() {
        return this.customerPortalOrderCreation.draft ?? this.args.model?.draft;
    }

    get canSubmit() {
        return this.customerPortalOrderValidation.canCreate(this.draft) && !this.checkoutStarting && !this.isLoadingServiceQuotes && !this.customerPortalOrderActions.createOrder.isRunning;
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

    get paymentConfig() {
        return this.draft?.paymentConfig ?? {};
    }

    get selectedServiceQuoteId() {
        const serviceQuote = this.draft?.serviceQuote;
        return serviceQuote?.uuid ?? serviceQuote?.id ?? serviceQuote;
    }

    get isPaymentRequired() {
        const hasServiceQuote = !isBlank(this.selectedServiceQuoteId);
        const stripeConfigured = typeof config.stripe?.publishableKey === 'string';
        const paymentsEnabled = this.paymentConfig.paymentsEnabled === true;
        const paymentsOnboardCompleted = this.paymentConfig.paymentsOnboardCompleted === true;

        return hasServiceQuote && stripeConfigured && paymentsEnabled && paymentsOnboardCompleted;
    }

    @action async initialize() {
        try {
            const paymentConfig = await this.customerPortalOrderActions.loadPaymentConfig.perform();
            this.customerPortalOrderCreation.setField('paymentConfig', paymentConfig ?? {});

            if (this.shouldInitializeStripe(paymentConfig)) {
                await this.customerPayment.loadAndInitialize();
            }
        } catch (error) {
            this.notifications.serverError(error);
        }

        await this.deliveryOptions.load.perform();
        await this.checkForCheckoutSession();
        await this.refreshServiceQuotes();
    }

    @action async refreshServiceQuotes() {
        if (!this.canQuote || this.urlSearchParams.has('checkout_session_id')) {
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
        if (this.urlSearchParams.has('checkout_session_id') && !this.draft?.purchaseRate) {
            return this.checkForCheckoutSession();
        }
        if (!this.canSubmit) {
            return this.notifications.warning(
                'Complete the route, named parcels and packaging, COD and proof settings. Select a current delivery quote and wait for document uploads to finish.'
            );
        }

        if (this.isPaymentRequired && !this.draft?.purchaseRate) {
            return this.startCheckoutSession();
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

    async startCheckoutSession() {
        if (this.checkoutStarting) return;
        this.checkoutStarting = true;
        try {
            const { draft: saved } = await this.customerPortalOrderActions.saveCheckoutDraft(this.draft);
            this.customerPortalOrderCreation.setField('checkoutDraftUuid', saved.uuid);
            const url = new URL(window.location.href);
            url.searchParams.set('checkout_draft', saved.uuid);
            window.history.replaceState(window.history.state, '', url);
            this.saveCurrentOrderForCurrentServiceQuote(this.draft.serviceQuote);
            await this.customerPayment.loadAndInitialize();
            const checkout = await this.customerPayment.initEmbeddedCheckout({
                fetchClientSecret: this.fetchClientSecret.bind(this),
            });
            const serviceQuote = this.draft.serviceQuote;

            this.saveCurrentOrderForCurrentServiceQuote(serviceQuote);
            await this.modalsManager.done();
            later(
                this,
                () => {
                    this.modalsManager.show('modals/service-quote-purchase-form', {
                        title: `Complete Payment for ${this.draft.orderConfig?.name ?? 'Order'} Service`,
                        modalClass: 'service-quote-extension-purchase',
                        modalFooterClass: 'hidden-i',
                        serviceQuote,
                        checkoutElementInserted: (el) => checkout.mount(el),
                        decline: async (modal) => {
                            checkout.destroy();
                            await modal.done();
                        },
                    });
                },
                100
            );
        } catch (error) {
            this.notifications.serverError(error, 'Unable to initialize secure checkout. Please try again.');
        } finally {
            this.checkoutStarting = false;
        }
    }

    async fetchClientSecret() {
        const uri = `${window.location.pathname}?checkout_draft=${encodeURIComponent(this.draft.checkoutDraftUuid)}`;
        const { clientSecret } = await this.customerPortalOrderActions.createStripeCheckoutSession.perform(this.draft.serviceQuote, uri);
        return clientSecret;
    }

    async checkForCheckoutSession() {
        if (!this.urlSearchParams.has('checkout_session_id') || !this.urlSearchParams.has('service_quote')) {
            return;
        }

        const checkoutSessionId = this.urlSearchParams.get('checkout_session_id');
        const serviceQuoteId = this.urlSearchParams.get('service_quote');

        this.restoreDraftForServiceQuote(serviceQuoteId);
        if (this.selectedServiceQuoteId !== serviceQuoteId) {
            this.notifications.error('Something went wrong trying to complete purchase.');
            return;
        }

        await this.modalsManager.done();
        this.modalsManager.show('modals/confirm-service-quote-purchase', {
            title: 'Finalizing Purchase',
            modalClass: 'finalize-service-quote-purchase',
            loadingMessage: 'Completing purchase do not refresh or exit window...',
            modalFooterClass: 'hidden-i',
            backdropClose: false,
        });
        await timeout(300);

        try {
            const { status, purchaseRate } = await this.customerPortalOrderActions.getStripeCheckoutSessionStatus.perform(this.draft.serviceQuote, checkoutSessionId);
            if (purchaseRate) {
                this.customerPortalOrderCreation.setField('purchaseRate', purchaseRate);
            }

            if (status === 'complete' || status === 'purchase_complete') {
                if (!purchaseRate) throw new Error('Payment confirmation is missing. Retry without starting another payment.');
                const order = await this.submit();
                if (order) {
                    this.urlSearchParams.removeParamFromCurrentUrl('checkout_session_id');
                    this.urlSearchParams.removeParamFromCurrentUrl('service_quote');
                    this.urlSearchParams.removeParamFromCurrentUrl('checkout_draft');
                    this.currentUser.setOption(`order:state:${serviceQuoteId}`, undefined);
                }
            } else if (status === 'open' || status === 'expired') {
                this.urlSearchParams.removeParamFromCurrentUrl('checkout_session_id');
                this.urlSearchParams.removeParamFromCurrentUrl('service_quote');
                this.notifications.warning('Checkout is not complete. Your delivery draft is retained; you can retry payment.');
            }
        } catch (error) {
            this.notifications.serverError(error);
        } finally {
            await this.modalsManager.done();
        }
    }

    saveCurrentOrderForCurrentServiceQuote(serviceQuote) {
        if (this.draft?.checkoutDraftUuid) return;
        const serviceQuoteId = serviceQuote?.uuid ?? serviceQuote?.id;
        if (!serviceQuoteId) {
            return;
        }

        this.currentUser.setOption(`order:state:${serviceQuoteId}`, {
            draft: this.draft,
            serviceQuote,
        });
    }

    restoreDraftForServiceQuote(serviceQuoteId) {
        if (this.draft?.checkoutDraftUuid) return;
        const state = this.currentUser.getOption(`order:state:${serviceQuoteId}`);
        if (!state?.draft) {
            this.customerPortalOrderCreation.setField('serviceQuote', { uuid: serviceQuoteId });
            return;
        }

        this.customerPortalOrderCreation.draft = {
            ...state.draft,
            serviceQuote: state.serviceQuote ?? state.draft.serviceQuote,
            serviceQuotes: state.draft.serviceQuotes?.length ? state.draft.serviceQuotes : [state.serviceQuote].filter(Boolean),
            purchaseRate: null,
        };
    }

    shouldInitializeStripe(paymentConfig = {}) {
        return paymentConfig.paymentsEnabled === true && paymentConfig.paymentsOnboardCompleted === true && typeof config.stripe?.publishableKey === 'string';
    }
}
