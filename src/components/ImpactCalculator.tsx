import { useState, useMemo } from 'react';
import { projectScenario, fmtCurrency, type Scenario, type ScenarioResult, type MonthBaseline } from '../lib/insights';

const CC_BASE = 5000;

interface Props {
  monthBaselines: MonthBaseline[];
  reserves:       number;
}

type TabKind = 'recurring' | 'onetime' | 'income_change' | 'cc_budget';

interface RecurringItem {
  id:         string;
  label:      string;
  amount:     number;
  startMonth: string;
  isIncome:   boolean;
}

interface OnetimeItem {
  id:     string;
  label:  string;
  amount: number;
  month:  string;
}

let _id = 0;
const uid = () => String(++_id);

function fmt(n: number)     { return fmtCurrency(n); }
function fmtSign(n: number) { return fmtCurrency(n, { sign: true }); }

const TAB_LABELS: Record<TabKind, string> = {
  recurring:     'Recurring Bills',
  onetime:       'One-Time',
  income_change: 'Income Change',
  cc_budget:     'CC Budget',
};

export default function ImpactCalculator({ monthBaselines, reserves }: Props) {
  const months = monthBaselines.map(m => m.month);
  const [tab, setTab] = useState<TabKind>('recurring');

  // ── Accumulated item lists (always combined in projection) ──
  const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([]);
  const [onetimeItems,   setOnetimeItems]   = useState<OnetimeItem[]>([]);

  // ── Recurring draft form ──
  const [rLabel,    setRLabel]    = useState('Car note');
  const [rAmount,   setRAmount]   = useState(450);
  const [rStart,    setRStart]    = useState(months[0] ?? '');
  const [rIsIncome, setRIsIncome] = useState(false);

  // ── One-time draft form ──
  const [oLabel,  setOLabel]  = useState('New couch');
  const [oAmount, setOAmount] = useState(5000);
  const [oMonth,  setOMonth]  = useState(months[0] ?? '');

  // ── Income change ──
  const [raisePct,   setRaisePct]   = useState(5);
  const [raiseStart, setRaiseStart] = useState(months[Math.min(3, months.length - 1)] ?? '');

  // ── CC budget ──
  const [ccExtra, setCcExtra] = useState(0);

  const eoyBaseNet       = monthBaselines.reduce((s, m) => s + m.net, 0);
  const monthlyHeadroom  = monthBaselines.length > 0 ? eoyBaseNet / monthBaselines.length : 0;

  function addRecurring() {
    if (!rAmount) return;
    setRecurringItems(prev => [...prev, { id: uid(), label: rLabel, amount: rAmount, startMonth: rStart, isIncome: rIsIncome }]);
    setRLabel('');
    setRAmount(0);
  }

  function addOnetime() {
    if (!oAmount) return;
    setOnetimeItems(prev => [...prev, { id: uid(), label: oLabel, amount: oAmount, month: oMonth }]);
    setOLabel('');
    setOAmount(0);
  }

  // Build combined scenario list from all lists + current tab's single scenario
  const scenarios: Scenario[] = useMemo(() => {
    const list: Scenario[] = [
      ...recurringItems.map(i => ({
        kind: 'recurring_expense' as const,
        label: i.label,
        amount: i.amount,
        startMonth: i.startMonth,
        isIncome: i.isIncome,
      })),
      ...onetimeItems.map(i => ({
        kind: 'one_time_purchase' as const,
        label: i.label,
        amount: i.amount,
        month: i.month,
      })),
    ];

    if (tab === 'income_change') {
      list.push({ kind: 'income_change', label: `${raisePct > 0 ? '+' : ''}${raisePct}% income`, deltaPct: raisePct, startMonth: raiseStart });
    }
    if (tab === 'cc_budget' && ccExtra > 0) {
      list.push({ kind: 'recurring_expense', label: `CC overage (+${fmt(ccExtra)}/mo)`, amount: ccExtra, startMonth: months[0] ?? '' });
    }

    return list;
  }, [recurringItems, onetimeItems, tab, raisePct, raiseStart, ccExtra, months]);

  const result = useMemo(
    () => projectScenario({ scenarios, monthBaselines }),
    [scenarios, monthBaselines],
  );

  const hasItems = recurringItems.length > 0 || onetimeItems.length > 0;
  const showVerdict = scenarios.length > 0;

  const monthLabel = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' });
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Tab switcher */}
      <div className="flex flex-wrap gap-1">
        {(Object.keys(TAB_LABELS) as TabKind[]).map(k => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              tab === k ? 'bg-stone-800 text-white' : 'bg-surface border border-surface-border text-stone-500 hover:text-stone-700'
            }`}
          >
            {TAB_LABELS[k]}
            {k === 'recurring' && recurringItems.length > 0 && (
              <span className="ml-1.5 rounded-full bg-stone-600 px-1.5 py-0.5 text-[10px] text-white">{recurringItems.length}</span>
            )}
            {k === 'onetime' && onetimeItems.length > 0 && (
              <span className="ml-1.5 rounded-full bg-stone-600 px-1.5 py-0.5 text-[10px] text-white">{onetimeItems.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="rounded-lg border border-surface-border bg-surface p-3 space-y-3">

        {/* ── Recurring Bills tab ── */}
        {tab === 'recurring' && (
          <>
            {recurringItems.length > 0 && (
              <div className="space-y-1">
                {recurringItems.map(item => (
                  <div key={item.id} className="flex items-center justify-between rounded-md bg-surface-card border border-surface-border px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${item.isIncome ? 'bg-brand-green/10 text-brand-green' : 'bg-brand-red/10 text-brand-red'}`}>
                        {item.isIncome ? 'Income' : 'Expense'}
                      </span>
                      <span className="text-stone-700 font-medium">{item.label}</span>
                      <span className="tabular-nums text-stone-500">{fmt(item.amount)}/mo</span>
                      <span className="text-stone-400 text-xs">from {monthLabel(item.startMonth)}</span>
                    </div>
                    <button type="button" onClick={() => setRecurringItems(prev => prev.filter(i => i.id !== item.id))}
                      className="text-stone-400 hover:text-brand-red text-lg leading-none px-1">×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-4 gap-3 items-end">
              <label className="block">
                <span className="text-xs text-stone-400">Name</span>
                <input type="text" value={rLabel} onChange={e => setRLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addRecurring()}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs text-stone-400">Amount/mo</span>
                <input type="number" step="25" min={0} value={rAmount || ''} onChange={e => setRAmount(Number(e.target.value))}
                  onKeyDown={e => e.key === 'Enter' && addRecurring()}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
              </label>
              <label className="block">
                <span className="text-xs text-stone-400">Starting</span>
                <select value={rStart} onChange={e => setRStart(e.target.value)}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                  {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              </label>
              <div className="flex gap-2 items-end">
                <label className="block flex-1">
                  <span className="text-xs text-stone-400">Type</span>
                  <select value={rIsIncome ? 'income' : 'expense'} onChange={e => setRIsIncome(e.target.value === 'income')}
                    className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </label>
                <button type="button" onClick={addRecurring}
                  className="rounded-md bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 shrink-0">
                  Add
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── One-Time tab ── */}
        {tab === 'onetime' && (
          <>
            {onetimeItems.length > 0 && (
              <div className="space-y-1">
                {onetimeItems.map(item => (
                  <div key={item.id} className="flex items-center justify-between rounded-md bg-surface-card border border-surface-border px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className="text-stone-700 font-medium">{item.label}</span>
                      <span className="tabular-nums text-stone-500">{fmt(item.amount)}</span>
                      <span className="text-stone-400 text-xs">in {monthLabel(item.month)}</span>
                    </div>
                    <button type="button" onClick={() => setOnetimeItems(prev => prev.filter(i => i.id !== item.id))}
                      className="text-stone-400 hover:text-brand-red text-lg leading-none px-1">×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-4 gap-3 items-end">
              <label className="block">
                <span className="text-xs text-stone-400">What</span>
                <input type="text" value={oLabel} onChange={e => setOLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addOnetime()}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs text-stone-400">Cost</span>
                <input type="number" step="100" min={0} value={oAmount || ''} onChange={e => setOAmount(Number(e.target.value))}
                  onKeyDown={e => e.key === 'Enter' && addOnetime()}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
              </label>
              <label className="block">
                <span className="text-xs text-stone-400">Month</span>
                <select value={oMonth} onChange={e => setOMonth(e.target.value)}
                  className="mt-1 w-full rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm">
                  {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              </label>
              <div className="flex items-end">
                <button type="button" onClick={addOnetime}
                  className="rounded-md bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 w-full">
                  Add
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Income Change tab ── */}
        {tab === 'income_change' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-stone-400">Change %</span>
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

        {/* ── CC Budget tab ── */}
        {tab === 'cc_budget' && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="rounded-lg bg-surface-card border border-surface-border p-3">
                <p className="text-xs text-stone-400">Base CC budget</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-stone-700">{fmt(CC_BASE)}/mo</p>
              </div>
              <div className="rounded-lg bg-surface-card border border-surface-border p-3">
                <p className="text-xs text-stone-400">Distributed headroom</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${monthlyHeadroom >= 0 ? 'text-brand-green' : 'text-brand-red'}`}>
                  {fmtSign(monthlyHeadroom)}/mo
                </p>
              </div>
              <div className="rounded-lg bg-surface-card border border-surface-border p-3">
                <p className="text-xs text-stone-400">Max CC budget</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${monthlyHeadroom >= 0 ? 'text-brand-green' : 'text-brand-red'}`}>
                  {fmt(Math.max(0, CC_BASE + monthlyHeadroom))}/mo
                </p>
              </div>
            </div>
            <label className="block">
              <span className="text-xs text-stone-400">Test extra CC spend above base ($/mo)</span>
              <input type="number" step="100" min={0} value={ccExtra || ''} onChange={e => setCcExtra(Number(e.target.value))}
                className="mt-1 w-48 rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-sm tabular-nums" />
            </label>
          </div>
        )}
      </div>

      {/* Summary of all active items across tabs */}
      {hasItems && tab !== 'recurring' && tab !== 'onetime' && (
        <div className="flex flex-wrap gap-1.5">
          {recurringItems.map(i => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface-card px-2.5 py-1 text-xs text-stone-600">
              <span className={i.isIncome ? 'text-brand-green' : 'text-brand-red'}>{i.isIncome ? '+' : '−'}</span>
              {i.label} {fmt(i.amount)}/mo
              <button type="button" onClick={() => setRecurringItems(prev => prev.filter(x => x.id !== i.id))}
                className="ml-0.5 text-stone-400 hover:text-brand-red">×</button>
            </span>
          ))}
          {onetimeItems.map(i => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface-card px-2.5 py-1 text-xs text-stone-600">
              <span className="text-brand-red">−</span>
              {i.label} {fmt(i.amount)} ({monthLabel(i.month)})
              <button type="button" onClick={() => setOnetimeItems(prev => prev.filter(x => x.id !== i.id))}
                className="ml-0.5 text-stone-400 hover:text-brand-red">×</button>
            </span>
          ))}
        </div>
      )}

      {/* Verdict */}
      {showVerdict && <Verdict result={result} reserves={reserves} />}

      {/* Month-by-month table */}
      {showVerdict && (
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
                      {p.scenarioIncome !== p.baseIncome
                        ? <span className="text-brand-green">{fmt(p.scenarioIncome)}</span>
                        : fmt(p.scenarioIncome)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-stone-600">
                      {p.scenarioExpenses !== p.baseExpenses
                        ? <span className="text-brand-red">{fmt(p.scenarioExpenses)}</span>
                        : fmt(p.scenarioExpenses)}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${p.scenarioNet < 0 ? 'text-brand-red' : 'text-stone-700'}`}>
                      {fmt(p.scenarioNet)}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${p.delta < 0 ? 'text-brand-red' : p.delta > 0 ? 'text-brand-green' : 'text-stone-400'}`}>
                      {p.delta !== 0 ? fmtSign(p.delta) : '—'}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${p.cumulativeDelta < 0 ? 'text-brand-red' : p.cumulativeDelta > 0 ? 'text-brand-green' : 'text-stone-400'}`}>
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
                <td className={`px-2 py-2 text-right tabular-nums ${result.eoyScenarioNet < 0 ? 'text-brand-red' : 'text-stone-700'}`}>
                  {fmt(result.eoyScenarioNet)}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${result.totalDelta < 0 ? 'text-brand-red' : result.totalDelta > 0 ? 'text-brand-green' : 'text-stone-400'}`}>
                  {result.totalDelta !== 0 ? fmtSign(result.totalDelta) : '—'}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
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
          Year goes negative — you'd pull {fmtCurrency(result.reservesDraw)} from savings
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          Your total income for the year doesn't cover this.{' '}
          {covered
            ? `Reserves: ${fmtCurrency(reserves, { compact: true })} → ${fmtCurrency(reserves - result.reservesDraw, { compact: true })} after draw.`
            : `Reserves: ${fmtCurrency(reserves, { compact: true })} — short by ${fmtCurrency(result.reservesDraw - reserves, { compact: true })}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-brand-green/30 bg-brand-green/5 px-4 py-3">
      <p className="text-sm font-medium text-brand-green">
        Affordable — {fmtCurrency(savingsHit)} less to save by year-end
      </p>
      <p className="mt-0.5 text-xs text-stone-500">
        Your year-end net stays positive at {fmtCurrency(result.eoyScenarioNet, { compact: true })} — this comes out of what you'd save, not your reserves.
        {result.verdict === 'tight' && ' The hit is large relative to your average monthly net — watch closely.'}
      </p>
    </div>
  );
}
