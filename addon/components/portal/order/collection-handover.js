import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { registerDestructor } from '@ember/destroyable';
import { task } from 'ember-concurrency';

export default class CollectionHandoverComponent extends Component {
    @service customerPortalOrderActions;
    @service notifications;
    @service modalsManager;
    @service intl;
    @tracked handover = null;
    @tracked error = null;
    @tracked selected = null;
    @tracked reason = '';
    @tracked pending = null;

    constructor() {
        super(...arguments);
        window.addEventListener('focus', this.refreshOnFocus);
        const timer = window.setInterval(this.refreshOnFocus, 30000);
        registerDestructor(this, () => {
            window.removeEventListener('focus', this.refreshOnFocus);
            window.clearInterval(timer);
        });
    }

    get pickups() {
        return (this.handover?.pickups ?? []).map((pickup) => ({
            ...pickup,
            key: `${pickup.round_uuid}:${pickup.stop_uuid}`,
            awaiting: pickup.status === 'awaiting_customer',
            statusKey: `pickup-handover.${pickup.status}`,
        }));
    }

    @action refreshOnFocus() {
        if (document.visibilityState === 'visible' && !this.submit.isRunning && (!this.pickups.length || this.pickups.some((pickup) => pickup.awaiting))) {
            this.refresh.perform();
        }
    }

    @action reset() {
        this.submit.cancelAll();
        this.handover = null;
        this.pending = null;
        this.selected = null;
        this.reason = '';
        this.refresh.perform();
    }

    @task({ restartable: true }) *refresh() {
        this.error = null;
        try {
            this.handover = yield this.customerPortalOrderActions.collectionHandover(this.args.order);
        } catch (error) {
            this.error = 'pickup-handover.load-error';
            this.notifications.serverError(error);
        }
    }

    @action confirm(pickup) {
        this.modalsManager.confirm({
            title: this.intl.t('pickup-handover.confirm-title'),
            body: this.intl.t('pickup-handover.confirm-question'),
            confirm: () => this.submit.perform(pickup, 'confirm'),
        });
    }

    @action dispute(pickup) {
        this.selected = pickup.key;
        this.reason = '';
    }

    @action setReason(event) {
        this.reason = event.target.value;
    }

    @action retry() {
        this.submit.perform();
    }

    @task({ drop: true }) *submit(pickup, decision, reason = '') {
        this.refresh.cancelAll();
        if (!this.pending) {
            if (decision === 'dispute' && !reason.trim()) return;
            this.pending = {
                round_uuid: pickup.round_uuid,
                stop_uuid: pickup.stop_uuid,
                action: decision,
                ...(decision === 'dispute' ? { reason: reason.trim() } : {}),
                request_id: window.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            };
        }
        this.error = null;
        try {
            const response = yield this.customerPortalOrderActions.setCollectionHandover(this.args.order, this.pending);
            const expected = this.pending.action === 'confirm' ? 'confirmed' : 'disputed';
            if (!response?.pickups?.some((result) => result.round_uuid === this.pending.round_uuid && result.stop_uuid === this.pending.stop_uuid && result.status === expected)) {
                throw new Error('The pickup decision was not acknowledged. Refresh or retry.');
            }
            this.handover = response;
            this.pending = null;
            this.selected = null;
            this.reason = '';
        } catch (error) {
            this.error = 'pickup-handover.submit-error';
            this.notifications.serverError(error);
        }
    }
}
