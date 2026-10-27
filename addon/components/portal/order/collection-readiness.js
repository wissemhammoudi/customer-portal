import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { dropTask } from 'ember-concurrency';
import { valueFor } from '../../../utils/model-access';

export default class PortalOrderCollectionReadinessComponent extends Component {
    @service customerPortalOrderActions;
    @service notifications;
    @service modalsManager;
    @tracked preview = null;

    get workflow() {
        return valueFor(this.args.order, 'meta.collection_workflow');
    }

    get editable() {
        return !['completed', 'done', 'delivered', 'canceled', 'cancelled'].includes(valueFor(this.args.order, 'status'))
            && this.workflow?.version === 1 && !this.workflow?.collection_round_uuid
            && ['awaiting_preparation', 'ready_for_pickup'].includes(this.workflow?.state);
    }

    get awaitingPreparation() {
        return this.workflow?.state === 'awaiting_preparation';
    }

    get stateLabel() {
        if (['canceled', 'cancelled'].includes(valueFor(this.args.order, 'status'))) {
            return 'cancelled';
        }
        if (this.workflow?.state === 'pickup_exception') {
            return 'Partially collected - operations review required';
        }
        if (this.workflow?.state === 'depot_hold') {
            return 'Held at depot - operations review required';
        }
        return String(this.workflow?.state ?? '').replace(/_/g, ' ');
    }

    get plannedPickup() {
        const planned = this.preview?.planned_collection_at ?? this.workflow?.planned_collection_at;
        const timezone = this.preview?.timezone ?? this.workflow?.timezone ?? 'Africa/Tunis';
        return planned ? `${new Date(planned).toLocaleString(undefined, { timeZone: timezone })} (${timezone})` : null;
    }

    @dropTask *review() {
        try {
            this.preview = yield this.customerPortalOrderActions.collectionReadiness(this.args.order);
        } catch (error) {
            this.notifications.serverError(error);
        }
    }

    @action keepPreparing() {
        this.preview = null;
    }

    @dropTask *confirm(ready) {
        try {
            const order = yield this.customerPortalOrderActions.setCollectionReadiness(this.args.order, ready, ready ? this.preview?.confirmation_token : this.workflow?.confirmation_token);
            this.preview = null;
            this.args.onChanged(order);
            this.notifications.success(ready ? 'Order is ready for pickup.' : 'Readiness withdrawn. Mark the order ready again after preparation.');
        } catch (error) {
            this.preview = null;
            this.notifications.serverError(error);
        }
    }

    @action withdraw() {
        this.modalsManager.confirm({
            title: 'Withdraw pickup readiness?',
            body: 'This order will leave the collection queue until you mark it ready again.',
            acceptButtonText: 'Withdraw readiness',
            confirm: () => this.confirm.perform(false),
        });
    }
}
