import { useState, useMemo } from 'react';
import { projectScenario, fmtCurrency, type Scenario, type ScenarioResult, type MonthBaseline } from '../lib/insights';

const CC_BASE = 5000;

interface BillLineItem {
  id:     string;
  name:   string;
  amount: number;
}

interface Props {
  monthBaselines: MonthBaseline[];
  reserves:       number;
  recurringBills: BillLineItem[];
}

type TabKind = 'recurring' | 'onetime' | 'income_change' | 'cc_budget' | 'emergency';

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
  emergency:     '🚨 Emergency',
};

export default function ImpactCalculator({ monthBaselines, reserves, recurringBills }: Props) {
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

  // ── Emergency ──
  const [emergAlex,  setEmergAlex]  = useState(true);
  const [emergMaham, setEmergMaham] = useState(false);
  const [emergCC,    setEmergCC]    = useState(true);
  const [emergCash,  setEmergCash]  = useState(true);

  // Derive per-person income and CC/cash averages from baselines
  const avgIncomeAlex  = useMemo(() => {
    const vals = monthBaselines.filter(m => m.incomeAlex != null);
    return vals.length ? vals.reduce((s, m) => s + (m.incomeAlex ?? 0), 0) / vals.length : 0;
  }, [monthBaselines]);
  const avgIncomeMaham = useMemo(() => {
    const vals = monthBaselines.filter(m => m.incomeMaham != null);
    return vals.length ? vals.reduce((s, m) => s + (m.incomeMaham ?? 0), 0) / vals.length : 0;
  }, [monthBaselines]);
  const avgCCPayment = useMemo(() => {
    const vals = monthBaselines.filter(m => m.ccPayment != null);
    return vals.length ? vals.reduce((s, m) => s + (m.ccPayment ?? 0), 0) / vals.length : 0;
  }, [monthBaselines]);
  const avgCashOut = useMemo(() => {
    const vals = monthBaselines.filter(m => m.cashOut != null);
    return vals.length ? vals.reduce((s, m) => s + (m.cashOut ?? 0), 0) / vals.length : 0;
  }, [monthBaselines]);

  const [leanCC,   setLeanCC]   = useState<number | null>(null);
  const [leanCash, setLeanCash] = useState<number | null>(null);

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

        {/* ── Emergency tab ── */}
        {tab === 'emergency' && (
          <EmergencyPanel
            reserves={reserves}
            recurringBills={recurringBills}
            avgIncomeAlex={avgIncomeAlex}
            avgIncomeMaham={avgIncomeMaham}
            avgCCPayment={avgCCPayment}
            avgCashOut={avgCashOut}
            emergAlex={emergAlex}   setEmergAlex={setEmergAlex}
            emergMaham={emergMaham} setEmergMaham={setEmergMaham}
            emergCC={emergCC}       setEmergCC={setEmergCC}
            emergCash={emergCash}   setEmergCash={setEmergCash}
            leanCC={leanCC}         setLeanCC={setLeanCC}
            leanCash={leanCash}     setLeanCash={setLeanCash}
          />
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
      {showVerdict && tab !== 'emergency' && <Verdict result={result} reserves={reserves} />}

      {/* Month-by-month table */}
      {showVerdict && tab !== 'emergency' && (
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

// ── Emergency Panel ───────────────────────────────────────────────────────────

interface EmergencyPanelProps {
  reserves:        number;
  recurringBills:  BillLineItem[];
  avgIncomeAlex:   number;
  avgIncomeMaham:  number;
  avgCCPayment:    number;
  avgCashOut:      number;
  emergAlex:  boolean; setEmergAlex:  (v: boolean) => void;
  emergMaham: boolean; setEmergMaham: (v: boolean) => void;
  emergCC:    boolean; setEmergCC:    (v: boolean) => void;
  emergCash:  boolean; setEmergCash:  (v: boolean) => void;
  leanCC:     number | null; setLeanCC:    (v: number | null) => void;
  leanCash:   number | null; setLeanCash:  (v: number | null) => void;
}

function EmergencyPanel({
  reserves,
  recurringBills,
  avgIncomeAlex, avgIncomeMaham,
  avgCCPayment, avgCashOut,
  emergAlex, setEmergAlex,
  emergMaham, setEmergMaham,
  emergCC, setEmergCC,
  emergCash, setEmergCash,
  leanCC, setLeanCC,
  leanCash, setLeanCash,
}: EmergencyPanelProps) {
  // Per-bill enabled/amount state — keyed by bill id
  const [billEnabled, setBillEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(recurringBills.map(b => [b.id, true]))
  );
  const [billAmounts, setBillAmounts] = useState<Record<string, number>>(
    () => Object.fromEntries(recurringBills.map(b => [b.id, b.amount]))
  );

  const toggleBill = (id: string) => setBillEnabled(prev => ({ ...prev, [id]: !prev[id] }));
  const setBillAmt = (id: string, v: number) => setBillAmounts(prev => ({ ...prev, [id]: v }));

  const lostIncome      = (emergAlex ? avgIncomeAlex : 0) + (emergMaham ? avgIncomeMaham : 0);
  const remainingIncome = avgIncomeAlex + avgIncomeMaham - lostIncome;

  const effectiveBills = recurringBills.reduce((s, b) => s + (billEnabled[b.id] ? (billAmounts[b.id] ?? b.amount) : 0), 0);
  const effectiveCC    = emergCC   ? (leanCC   ?? avgCCPayment) : 0;
  const effectiveCash  = emergCash ? (leanCash ?? avgCashOut)   : 0;
  const totalExpenses  = effectiveBills + effectiveCC + effectiveCash;

  const monthlyDeficit = totalExpenses - remainingIncome;
  const survivalMonths = monthlyDeficit > 0 ? reserves / monthlyDeficit : Infinity;
  const survivalYears  = survivalMonths / 12;

  const scenarioLabel =
    emergAlex && emergMaham ? 'Both lose jobs' :
    emergAlex  ? 'Alex loses job' :
    emergMaham ? 'Maham loses job' : 'No job loss selected';

  const survivalColor =
    survivalMonths < 3  ? 'text-brand-red' :
    survivalMonths < 6  ? 'text-brand-yellow' :
    'text-brand-green';

  // Month-by-month burndown (cap at 36 months)
  const burndown: { month: number; label: string; balance: number }[] = [];
  if (monthlyDeficit > 0 && reserves > 0) {
    let bal = reserves;
    for (let i = 1; bal > 0 && i <= 36; i++) {
      bal = Math.max(0, bal - monthlyDeficit);
      const d = new Date();
      d.setMonth(d.getMonth() + i);
      burndown.push({ month: i, label: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }), balance: bal });
    }
  }

  return (
    <div className="space-y-4">
      {/* Who loses job */}
      <div>
        <p className="text-xs text-stone-400 mb-2">Who loses their job?</p>
        <div className="flex gap-2">
          {[
            { label: 'Alex',  val: emergAlex,  set: setEmergAlex,  income: avgIncomeAlex  },
            { label: 'Maham', val: emergMaham, set: setEmergMaham, income: avgIncomeMaham },
          ].map(({ label, val, set, income }) => (
            <button key={label} type="button" onClick={() => set(!val)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                val ? 'border-brand-red/40 bg-brand-red/5 text-brand-red' : 'border-surface-border text-stone-500 hover:border-stone-400'
              }`}
            >
              <span className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border-2 text-[9px] ${val ? 'border-brand-red bg-brand-red text-white' : 'border-stone-300'}`}>
                {val ? '✓' : ''}
              </span>
              {label}
              <span className="tabular-nums text-xs opacity-60">{fmtCurrency(income, { compact: true })}/mo</span>
            </button>
          ))}
        </div>
        {!emergAlex && !emergMaham && (
          <p className="mt-2 text-xs text-stone-400">Select at least one person to model a job loss.</p>
        )}
      </div>

      {/* Lean expense buckets */}
      <div>
        <p className="text-xs text-stone-400 mb-2">Monthly expenses — uncheck to cut, or edit the amount</p>
        <div className="space-y-1">
          {/* Individual recurring bills */}
          {recurringBills.length > 0 && (
            <>
              <p className="text-[11px] font-medium text-stone-400 px-1 pt-1">Fixed bills</p>
              {recurringBills.map(bill => {
                const enabled = billEnabled[bill.id] ?? true;
                const amount  = billAmounts[bill.id] ?? bill.amount;
                return (
                  <div key={bill.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${enabled ? 'border-surface-border bg-surface-card' : 'border-surface-border/40 opacity-50'}`}>
                    <button type="button" onClick={() => toggleBill(bill.id)}
                      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 text-[9px] transition ${enabled ? 'border-stone-600 bg-stone-700 text-white' : 'border-stone-300'}`}>
                      {enabled ? '✓' : ''}
                    </button>
                    <span className="flex-1 text-sm text-stone-600">{bill.name}</span>
                    <input
                      type="number" step="10" min={0}
                      value={amount}
                      disabled={!enabled}
                      onChange={e => setBillAmt(bill.id, Number(e.target.value))}
                      className="w-28 rounded-md border border-surface-border bg-surface px-2 py-1 text-sm tabular-nums disabled:opacity-40"
                    />
                    <span className="text-xs text-stone-400 w-20 shrink-0">
                      {amount !== bill.amount ? `(was ${fmtCurrency(bill.amount, { compact: true })})` : '/mo'}
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {/* CC and cash buckets */}
          <p className="text-[11px] font-medium text-stone-400 px-1 pt-2">Other buckets</p>
          {([
            { label: 'CC payment',   enabled: emergCC,   setEnabled: setEmergCC,   avg: avgCCPayment, lean: leanCC,   setLean: setLeanCC   },
            { label: 'Cash / other', enabled: emergCash, setEnabled: setEmergCash, avg: avgCashOut,   lean: leanCash, setLean: setLeanCash },
          ] as const).map(({ label, enabled, setEnabled, avg, lean, setLean }) => (
            <div key={label} className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${enabled ? 'border-surface-border bg-surface-card' : 'border-surface-border/40 opacity-50'}`}>
              <button type="button" onClick={() => setEnabled(!enabled)}
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 text-[9px] transition ${enabled ? 'border-stone-600 bg-stone-700 text-white' : 'border-stone-300'}`}>
                {enabled ? '✓' : ''}
              </button>
              <span className="flex-1 text-sm text-stone-600">{label}</span>
              <input
                type="number" step="50" min={0}
                value={lean ?? Math.round(avg)}
                disabled={!enabled}
                onChange={e => setLean(Number(e.target.value))}
                className="w-28 rounded-md border border-surface-border bg-surface px-2 py-1 text-sm tabular-nums disabled:opacity-40"
              />
              <span className="text-xs text-stone-400 w-20 shrink-0">
                {lean != null && lean !== avg ? `(was ${fmtCurrency(avg, { compact: true })})` : '/mo avg'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Results */}
      {(emergAlex || emergMaham) && (
        <div className="rounded-xl border-2 border-stone-200 bg-stone-50 p-4 space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{scenarioLabel}</p>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-stone-400">Remaining income</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-stone-700">{fmtCurrency(remainingIncome, { compact: true })}/mo</p>
              <p className="mt-0.5 text-[10px] text-stone-400">from income_alex / income_maham in monthly summary</p>
            </div>
            <div>
              <p className="text-xs text-stone-400">Lean expenses</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-stone-700">{fmtCurrency(totalExpenses, { compact: true })}/mo</p>
            </div>
            <div>
              <p className="text-xs text-stone-400">Monthly deficit</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums ${monthlyDeficit > 0 ? 'text-brand-red' : 'text-brand-green'}`}>
                {monthlyDeficit > 0 ? fmtCurrency(monthlyDeficit, { compact: true }) : 'None'}
              </p>
            </div>
          </div>

          <div className={`rounded-lg border-2 p-4 text-center ${
            survivalMonths < 3  ? 'border-brand-red/40 bg-brand-red/5' :
            survivalMonths < 6  ? 'border-brand-yellow/40 bg-brand-yellow/5' :
            'border-brand-green/30 bg-brand-green/5'
          }`}>
            {monthlyDeficit <= 0 ? (
              <p className="text-sm font-medium text-brand-green">No reserves needed — remaining income covers all expenses.</p>
            ) : (
              <>
                <p className="text-xs text-stone-400">Reserves last</p>
                <p className={`mt-1 text-4xl font-bold tabular-nums ${survivalColor}`}>
                  {survivalMonths >= 36 ? `${survivalYears.toFixed(1)} yrs` : `${survivalMonths.toFixed(1)} mo`}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  {fmtCurrency(reserves, { compact: true })} ÷ {fmtCurrency(monthlyDeficit, { compact: true })}/mo deficit
                </p>
              </>
            )}
          </div>

          {burndown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border text-stone-400">
                    <th className="px-2 py-1.5 text-left font-medium">Month</th>
                    <th className="px-2 py-1.5 text-right font-medium">Reserves left</th>
                    <th className="px-2 py-1.5 pl-3 text-left font-medium" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {burndown.map(row => {
                    const pct = Math.round((row.balance / reserves) * 100);
                    const barColor = pct > 50 ? 'bg-brand-green' : pct > 20 ? 'bg-brand-yellow' : 'bg-brand-red';
                    return (
                      <tr key={row.month} className="border-b border-surface-border/50">
                        <td className="px-2 py-1.5 font-medium text-stone-600">{row.label}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
                          pct > 50 ? 'text-brand-green' : pct > 20 ? 'text-brand-yellow' : 'text-brand-red'
                        }`}>
                          {row.balance > 0 ? fmtCurrency(row.balance, { compact: true }) : '—'}
                        </td>
                        <td className="px-2 py-1.5 pl-3 w-32">
                          <div className="h-1.5 w-full rounded-full bg-stone-200">
                            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
