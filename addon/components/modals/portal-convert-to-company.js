import Component from '@glimmer/component';
import { inject as service } from '@ember/service';

export default class ModalsPortalConvertToCompanyComponent extends Component {
    @service intl;

    constructor(owner, { options }) {
        super(...arguments);
        options.title = this.intl.t('customer-business.title');
        options.acceptButtonText = this.intl.t('customer-business.close');
        options.confirm = (modal) => modal.done();
    }
}
