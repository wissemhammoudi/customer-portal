import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { task } from 'ember-concurrency';

const NAMESPACE = 'customer-portal/int/v1';

export default class PortalBusinessDocumentsComponent extends Component {
    @service fetch;
    @service notifications;
    @tracked documents = [];
    @tracked error;

    constructor() {
        super(...arguments);
        this.load.perform();
    }

    @task({ restartable: true }) *load() {
        try {
            const result = yield this.fetch.get('account/business-documents', {}, { namespace: NAMESPACE });
            this.documents = result.documents;
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }

    @task({ drop: true }) *upload(kind, event) {
        const file = event.target.files?.[0];
        if (!file) return;
        this.error = null;
        try {
            const body = new FormData();
            body.append('file', file);
            body.append('kind', kind);
            body.append('revision', this.args.profile.revision);
            const headers = this.fetch.getHeaders();
            delete headers['Content-Type'];
            yield this.fetch.request('account/business-documents', 'POST', { body, headers }, { namespace: NAMESPACE });
            this.args.onChanged();
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        } finally {
            event.target.value = '';
        }
    }

    @action download(document) {
        this.downloadFile.perform(document);
    }

    @task({ drop: true }) *downloadFile(document) {
        try {
            const result = yield this.fetch.get(`account/business-documents/${document.uuid}`, {}, { namespace: NAMESPACE });
            const bytes = Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
            const anchor = window.document.createElement('a');
            anchor.href = url;
            anchor.download = result.filename;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            this.error = error.message;
            this.notifications.serverError(error);
        }
    }
}
