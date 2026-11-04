import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

export default class ChooseAccountRoute extends Route {
    @service session;
    @service customerSession;
    @service hostRouter;

    async beforeModel(transition) {
        this.session.requireAuthentication(transition, 'customer-portal.portal-auth.login');
        if (this.session.isAuthenticated) {
            await this.session.promiseCurrentUser(transition);
            await this.customerSession.promiseCurrentCustomer();
            if (!this.customerSession.selectionRequired) this.hostRouter.transitionTo('customer-portal.portal.home');
        }
    }
}
