import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

export default class PortalOrdersNewRoute extends Route {
    queryParams = { checkout_draft: { refreshModel: true } };
    @service customerPortalOrderActions;
    @service customerPortalOrderCreation;
    @service urlSearchParams;
    @service hostRouter;

    async model(params = {}) {
        const [orderConfigs, places, { place: pickup }] = await Promise.all([
            this.customerPortalOrderActions.loadOrderConfigs.perform(),
            this.customerPortalOrderActions.loadPlaces.perform(),
            this.customerPortalOrderActions.loadPickupAddress(),
        ]);
        this.customerPortalOrderCreation.accountPickup = pickup;
        let draft;
        const id = params.checkout_draft ?? this.urlSearchParams.get('checkout_draft');
        if (id) {
            this.customerPortalOrderCreation.takeCheckoutRedirect();
            const { draft: saved } = await this.customerPortalOrderActions.loadCheckoutDraft(id);
            if (saved.order_uuid) {
                return this.hostRouter.replaceWith('customer-portal.portal.orders.details', saved.order_uuid);
            }
            draft = this.customerPortalOrderCreation.restoreCheckoutDraft(saved, orderConfigs, Boolean(params.checkout_session_id || this.urlSearchParams.has('checkout_session_id')));
        } else {
            const originalOrder = this.customerPortalOrderCreation.pendingReturnOrder;
            draft = originalOrder ? this.customerPortalOrderCreation.startReturn(orderConfigs, originalOrder) : this.customerPortalOrderCreation.start(orderConfigs);
        }
        return { draft, orderConfigs, places };
    }

    resetController(controller, isExiting) {
        if (isExiting) {
            controller.setProperties({ checkout_draft: null, checkout_session_id: null, service_quote: null, creating: null });
        }
    }
}
