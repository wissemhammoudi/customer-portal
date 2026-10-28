import { helper } from '@ember/component/helper';

export function formatInvoiceMoney(amount = 0, currency = 'TND') {
    try {
        const formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'TND' });
        const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
        return formatter.format(Number(amount || 0) / 10 ** digits);
    } catch {
        return `${amount || 0} ${currency || 'TND'} (minor units)`;
    }
}

export default helper(([amount, currency]) => formatInvoiceMoney(amount, currency));
