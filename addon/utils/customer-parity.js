// Shared with the customer mobile app (src/customerParity.ts). Keep keys and order identical.
export const FINANCE_BALANCES = [
    ['gross', 'collected'],
    ['driver_pending', 'pending'],
    ['fee', 'delivery-fees'],
    ['vat', 'vat'],
    ['net', 'net-earned'],
    ['remitted', 'remitted'],
    ['paid_out', 'paid-out'],
    ['reserved', 'reserved'],
    ['remaining_due', 'remaining-due'],
];

export const DEFAULT_FINANCE_BALANCES = ['net', 'paid_out', 'remaining_due'];

export const HOME_KPIS = ['active_orders', 'completed_orders', 'unpaid_invoices', 'open_tickets', 'remaining_due'];

export const ORDER_FILTERS = ['active', 'completed', 'all'];

// Same buckets as the mobile Orders tab: delivered counts as completed for the customer.
export function matchesOrderFilter(status, filter) {
    const value = status ?? '';
    if (filter === 'all') return true;
    if (filter === 'completed') return ['completed', 'done', 'delivered'].includes(value);
    return !['completed', 'done', 'delivered', 'canceled', 'cancelled'].includes(value);
}
