import { useState, useMemo } from 'react';

interface Props {
  currentSavings:  number;
  avgMonthlyNet:   number;
  monthsRemaining: number;
}

function fmt(n: number, compact = false): string {
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    notation:              compact ? 'compact' : 'standard',
    minimumFractionDigits: compact ? 0 : 0,
    maximumFractionDigits: compact ? 1 : 0,
    signDisplay:           'auto',
  }).format(n);
}

export default function ImpactCalculator({
  currentSavings,
  avgMonthlyNet,
  monthsRemaining,
}: Props) {
  const [purchase, setPurchase] = useState(0);
  const MAX_PURCHASE = 200_000;

  const baseEOY     = currentSavings + avgMonthlyNet * monthsRemaining;
  const afterEOY    = baseEOY - purchase;
  const delta       = afterEOY - baseEOY;
  const isNegImpact = delta < 0;

  const months = useMemo(() => {
    const today = new Date();
    const result: { label: string; base: number; after: number }[] = [];
    for (let i = 0; i <= monthsRemaining; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const label = d.toLocaleString('en-US', { month: 'short' });
      const base  = currentSavings + avgMonthlyNet * i;
      const after = base - (i === 0 ? purchase : purchase);
      result.push({ label, base, after });
    }
    return result;
  }, [currentSavings, avgMonthlyNet, monthsRemaining, purchase]);

  const allValues = months.flatMap(m => [m.base, m.after]);
  const minVal    = Math.min(...allValues);
  const maxVal    = Math.max(...allValues, 1);
  const W = 220, H = 60, PAD = 4;

  function toX(i: number) {
    return PAD + (i / Math.max(months.length - 1, 1)) * (W - PAD * 2);
  }
  function toY(v: number) {
    return PAD + (1 - (v - minVal) / (maxVal - minVal)) * (H - PAD * 2);
  }
  function polyline(key: 'base' | 'after') {
    return months.map((m, i) => `${toX(i)},${toY(m[key])}`).join(' ');
  }

  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="flex justify-between text-xs text-stone-400 mb-1">
          <span>Purchase cost</span>
          <span className="tabular-nums font-medium text-stone-700">{fmt(purchase)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={MAX_PURCHASE}
          step={500}
          value={purchase}
          onChange={e => setPurchase(Number(e.target.value))}
          className="w-full accent-lime-600"
        />
        <div className="flex justify-between text-xs text-stone-400 mt-0.5">
          <span>$0</span>
          <span>{fmt(MAX_PURCHASE, true)}</span>
        </div>
      </div>

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        aria-hidden="true"
      >
        <polyline
          points={polyline('base')}
          fill="none"
          stroke="#65a30d"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.5"
        />
        {purchase > 0 && (
          <polyline
            points={polyline('after')}
            fill="none"
            stroke={afterEOY < 0 ? '#dc626d' : '#65a30d'}
            strokeWidth="1.5"
            strokeDasharray="3 2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {minVal < 0 && maxVal > 0 && (
          <line
            x1={PAD} x2={W - PAD}
            y1={toY(0)} y2={toY(0)}
            stroke="#e4dbd0"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
      </svg>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-surface border border-surface-border px-3 py-2">
          <p className="text-xs text-stone-400">EOY (no purchase)</p>
          <p className={`mt-0.5 text-base font-semibold tabular-nums ${baseEOY >= 0 ? 'text-brand-green' : 'text-brand-red'}`}>
            {fmt(baseEOY, true)}
          </p>
        </div>
        <div className="rounded-lg bg-surface border border-surface-border px-3 py-2">
          <p className="text-xs text-stone-400">After purchase</p>
          <p className={`mt-0.5 text-base font-semibold tabular-nums ${afterEOY >= 0 ? 'text-brand-green' : 'text-brand-red'}`}>
            {fmt(afterEOY, true)}
          </p>
        </div>
      </div>

      {purchase > 0 && (
        <p className={`text-xs ${isNegImpact ? 'text-brand-red' : 'text-brand-green'}`}>
          {isNegImpact ? '▼' : '▲'} {fmt(Math.abs(delta), true)} impact on year-end position
        </p>
      )}
    </div>
  );
}
