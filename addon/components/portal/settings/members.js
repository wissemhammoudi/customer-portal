import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { task } from 'ember-concurrency';

const NAMESPACE = 'customer-portal/int/v1';

export default class PortalSettingsMembersComponent extends Component {
    @service fetch;
    @service customerSession;
    @service notifications;
    @tracked members = [];
    @tracked invitations = [];
    @tracked inbox = [];
    @tracked name = '';
    @tracked email = '';
    @tracked role = 'operator';
    @tracked error;
    @tracked verifiedCompany = false;
    roles = ['operations', 'operator', 'accountant', 'viewer'];

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    get canManage() {
        return this.customerSession.capabilities.members;
    }

    get canSubmit() {
        return this.customerSession.capabilities.business;
    }

    get canInvite() {
        return this.canManage && this.verifiedCompany;
    }

    @task({ restartable: true }) *load() {
        this.error = null;
        try {
            const inbox = yield this.fetch.get('account/invitations', {}, { namespace: NAMESPACE });
            this.inbox = inbox.invitations;
            if (this.canManage) {
                const team = yield this.fetch.get('account/team', {}, { namespace: NAMESPACE });
                this.members = team.members;
                this.invitations = team.invitations;
                this.verifiedCompany = true;
            }
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }

    @action setRole(event) {
        this.role = event.target.value;
    }

    @task({ drop: true }) *invite(event) {
        event.preventDefault();
        yield this.mutate.perform('account/team/invitations', 'post', { name: this.name, email: this.email, role: this.role });
    }

    @task({ drop: true }) *mutate(path, method = 'post', input = {}) {
        this.error = null;
        try {
            yield this.fetch[method](path, input, { namespace: NAMESPACE });
            const choices = yield this.fetch.get('account/choices', {}, { namespace: NAMESPACE });
            this.customerSession.accounts = choices.accounts;
            yield this.load.perform();
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }

    @action accept(invitation) {
        this.mutate.perform(`account/invitations/${invitation.uuid}/accept`);
    }

    @action cancel(invitation) {
        this.mutate.perform(`account/team/invitations/${invitation.uuid}`, 'delete');
    }

    @action resend(invitation) {
        this.mutate.perform(`account/team/invitations/${invitation.uuid}/resend`);
    }

    @action changeRole(member, event) {
        this.mutate.perform(`account/team/${member.uuid}`, 'put', { role: event.target.value, status: member.status });
    }

    @action toggle(member) {
        this.mutate.perform(`account/team/${member.uuid}`, 'put', { role: member.role, status: member.status === 'active' ? 'suspended' : 'active' });
    }
}
