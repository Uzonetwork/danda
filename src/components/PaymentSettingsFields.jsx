import { computeAmountDue } from '../lib/bookingPayment';
import { MIN_ONLINE_PAYMENT_NAIRA } from '../config/payments';

const inputCls = 'bg-sabi-dark border border-sabi-border rounded-lg px-3 py-2 text-white text-sm placeholder:text-sabi-muted outline-none focus:border-sabi-green transition-colors';

const MODES = [
  { id: 'pay_at_venue', label: 'Pay at venue', online: false },
  { id: 'deposit',      label: 'Deposit',      online: true  },
  { id: 'full',         label: 'Pay in full',  online: true  },
];

/**
 * Payment selector for the service editor. `value` =
 * { payment_mode, deposit_type, deposit_value } (deposit_value may be a
 * string while typing). Deposit / full are disabled until the owner has set
 * up payouts, with a short explanation.
 */
export default function PaymentSettingsFields({ value, onChange, price, payoutsEnabled }) {
  const mode = value.payment_mode ?? 'pay_at_venue';
  const due = computeAmountDue({ price: Number(price) || 0, payment_mode: mode, deposit_type: value.deposit_type, deposit_value: Number(value.deposit_value) });
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-sabi-muted uppercase tracking-wider">Client pays</p>
      <div className="flex gap-2 flex-wrap">
        {MODES.map(m => {
          const disabled = m.online && !payoutsEnabled && mode !== m.id;
          const active = mode === m.id;
          return (
            <button key={m.id} type="button" disabled={disabled}
              onClick={() => set({ payment_mode: m.id, deposit_type: m.id === 'deposit' ? (value.deposit_type ?? 'fixed') : value.deposit_type })}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${active ? 'bg-sabi-gold text-sabi-dark border-sabi-gold' : 'bg-transparent text-sabi-muted border-sabi-border hover:text-white'}`}>
              {m.label}
            </button>
          );
        })}
      </div>
      {!payoutsEnabled && (
        <p className="text-sabi-muted text-xs">
          To take a deposit or full payment online, first add your bank account under Settings → Receive payments.
        </p>
      )}
      {mode === 'deposit' && (
        <div className="flex items-center gap-2 flex-wrap">
          <select className={`${inputCls} cursor-pointer`} value={value.deposit_type ?? 'fixed'} onChange={e => set({ deposit_type: e.target.value })}>
            <option value="fixed">Fixed amount (₦)</option>
            <option value="percent">Percent of price (%)</option>
          </select>
          <input className={`${inputCls} w-28`} type="number" min="1" inputMode="numeric"
            placeholder={value.deposit_type === 'percent' ? 'e.g. 30' : 'e.g. 10000'}
            value={value.deposit_value ?? ''} onChange={e => set({ deposit_value: e.target.value })} />
        </div>
      )}
      {mode !== 'pay_at_venue' && (
        <p className="text-sabi-muted text-xs">
          {due
            ? `Client pays ₦${due.dueNow.toLocaleString()} when booking${due.balance > 0 ? `, ₦${due.balance.toLocaleString()} at the venue` : ''}.`
            : 'Enter the price and deposit to see what the client will pay.'}
          {' '}Minimum online payment ₦{MIN_ONLINE_PAYMENT_NAIRA.toLocaleString()}.
        </p>
      )}
    </div>
  );
}
