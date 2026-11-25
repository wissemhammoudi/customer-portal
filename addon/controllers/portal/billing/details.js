import Controller from '@ember/controller';

export default class PortalBillingDetailsController extends Controller {
    get invoice() {
        return this.model;
    }

    get invoiceIdentifier() {
        return this.invoice?.public_id ?? this.invoice?.id;
    }

    get invoiceNumber() {
        return this.invoice?.number ?? this.invoiceIdentifier;
    }

    get orderIdentifier() {
        return this.invoice?.order_public_id ?? this.invoice?.order_uuid;
    }

    get orderLabel() {
        return this.invoice?.order_tracking_number ?? this.invoice?.order_public_id ?? this.invoice?.order_uuid;
    }

    get subtotalAmount() {
        return Number(this.invoice?.subtotal ?? 0);
    }

    get taxAmount() {
        return Number(this.invoice?.tax ?? 0);
    }

    get totalAmount() {
        return Number(this.invoice?.total_amount ?? this.invoice?.total ?? 0);
    }

    get amountPaid() {
        return Number(this.invoice?.amount_paid ?? 0);
    }

    get balanceAmount() {
        return Number(this.invoice?.balance ?? 0);
    }
}
