import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { inject as service } from '@ember/service';
import { action } from '@ember/object';
import { registerDestructor } from '@ember/destroyable';

const API = { namespace: 'customer-portal/int/v1' };

export default class PortalPayoutReceiptComponent extends Component {
    @service fetch;
    @service notifications;
    @tracked editing = false;
    @tracked name = '';
    @tracked busy = false;
    @tracked error = '';
    @tracked signed = false;
    @tracked distance = 0;
    strokes = [];
    canvas = null;
    pointer = null;

    constructor() {
        super(...arguments);
        registerDestructor(this, () => {
            this.canvas = null;
        });
    }

    get received() {
        return Boolean(this.args.payout.receipt || this.signed);
    }
    get canSign() {
        return this.args.payout.method === 'office_cash' && this.args.payout.status === 'paid' && this.args.payout.paid_at && !this.args.payout.is_reversed && !this.received;
    }
    get bankPaid() {
        return this.args.payout.method === 'bank_transfer' && this.args.payout.status === 'paid' && !this.args.payout.is_reversed;
    }
    get amount() {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: this.args.currency || 'TND' }).format(this.args.payout.amount / 1000);
    }
    get disabled() {
        return this.busy || this.name.trim().length < 2 || this.distance < 30;
    }

    @action setupCanvas(element) {
        this.canvas = element;
        this.redraw();
    }
    @action start() {
        this.editing = true;
        this.error = '';
    }
    @action cancel() {
        this.editing = false;
        this.clear();
    }
    @action clear() {
        if (this.canvas && this.pointer !== null && this.canvas.hasPointerCapture(this.pointer)) this.canvas.releasePointerCapture(this.pointer);
        this.strokes = [];
        this.distance = 0;
        this.pointer = null;
        this.redraw();
    }

    point(event) {
        const bounds = this.canvas.getBoundingClientRect();
        return [Math.max(0, Math.min(800, ((event.clientX - bounds.left) / bounds.width) * 800)), Math.max(0, Math.min(240, ((event.clientY - bounds.top) / bounds.height) * 240))];
    }

    @action begin(event) {
        if (this.busy || this.pointer !== null || this.strokes.length >= 30) return;
        event.preventDefault();
        this.pointer = event.pointerId;
        this.canvas.setPointerCapture(event.pointerId);
        this.strokes.push([this.point(event)]);
    }

    @action move(event) {
        if (this.busy || this.pointer !== event.pointerId) return;
        const stroke = this.strokes[this.strokes.length - 1];
        if (stroke.length >= 500) return;
        const point = this.point(event);
        const previous = stroke[stroke.length - 1];
        this.distance += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        stroke.push(point);
        this.redraw();
    }

    @action finish(event) {
        if (this.pointer !== event.pointerId) return;
        this.pointer = null;
        this.strokes = this.strokes.filter((stroke) => stroke.length >= 2);
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.redraw();
    }

    redraw() {
        if (!this.canvas) return;
        const context = this.canvas.getContext('2d');
        context.clearRect(0, 0, 800, 240);
        context.strokeStyle = '#18181b';
        context.lineWidth = 3;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        for (const stroke of this.strokes) {
            context.beginPath();
            stroke.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
            context.stroke();
        }
    }

    @action async sign() {
        if (this.disabled || !this.canSign) return;
        this.busy = true;
        this.error = '';
        try {
            const result = await this.fetch.post(
                `wallet/payouts/${encodeURIComponent(this.args.payout.id)}/receipt`,
                { signer_name: this.name.trim(), signature: this.strokes, acknowledged: true },
                API
            );
            if (!result.receipt?.id || !result.receipt.signed_at) throw new Error('The signed receipt was not returned. Refresh Invoices before trying again.');
            this.signed = true;
            this.editing = false;
            this.args.onSigned?.();
        } catch (error) {
            this.error = 'Could not save your signed receipt. Your signature is retained; refresh Invoices before retrying if the response was lost.';
            this.notifications.serverError(error);
        } finally {
            this.busy = false;
        }
    }

    @action async open(download = false) {
        if (this.busy || !this.received) return;
        const popup = window.open('', '_blank');
        if (popup) popup.opener = null;
        this.busy = true;
        this.error = '';
        try {
            const result = await this.fetch.get(`wallet/payouts/${encodeURIComponent(this.args.payout.id)}/receipt`, { download: download ? 1 : 0 }, API);
            if (!/^https?:\/\//i.test(result.url)) throw new Error('Payout receipt PDF is unavailable.');
            if (popup) popup.location.href = result.url;
            else {
                const link = document.createElement('a');
                link.href = result.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.click();
            }
        } catch (error) {
            popup?.close();
            this.error = 'Could not open the signed receipt. Please try again.';
            this.notifications.serverError(error);
        } finally {
            this.busy = false;
        }
    }
}
