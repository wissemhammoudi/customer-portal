import Controller from '@ember/controller';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { arrayFor, valueFor } from '../../utils/model-access';

export default class PortalDocumentsController extends Controller {
    @service notifications;
    @tracked query = '';
    @tracked section = 'all';

    @action selectSection(section) {
        this.section = section;
    }

    get documents() {
        const query = this.query.trim().toLowerCase();
        return arrayFor(this.model?.documents).filter((document) => {
            const type = (valueFor(document, 'type') ?? '').toLowerCase();
            const group = /invoice|receipt/.test(type) ? 'finance' : /pod|proof|photo/.test(type) ? 'proof' : /label|bordereau/.test(type) ? 'shipping' : 'other';
            const text = ['original_filename', 'name', 'type', 'order_tracking_number', 'order_public_id']
                .map((key) => valueFor(document, key))
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return (this.section === 'all' || this.section === group) && text.includes(query);
        });
    }

    @action async downloadDocument(document) {
        if (typeof document?.download === 'function') {
            try {
                await document.download();
                return;
            } catch (error) {
                this.notifications.serverError(error);
                return;
            }
        }

        const url = valueFor(document, 'url');
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
        }

        this.notifications.info('This file is not available for download yet.');
    }
}
