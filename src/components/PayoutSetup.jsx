import { useState } from 'react';
import { Check, Loader2, Landmark } from 'lucide-react';
import { callFunction } from '../lib/edgeFn';
import { DANDA_BOOKING_COMMISSION_PERCENT } from '../config/payments';

const inputCls = 'bg-sabi-dark border border-sabi-border rounded-lg px-3 py-2 text-white text-sm placeholder:text-sabi-muted outline-none focus:border-sabi-green transition-colors';

/**
 * Settings → "Receive payments". Walks the owner through: pick bank + enter
 * account number → we look up the account name → owner confirms it → the
 * Edge Function creates (or updates) their Paystack subaccount.
 *
 * `payout` = { enabled, bank_name, bank_code, account_last4, account_name }
 * `onSaved(payout)` is called with the same shape after a successful save.
 */
export default function PayoutSetup({ businessId, payout, onSaved }) {
  const [editing, setEditing]       = useState(false);
  const [banks, setBanks]           = useState(null);
  const [banksLoading, setBanksLoading] = useState(false);
  const [bankCode, setBankCode]     = useState('');
  const [account, setAccount]       = useState('');
  const [resolvedName, setResolvedName] = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');

  async function startEditing() {
    setEditing(true); setError(''); setResolvedName('');
    setBankCode(payout?.bank_code ?? ''); setAccount('');
    if (banks || banksLoading) return;
    setBanksLoading(true);
    const { data, error: err } = await callFunction('setup-payout-account', { action: 'banks' });
    setBanksLoading(false);
    if (err) setError(err); else setBanks(data?.banks ?? []);
  }

  function cancel() { setEditing(false); setError(''); setResolvedName(''); setAccount(''); }

  const accountValid = /^\d{10}$/.test(account);

  async function verify() {
    if (!bankCode) return setError('Choose your bank');
    if (!accountValid) return setError('Enter your 10-digit account number');
    setBusy(true); setError('');
    const { data, error: err } = await callFunction('setup-payout-account', {
      action: 'resolve', bank_code: bankCode, account_number: account,
    });
    setBusy(false);
    if (err) return setError(err);
    setResolvedName(data?.account_name ?? '');
  }

  async function confirm() {
    setBusy(true); setError('');
    const { data, error: err } = await callFunction('setup-payout-account', {
      action: 'save', business_id: businessId, bank_code: bankCode,
      account_number: account, confirm_name: resolvedName,
    });
    setBusy(false);
    if (err) { setError(err); setResolvedName(''); return; }
    onSaved?.(data.payout);
    cancel();
  }

  return (
    <div className="bg-sabi-card border border-sabi-border rounded-2xl p-5 flex flex-col gap-4 mt-6">
      <div>
        <h3 className="font-semibold text-white text-lg flex items-center gap-2">
          <Landmark size={16} className="text-sabi-gold" /> Receive payments
        </h3>
        <p className="text-sabi-muted text-xs mt-1 leading-relaxed">
          Let clients pay a deposit or the full price when they book. Money goes straight to your
          bank account through Paystack — Danda never holds it.
          {DANDA_BOOKING_COMMISSION_PERCENT > 0 && ` Danda keeps ${DANDA_BOOKING_COMMISSION_PERCENT}% of each payment.`}
          {' '}Paystack's processing fee is deducted from each payment.
        </p>
      </div>

      {!editing && (
        payout?.enabled ? (
          <div className="flex items-center justify-between gap-3 bg-sabi-dark border border-sabi-border rounded-xl px-4 py-3">
            <div className="min-w-0">
              <p className="text-white text-sm font-semibold truncate">{payout.account_name ?? 'Account'}</p>
              <p className="text-sabi-muted text-xs truncate">{payout.bank_name ?? 'Bank'} · ••••{payout.account_last4 ?? ''}</p>
            </div>
            <button className="text-sabi-gold text-xs font-bold border border-sabi-gold/30 rounded-lg px-3 py-1.5 bg-transparent cursor-pointer flex-shrink-0" onClick={startEditing}>
              Change
            </button>
          </div>
        ) : (
          <button className="bg-sabi-gold text-sabi-dark font-bold py-3 rounded-xl border-0 cursor-pointer" onClick={startEditing}>
            Set up payouts
          </button>
        )
      )}

      {editing && (
        <div className="flex flex-col gap-3">
          {resolvedName ? (
            <div className="flex flex-col gap-3 bg-sabi-dark border border-sabi-gold/30 rounded-xl p-4">
              <p className="text-sabi-muted text-xs uppercase tracking-wider font-semibold">Is this your account?</p>
              <p className="text-white text-lg font-bold">{resolvedName}</p>
              <p className="text-sabi-muted text-xs">
                {banks?.find(b => b.code === bankCode)?.name ?? 'Bank'} · ••••{account.slice(-4)}
              </p>
              <div className="flex gap-2">
                <button className="flex-1 bg-sabi-gold text-sabi-dark font-bold py-2.5 rounded-lg border-0 cursor-pointer disabled:opacity-70 flex items-center justify-center gap-2" onClick={confirm} disabled={busy}>
                  {busy ? <><Loader2 size={14} className="od-spin" /> Saving…</> : <><Check size={14} /> Yes, that&apos;s me</>}
                </button>
                <button className="px-4 text-sabi-muted text-sm font-semibold border border-sabi-border rounded-lg bg-transparent cursor-pointer" onClick={() => setResolvedName('')} disabled={busy}>
                  No
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-sabi-muted uppercase tracking-wider mb-1">Bank</label>
                {banksLoading ? (
                  <div className="h-10 rounded-lg bg-sabi-dark animate-pulse" />
                ) : (
                  <select className={`${inputCls} w-full cursor-pointer`} value={bankCode} onChange={e => { setBankCode(e.target.value); setError(''); }}>
                    <option value="">Select your bank…</option>
                    {(banks ?? []).map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-sabi-muted uppercase tracking-wider mb-1">Account number</label>
                <input className={`${inputCls} w-full`} inputMode="numeric" maxLength={10} placeholder="10-digit account number"
                  value={account} onChange={e => { setAccount(e.target.value.replace(/\D/g, '')); setError(''); }} />
              </div>
              <div className="flex gap-2">
                <button className="flex-1 bg-sabi-gold text-sabi-dark font-bold py-2.5 rounded-lg border-0 cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
                  onClick={verify} disabled={busy || banksLoading || !bankCode || !accountValid}>
                  {busy ? <><Loader2 size={14} className="od-spin" /> Checking…</> : 'Verify account'}
                </button>
                <button className="px-4 text-sabi-muted text-sm font-semibold border border-sabi-border rounded-lg bg-transparent cursor-pointer" onClick={cancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
