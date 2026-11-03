import Controller from '@ember/controller';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { ORDER_FILTERS, matchesOrderFilter } from '../../utils/customer-parity';
import { valueFor } from '../../utils/model-access';

export default class PortalOrdersController extends Controller {
    @service customerPortalOrderActions;
    @service hostRouter;
    @service notifications;

    queryParams = ['view', 'query', 'filter'];

    @tracked view = 'table';
    @tracked query = '';
    @tracked filter = 'active';
    @tracked selectedOrder;

    get filteredOrders() {
        return (this.model?.orders ?? []).filter((order) => matchesOrderFilter(valueFor(order, 'status'), this.filter));
    }

    get isTableView() {
        return this.view === 'table';
    }

    @action switchView(view) {
        this.view = view;
    }

    @action setFilter(filter) {
        this.filter = ORDER_FILTERS.includes(filter) ? filter : 'active';
    }

    @action async search(query) {
        this.query = query;

        try {
            this.model = { ...this.model, orders: await this.customerPortalOrderActions.searchOrders.perform(query, 100) };
        } catch (error) {
            this.notifications.serverError(error);
        }
    }

    @action setSelectedOrder(order) {
        this.selectedOrder = order;
    }

    @action clearSelectedOrder() {
        this.selectedOrder = null;
    }

    @action async reloadOrders() {
        try {
            this.model = { ...this.model, orders: await this.customerPortalOrderActions.loadOrders.perform({ query: this.query, limit: 100 }) };
        } catch (error) {
            this.notifications.serverError(error);
        }
    }
}
