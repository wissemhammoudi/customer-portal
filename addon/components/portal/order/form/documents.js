import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { debug } from '@ember/debug';
import { task } from 'ember-concurrency';
import { orderDocumentAccept, validateOrderDocument } from '@fleetbase/ember-ui/utils/order-document-policy';

export default class PortalOrderFormDocumentsComponent extends Component {
    @service fetch;
    @service notifications;
    @service customerPortalOrderCreation;

    @tracked uploadQueue = [];

    acceptedFileTypes = orderDocumentAccept;

    get files() {
        return this.args.draft?.files ?? [];
    }

    @task *queueFile(file) {
        if (!['queued', 'failed', 'timed_out', 'aborted'].includes(file.state)) {
            return;
        }

        const creation = this.customerPortalOrderCreation;
        const draftId = creation.draftId;
        creation.setField('uploadsPending', (creation.draft.uploadsPending ?? 0) + 1);
        try {
            validateOrderDocument(file);
            this.uploadQueue = [...this.uploadQueue, file];

            yield this.fetch.uploadFile.perform(
                file,
                {
                    path: 'uploads/customer-portal/order-files',
                    type: 'order_file',
                },
                (uploadedFile) => {
                    if (creation.draftId !== draftId) return;
                    this.customerPortalOrderCreation.setField('files', [...(creation.draft.files ?? []), uploadedFile]);
                    this.uploadQueue = this.uploadQueue.filter((queuedFile) => queuedFile !== file);
                },
                () => {
                    this.uploadQueue = this.uploadQueue.filter((queuedFile) => queuedFile !== file);
                    if (file.queue && typeof file.queue.remove === 'function') {
                        file.queue.remove(file);
                    }
                }
            );
        } catch (error) {
            debug(`Customer portal order document upload failed: ${error.message}`);
            this.notifications.serverError(error);
        } finally {
            this.uploadQueue = this.uploadQueue.filter((queuedFile) => queuedFile !== file);
            if (creation.draftId === draftId && creation.draft) {
                creation.setField('uploadsPending', Math.max(0, (creation.draft.uploadsPending ?? 1) - 1));
            }
        }
    }

    @task *removeFile(file) {
        yield this.customerPortalOrderCreation.setField(
            'files',
            this.files.filter((candidate) => candidate !== file)
        );

    }
}
