import { useState, useMemo } from 'react';
import { cashImpact, financeImpact, fmtCurrency } from '../lib/insights';

interface Props {
  monthlyFreeFlow: number;  // avg monthly net from recent months
  safeToSpendBase: number;  // current month's Safe-to-Spend
  currentSavings:  number;
}

type Mode = 'cash' | 'finance';

export default function ImpactCalculator({
  monthlyFreeFlow,
  safeToSpendBase,
  currentSavings,
}: Props) {
  const [mode,    setMode]    = useState<Mode>('cash');
  const [price,   setPrice]   = useState(2_500);
  const [apr,     setApr]     = useState(24);
  const [payment, setPayment] = useState(250);

  const cash    = useMemo(() => cashImpact({ price, monthlyFreeFlow, safeToSpendBase }), [price, monthlyFreeFlow, safeToSpendBase]);
  const finance = useMemo(() => financeImpact({ price, aprPct: apr, monthlyPayment: payment, safeToSpendBase }), [price, apr, payment, safeToSpendBase]);

  const MAX_PRICE = 50_000;

  return (
    <div className="space-y-4 text-sm">
      {/* Mode switcher */}
      <div className="inline-flex rounded-lg border border-surface-border bg-surface p-0.5">
        <button
          onClick={() => setMode('cash')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            mode === 'cash' ? 'bg-surface-card text-stone-800 shadow-sm' : 'text-stone-400 hover:text-stone-600'
          }`}
          type="button"
        >Pay in Cash</button>
        <button
          onClick={() => setMode('finance')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            mode === 'finance' ? 'bg-surface-card text-stone-800 shadow-sm' : 'text-stone-400 hover:text-stone-600'
          }`}
          type="button"
        >Finance</button>
      </div>

      {/* Price slider */}
      <div>
        <div className="flex justify-between text-xs text-stone-400 mb-1">
          <span>Purchase price</span>
          <span className="tabular-nums font-medium text-stone-700">{fmtCurrency(price)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={MAX_PRICE}
          step={100}
          value={price}
          onChange={e => setPrice(Number(e.target.value))}
          className="w-full accent-lime-600"
        />
        <div className="flex justify-between text-xs text-stone-400 mt-0.5">
          <span>$0</span>
          <span>{fmtCurrency(MAX_PRICE, { compact: true })}</span>
        </div>
      </div>

      {/* Finance-only inputs */}
      {mode === 'finance' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-stone-400">APR %</span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={40}
              value={apr}
              onChange={e => setApr(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums"
            />
          </label>
          <label className="block">
            <span className="text-xs text-stone-400">Monthly payment</span>
            <input
              type="number"
              step="10"
              min={0}
              value={payment}
              onChange={e => setPayment(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums"
            />
          </label>
        </div>
      )}

      {/* Results */}
      {mode === 'cash' ? (
        <CashResults result={cash} currentSavings={currentSavings} price={price} />
      ) : (
        <FinanceResults result={finance} price={price} />
      )}
    </div>
  );
}

function CashResults({ result, currentSavings, price }: { result: ReturnType<typeof cashImpact>; currentSavings: number; price: number }) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-xs text-brand-red">
        {result.error}
      </div>
    );
  }

  const months = result.monthsToRecover;
  const monthsLabel = months < 1
    ? `${Math.round(months * 30)} days`
    : months < 24
      ? `${months.toFixed(1)} months`
      : `${(months / 12).toFixed(1)} years`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Time to recover"      value={monthsLabel}                          accent />
        <Stat label="Replenished by"       value={result.recoverLabel}                   accent />
        <Stat label="After-purchase cash"  value={fmtCurrency(currentSavings - price, { compact: true })}
              tone={currentSavings - price < 0 ? 'red' : 'default'} />
      </div>
      <p className="text-xs text-stone-400">
        New Safe-to-Spend this month: <span className={`tabular-nums ${result.newSafeToSpend < 0 ? 'text-brand-red' : 'text-stone-700'}`}>
          {fmtCurrency(result.newSafeToSpend)}
        </span>
      </p>
    </div>
  );
}

function FinanceResults({ result, price }: { result: ReturnType<typeof financeImpact>; price: number }) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-xs text-brand-red">
        {result.error}
      </div>
    );
  }

  const years = (result.monthsToPayOff / 12).toFixed(1);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Payoff time"   value={`${result.monthsToPayOff} mo (${years} yr)`} accent />
        <Stat label="Total interest" value={fmtCurrency(result.totalInterest, { compact: true })} tone="red" />
        <Stat label="True cost"      value={fmtCurrency(result.trueCost, { compact: true })} tone="red" />
      </div>
      <p className="text-xs text-stone-400">
        New Safe-to-Spend each month:{' '}
        <span className={`tabular-nums ${result.newSafeToSpend < 0 ? 'text-brand-red' : 'text-stone-700'}`}>
          {fmtCurrency(result.newSafeToSpend)}
        </span>
        <span className="ml-2 text-stone-400">
          (interest = {fmtCurrency(result.totalInterest - price + price, { compact: true }).replace('-', '')} on top of {fmtCurrency(price, { compact: true })})
        </span>
      </p>
    </div>
  );
}

function Stat({ label, value, accent, tone = 'default' }: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: 'default' | 'red';
}) {
  const color = tone === 'red' ? 'text-brand-red' : accent ? 'text-stone-800' : 'text-stone-700';
  return (
    <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-stone-400">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
