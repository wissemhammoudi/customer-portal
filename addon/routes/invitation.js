import Route from '@ember/routing/route';

export default class InvitationRoute extends Route {
    model(params) {
        const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
        window.history.replaceState(null, '', window.location.pathname);
        return { id: params.id, token };
    }
}
