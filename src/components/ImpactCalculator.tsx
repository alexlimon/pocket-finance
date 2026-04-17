import { useState, useMemo } from 'react';
import { projectScenario, fmtCurrency, type Scenario, type ScenarioResult, type MonthBaseline } from '../lib/insights';

interface Props {
  monthBaselines:  MonthBaseline[];  // real per-month income/expenses/net
  currentSurplus:  number;           // this month's net pre-savings
  reserves:        number;           // savings + investment account balances
}

type ScenarioKind = 'recurring_expense' | 'one_time_purchase' | 'income_change';

const TAB_LABELS: Record<ScenarioKind, string> = {
  recurring_expense:  'New Recurring Bill',
  one_time_purchase:  'One-Time Purchase',
  income_change:      'Income Change',
};

function fmt(n: number): string { return fmtCurrency(n); }
function fmtSign(n: number): string { return fmtCurrency(n, { sign: true }); }

export default function ImpactCalculator({
  monthBaselines,
  currentSurplus,
  reserves,
}: Props) {
  const months = monthBaselines.map(m => m.month);
  const [kind, setKind] = useState<ScenarioKind>('recurring_expense');

  // ── Recurring expense state ──
  const [recurLabel, setRecurLabel]   = useState('Car note');
  const [recurAmount, setRecurAmount] = useState(450);
  const [recurStart, setRecurStart]   = useState(months[0] ?? '');

  // ── One-time purchase state ──
  const [onetimeLabel, setOnetimeLabel]   = useState('New couch');
  const [onetimeAmount, setOnetimeAmount] = useState(5000);
  const [onetimeMonth, setOnetimeMonth]   = useState(months[0] ?? '');

  // ── Income change state ──
  const [raisePct, setRaisePct]     = useState(5);
  const [raiseStart, setRaiseStart] = useState(months[Math.min(3, months.length - 1)] ?? '');

  const scenario: Scenario = useMemo(() => {
    if (kind === 'recurring_expense') {
      return { kind, label: recurLabel, amount: recurAmount, startMonth: recurStart };
    } else if (kind === 'one_time_purchase') {
      return { kind, label: onetimeLabel, amount: onetimeAmount, month: onetimeMonth };
    } else {
      return { kind, label: `${raisePct}% raise`, deltaPct: raisePct, startMonth: raiseStart };
    }
  }, [kind, recurLabel, recurAmount, recurStart, onetimeLabel, onetimeAmount, onetimeMonth, raisePct, raiseStart]);

  const result = useMemo(
    () => projectScenario({ scenario, monthBaselines, currentSurplus }),
    [scenario, monthBaselines, currentSurplus],
  );

  const monthLabel = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' });
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Tab switcher */}
      <div className="flex flex-wrap gap-1">
        {(Object.keys(TAB_LABELS) as ScenarioKind[]).map(k => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              kind === k ? 'bg-stone-800 text-white' : 'bg-surface border border-surface-border text-stone-500 hover:text-stone-700'
            }`}
            type="button"
          >{TAB_LABELS[k]}</button>
        ))}
      </div>

      {/* Inputs */}
      <div className="rounded-lg border border-surface-border bg-surface p-3 space-y-3">
        {kind === 'recurring_expense' && (
          <div className="grid grid-cols-3 gap-3">
            <label className="block col-span-1">
              <span className="text-xs text-stone-400">Name</span>
              <input type="text" value={recurLabel} onChange={e => setRecurLabel(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-stone-400">Monthly amount</span>
              <input type="number" step="25" min={0} value={recurAmount} onChange={e => setRecurAmount(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
            </label>
            <label className="block">
              <span className="text-xs text-stone-400">Starting</span>
              <select value={recurStart} onChange={e => setRecurStart(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          </div>
        )}

        {kind === 'one_time_purchase' && (
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs text-stone-400">What</span>
              <input type="text" value={onetimeLabel} onChange={e => setOnetimeLabel(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-stone-400">Cost</span>
              <input type="number" step="100" min={0} value={onetimeAmount} onChange={e => setOnetimeAmount(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
            </label>
            <label className="block">
              <span className="text-xs text-stone-400">Month</span>
              <select value={onetimeMonth} onChange={e => setOnetimeMonth(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          </div>
        )}

        {kind === 'income_change' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-stone-400">Raise %</span>
              <input type="number" step="0.5" min={-50} max={100} value={raisePct} onChange={e => setRaisePct(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
            </label>
            <label className="block">
              <span className="text-xs text-stone-400">Starting</span>
              <select value={raiseStart} onChange={e => setRaiseStart(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Verdict */}
      <Verdict result={result} reserves={reserves} />

      {/* Month-by-month table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-border text-stone-400">
              <th className="px-2 py-1.5 text-left font-medium">Month</th>
              <th className="px-2 py-1.5 text-right font-medium">Income</th>
              <th className="px-2 py-1.5 text-right font-medium">Expenses</th>
              <th className="px-2 py-1.5 text-right font-medium">Net (pre-savings)</th>
              <th className="px-2 py-1.5 text-right font-medium">vs Baseline</th>
              <th className="px-2 py-1.5 text-right font-medium">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {result.projections.map(p => {
              const isHit = p.delta !== 0;
              return (
                <tr key={p.month} className={`border-b border-surface-border/50 ${isHit ? 'bg-stone-50' : ''}`}>
                  <td className="px-2 py-1.5 font-medium text-stone-700">{p.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-stone-600">
                    {p.scenarioIncome !== p.baseIncome ? (
                      <span className="text-brand-green">{fmt(p.scenarioIncome)}</span>
                    ) : fmt(p.scenarioIncome)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-stone-600">
                    {p.scenarioExpenses !== p.baseExpenses ? (
                      <span className="text-brand-red">{fmt(p.scenarioExpenses)}</span>
                    ) : fmt(p.scenarioExpenses)}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
                    p.scenarioNet < 0 ? 'text-brand-red' : 'text-stone-700'
                  }`}>
                    {fmt(p.scenarioNet)}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${
                    p.delta < 0 ? 'text-brand-red' : p.delta > 0 ? 'text-brand-green' : 'text-stone-400'
                  }`}>
                    {p.delta !== 0 ? fmtSign(p.delta) : '—'}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
                    p.cumulativeDelta < 0 ? 'text-brand-red' : p.cumulativeDelta > 0 ? 'text-brand-green' : 'text-stone-400'
                  }`}>
                    {p.cumulativeDelta !== 0 ? fmtSign(p.cumulativeDelta) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-surface-border font-medium">
              <td className="px-2 py-2 text-stone-700">Year-end</td>
              <td className="px-2 py-2 text-right tabular-nums text-stone-600">
                {fmtCurrency(result.projections.reduce((s, p) => s + p.scenarioIncome, 0), { compact: true })}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-stone-600">
                {fmtCurrency(result.projections.reduce((s, p) => s + p.scenarioExpenses, 0), { compact: true })}
              </td>
              <td className={`px-2 py-2 text-right tabular-nums ${
                result.eoyScenarioNet < 0 ? 'text-brand-red' : 'text-stone-700'
              }`}>
                {fmt(result.eoyScenarioNet)}
              </td>
              <td className={`px-2 py-2 text-right tabular-nums ${
                result.totalDelta < 0 ? 'text-brand-red' : result.totalDelta > 0 ? 'text-brand-green' : 'text-stone-400'
              }`}>
                {result.totalDelta !== 0 ? fmtSign(result.totalDelta) : '—'}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Verdict({ result, reserves }: { result: ScenarioResult; reserves: number }) {
  if (result.totalDelta === 0) return null;

  if (result.totalDelta > 0) {
    return (
      <div className="rounded-lg border border-brand-green/30 bg-brand-green/5 px-4 py-3">
        <p className="text-sm font-medium text-brand-green">
          +{fmtCurrency(result.totalDelta)} more to save by year-end
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          Pre-savings surplus grows from {fmtCurrency(result.eoyBaseNet, { compact: true })} to {fmtCurrency(result.eoyScenarioNet, { compact: true })}.
        </p>
      </div>
    );
  }

  const savingsHit = Math.abs(result.totalDelta);

  if (result.verdict === 'needs_reserves') {
    const covered = reserves >= result.reservesDraw;
    return (
      <div className={`rounded-lg border px-4 py-3 ${covered ? 'border-brand-yellow/30 bg-brand-yellow/5' : 'border-brand-red/30 bg-brand-red/5'}`}>
        <p className={`text-sm font-medium ${covered ? 'text-brand-yellow' : 'text-brand-red'}`}>
          You'd pull {fmtCurrency(result.reservesDraw)} from savings to cover this
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          In at least one month your pre-savings income doesn't fully cover this expense.
          You'd need to draw {fmtCurrency(result.reservesDraw, { compact: true })} from savings/investments.{' '}
          {covered
            ? `You have ${fmtCurrency(reserves, { compact: true })} available — you can cover it, but that money won't be there anymore.`
            : `Your savings/investments (${fmtCurrency(reserves, { compact: true })}) fall short by ${fmtCurrency(result.reservesDraw - reserves, { compact: true })}.`}
        </p>
      </div>
    );
  }

  // comfortable or tight — pre-savings income covers it, but less goes to savings
  return (
    <div className="rounded-lg border border-brand-yellow/30 bg-brand-yellow/5 px-4 py-3">
      <p className="text-sm font-medium text-brand-yellow">
        Affordable — {fmtCurrency(savingsHit)} less to save by year-end
      </p>
      <p className="mt-0.5 text-xs text-stone-500">
        Your pre-savings income covers this each month — nothing comes out of savings.
        You'd just have {fmtCurrency(savingsHit, { compact: true })} less to put away
        ({fmtCurrency(result.eoyBaseNet, { compact: true })} → {fmtCurrency(result.eoyScenarioNet, { compact: true })} year-end surplus).
        {result.eoyScenarioNet < 0 && ' Pre-savings net goes negative — watch closely.'}
      </p>
    </div>
  );
}
