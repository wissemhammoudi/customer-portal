import Route from '@ember/routing/route';

export default class PortalWalletRoute extends Route {
    beforeModel() {
        return this.replaceWith('portal.billing');
    }
}
