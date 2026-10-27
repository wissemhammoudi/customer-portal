import Controller from '@ember/controller';

export default class PortalOrdersNewController extends Controller {
    queryParams = ['checkout_draft', 'checkout_session_id', 'service_quote', 'creating'];
    checkout_draft = null;
    checkout_session_id = null;
    service_quote = null;
    creating = null;
}
