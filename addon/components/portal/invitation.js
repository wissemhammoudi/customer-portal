import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { task } from 'ember-concurrency';

export default class PortalInvitationComponent extends Component {
    @service fetch;
    @tracked invitation;
    @tracked error;
    @tracked accepted = false;
    @tracked password = '';
    @tracked confirmation = '';

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    get loginUrl() {
        return `${window.location.pathname.split('/invitation/')[0]}/auth/login`;
    }

    @task *load() {
        try {
            const result = yield this.fetch.post(`invitations/${this.args.id}/preview`, { token: this.args.token }, { namespace: 'customer-portal' });
            this.invitation = result.invitation;
        } catch (error) {
            this.error = error.message;
        }
    }

    @task({ drop: true }) *accept(event) {
        event.preventDefault();
        this.error = null;
        try {
            const result = yield this.fetch.post(
                `invitations/${this.args.id}`,
                {
                    token: this.args.token,
                    password: this.password,
                    password_confirmation: this.confirmation,
                },
                { namespace: 'customer-portal' }
            );
            if (result.status !== 'accepted') throw new Error('The server did not confirm invitation acceptance.');
            this.password = '';
            this.confirmation = '';
            this.accepted = true;
        } catch (error) {
            this.error = error.message;
        }
    }
}
