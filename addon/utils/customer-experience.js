import { valueFor } from './model-access';

export function customerState(order) {
    const status = valueFor(order, 'status');
    if (['completed', 'done', 'delivered', 'canceled', 'cancelled'].includes(status)) return status;
    return valueFor(order, 'meta.collection_workflow.state') ?? status ?? 'created';
}

export function guidanceKey(order) {
    const state = customerState(order);
    if (['completed', 'done', 'delivered'].includes(state)) return 'delivered';
    if (['canceled', 'cancelled'].includes(state)) return 'cancelled';
    if (['pickup_exception', 'depot_hold'].includes(state)) return 'problem';
    return [
        'awaiting_preparation',
        'ready_for_pickup',
        'pickup_scheduled',
        'pickup_in_progress',
        'collected',
        'received_at_depot',
        'ready_for_delivery_dispatch',
        'out_for_delivery',
    ].includes(state)
        ? state
        : 'tracking-help';
}
