import { useState, useMemo, useEffect, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MortgageInput {
  originalAmount: number;  // original loan amount at origination
  startDate:      string;  // 'YYYY-MM' — month loan originated
  rate:           number;  // annual interest rate (%)
  escrow:         number;  // monthly escrow (taxes + insurance)
  extra:          number;  // extra monthly principal
  extraStartDate: string;  // 'YYYY-MM' — when extra payment begins
}

interface AmortYear {
  year:      number;
  interest:  number;
  principal: number;
  balance:   number;
}

// ── Math ──────────────────────────────────────────────────────────────────────

/** Standard fixed-rate mortgage payment: P * r(1+r)^n / ((1+r)^n - 1) */
function computePayment(principal: number, monthlyRate: number, termMonths = 360): number {
  if (monthlyRate === 0) return principal / termMonths;
  const factor = Math.pow(1 + monthlyRate, termMonths);
  return principal * (monthlyRate * factor) / (factor - 1);
}

/** Remaining balance after k payments on original loan. */
function computeBalance(principal: number, monthlyRate: number, payment: number, monthsPaid: number): number {
  if (monthlyRate === 0) return Math.max(0, principal - payment * monthsPaid);
  const factor = Math.pow(1 + monthlyRate, monthsPaid);
  return Math.max(0, principal * factor - payment * (factor - 1) / monthlyRate);
}

/** Payments made from 'YYYY-MM' start through the current month (inclusive). */
function monthsElapsed(startDate: string): number {
  if (!startDate) return 0;
  const [sy, sm] = startDate.split('-').map(Number);
  const now = new Date();
  return Math.max(0, (now.getFullYear() - sy) * 12 + (now.getMonth() + 1 - sm) + 1);
}

/** 'YYYY-MM' for a given year+month (1-based). */
function toYM(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

interface SimResult {
  payoffDate:    Date;
  totalInterest: number;
  amort:         AmortYear[];
}

/**
 * Simulate from current balance forward, applying `extra` only from `extraStartYM`.
 * Pass extraStartYM='' or extra=0 for baseline.
 */
function simulate(
  balance: number,
  monthlyRate: number,
  payment: number,
  extra: number,
  extraStartYM: string,
): SimResult {
  let bal = balance;
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-based, current month

  let totalInterest = 0;
  const amort: AmortYear[] = [];
  let yearInterest = 0;
  let yearPrincipal = 0;
  let currentYear = year;
  let iterations = 0;

  while (bal > 0.01 && iterations++ < 10000) {
    const ym = toYM(year, month);
    const thisExtra = (extra > 0 && extraStartYM && ym >= extraStartYM) ? extra : 0;
    const interest  = bal * monthlyRate;
    const principal = Math.min(payment - interest + thisExtra, bal);
    totalInterest += interest;
    yearInterest  += interest;
    yearPrincipal += principal;
    bal = Math.max(0, bal - principal);

    // Advance month
    month++;
    if (month > 12) { month = 1; year++; }

    // Flush year bucket when year rolls over or loan ends
    if (year !== currentYear || bal <= 0.01) {
      amort.push({ year: currentYear, interest: yearInterest, principal: yearPrincipal, balance: bal });
      yearInterest = 0; yearPrincipal = 0; currentYear = year;
    }
  }

  // `year` and `month` now point to the month after last payment
  const payoffDate = new Date(year, month - 1, 1);
  return { payoffDate, totalInterest, amort };
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function fmtExact(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// ── Input fields ──────────────────────────────────────────────────────────────

function Field({
  label, value, onChange, prefix, suffix, step, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  prefix?: string; suffix?: string; step?: number; hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-stone-400">{label}</span>
      {hint && <span className="ml-1.5 text-[10px] text-stone-300">{hint}</span>}
      <div className="mt-1 flex items-center rounded-md border border-surface-border bg-surface-card overflow-hidden">
        {prefix && <span className="px-2 text-sm text-stone-400 select-none border-r border-surface-border bg-surface">{prefix}</span>}
        <input
          type="number" step={step ?? 1} min={0} value={value || ''}
          onChange={e => onChange(Number(e.target.value))}
          className="flex-1 px-2 py-1.5 text-sm tabular-nums bg-transparent outline-none min-w-0"
        />
        {suffix && <span className="px-2 text-sm text-stone-400 select-none border-l border-surface-border bg-surface">{suffix}</span>}
      </div>
    </label>
  );
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function MonthField({ label, value, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  const split = value ? value.split('-') : ['', ''];
  const [localY, setLocalY] = useState(split[0] || '');
  const [localM, setLocalM] = useState(split[1] || '');

  // Sync if parent value changes (e.g. after DB load)
  useEffect(() => {
    const p = value ? value.split('-') : ['', ''];
    setLocalY(p[0] || '');
    setLocalM(p[1] || '');
  }, [value]);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 31 }, (_, i) => currentYear - 30 + i);

  function handleMonth(newM: string) {
    setLocalM(newM);
    if (localY && newM) onChange(`${localY}-${newM}`);
  }

  function handleYear(newY: string) {
    setLocalY(newY);
    if (newY && localM) onChange(`${newY}-${localM}`);
  }

  return (
    <div className="block">
      <span className="text-xs text-stone-400">{label}</span>
      {hint && <span className="ml-1.5 text-[10px] text-stone-300">{hint}</span>}
      <div className="mt-1 flex gap-1.5">
        <select
          value={localM}
          onChange={e => handleMonth(e.target.value)}
          className="flex-1 px-2 py-1.5 text-sm rounded-md border border-surface-border bg-surface-card outline-none"
        >
          <option value="">Month</option>
          {MONTHS.map((mo, i) => (
            <option key={mo} value={String(i + 1).padStart(2, '0')}>{mo}</option>
          ))}
        </select>
        <select
          value={localY}
          onChange={e => handleYear(e.target.value)}
          className="flex-1 px-2 py-1.5 text-sm rounded-md border border-surface-border bg-surface-card outline-none"
        >
          <option value="">Year</option>
          {years.map(yr => <option key={yr} value={yr}>{yr}</option>)}
        </select>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-card p-3">
      <p className="text-xs text-stone-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${color ?? 'text-stone-700'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-stone-400">{sub}</p>}
    </div>
  );
}

// ── Property panel ────────────────────────────────────────────────────────────

const DEFAULTS: Record<string, Partial<MortgageInput>> = {
  Kirby:   { rate: 6.5, escrow: 500 },
  Kennedy: { rate: 7.0, escrow: 400 },
};

function todayYM(): string {
  const now = new Date();
  return toYM(now.getFullYear(), now.getMonth() + 1);
}

function PropertyPanel({ name, dbId }: { name: string; dbId: string }) {
  const defaults = DEFAULTS[name] ?? {};
  const [inputs, setInputs] = useState<MortgageInput>({
    originalAmount: 0,
    startDate:      '',
    rate:           defaults.rate   ?? 6.5,
    escrow:         defaults.escrow ?? 400,
    extra:          0,
    extraStartDate: todayYM(),
  });
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/mortgage')
      .then(r => r.json() as Promise<{ accounts: Array<{
        id: string; original_amount: number; start_date: string | null;
        rate: number; escrow: number; extra: number; extra_start_date: string | null;
      }> }>)
      .then(data => {
        const row = data.accounts?.find(a => a.id === dbId);
        if (row) {
          setInputs({
            originalAmount: Number(row.original_amount) || 0,
            startDate:      row.start_date ?? '',
            rate:           Number(row.rate)   || (defaults.rate   ?? 6.5),
            escrow:         Number(row.escrow) || (defaults.escrow ?? 400),
            extra:          Number(row.extra)  || 0,
            extraStartDate: row.extra_start_date ?? todayYM(),
          });
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbId]);

  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch('/api/mortgage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: dbId, name,
          originalAmount: inputs.originalAmount,
          startDate:      inputs.startDate,
          rate:           inputs.rate,
          escrow:         inputs.escrow,
          extra:          inputs.extra,
          extraStartDate: inputs.extraStartDate,
        }),
      }).catch(() => {});
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [inputs, loaded, dbId, name]);

  const set = (key: keyof MortgageInput) => (v: number) =>
    setInputs(prev => ({ ...prev, [key]: v }));
  const setStr = (key: keyof MortgageInput) => (v: string) =>
    setInputs(prev => ({ ...prev, [key]: v }));

  const monthlyRate = inputs.rate / 100 / 12;

  const calc = useMemo(() => {
    const { originalAmount, startDate, escrow, extra, extraStartDate } = inputs;
    if (!originalAmount || !startDate || monthlyRate <= 0) return null;

    const payment = computePayment(originalAmount, monthlyRate);
    const paid    = monthsElapsed(startDate);
    const balance = computeBalance(originalAmount, monthlyRate, payment, paid);
    if (balance <= 0.01) return null;

    // Standard payoff = start date + 360 months exactly
    const [sy, sm] = startDate.split('-').map(Number);
    const standardPayoff = new Date(sy + 30, sm - 1, 1);

    const baseline = simulate(balance, monthlyRate, payment, 0, '');
    const withExtra = extra > 0
      ? simulate(balance, monthlyRate, payment, extra, extraStartDate || todayYM())
      : baseline;

    const monthsSaved   = Math.round(
      (baseline.payoffDate.getTime() - withExtra.payoffDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
    );
    const interestSaved = baseline.totalInterest - withExtra.totalInterest;

    return {
      payment, balance, paid,
      standardPayoff,
      monthlyTotal:      payment + escrow,
      monthlyTotalExtra: payment + extra + escrow,
      payoff:   baseline.payoffDate,
      payoffEx: withExtra.payoffDate,
      totalInt:   baseline.totalInterest,
      totalIntEx: withExtra.totalInterest,
      monthsSaved,
      interestSaved,
      amort:      baseline.amort,
      amortExtra: withExtra.amort,
    };
  }, [inputs, monthlyRate]);

  const hasExtra = inputs.extra > 0;

  return (
    <div className="space-y-5">
      {/* Inputs */}
      <div className="rounded-xl border border-surface-border bg-surface p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Original Loan Amount" value={inputs.originalAmount} onChange={set('originalAmount')} prefix="$" step={1000} />
          </div>
          <MonthField label="Loan Start Date" value={inputs.startDate} onChange={setStr('startDate')} hint="month originated" />
          <Field label="Interest Rate" value={inputs.rate} onChange={set('rate')} suffix="%" step={0.125} />
          <Field label="Escrow" value={inputs.escrow} onChange={set('escrow')} prefix="$" step={25} hint="taxes + insurance" />
          <Field label="Extra Payment" value={inputs.extra} onChange={set('extra')} prefix="$" step={50} hint="extra principal/mo" />
          {inputs.extra > 0 && (
            <MonthField label="Extra Starts" value={inputs.extraStartDate} onChange={setStr('extraStartDate')} hint="first month of extra" />
          )}
        </div>

        {/* Computed P&I display */}
        {calc && (
          <div className="rounded-md bg-stone-50 border border-stone-100 px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-stone-400">Computed monthly P&I</span>
            <span className="text-sm font-semibold tabular-nums text-stone-700">{fmtExact(calc.payment)}</span>
          </div>
        )}
      </div>

      {!calc ? (
        <p className="text-xs text-stone-400">Enter loan amount and start date to see projections.</p>
      ) : (
        <>
          {/* Current snapshot */}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-stone-400 mb-2">Current</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Monthly total" value={fmtExact(calc.monthlyTotal)} sub="P&I + escrow" />
              <Stat label="Remaining balance" value={fmt(calc.balance)} sub={`after ${calc.paid} payments`} />
              <Stat label="Payoff date" value={fmtDate(calc.standardPayoff)} sub="30-yr schedule" />
              <Stat label="Interest remaining" value={fmt(calc.totalInt)} color="text-brand-red" />
            </div>
          </div>

          {/* Early payoff */}
          {hasExtra && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone-400 mb-2">
                With {fmtExact(inputs.extra)}/mo extra
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Monthly total" value={fmtExact(calc.monthlyTotalExtra)} sub="P&I + escrow + extra" />
                <Stat label="Time saved" value={`${calc.monthsSaved} mo`} sub={`${(calc.monthsSaved / 12).toFixed(1)} yrs earlier`} color="text-brand-green" />
                <Stat label="New payoff" value={fmtDate(calc.payoffEx)} color="text-brand-green" />
                <Stat label="Interest remaining" value={fmt(calc.totalIntEx)} color="text-brand-red" />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-brand-green/30 bg-brand-green/5 px-4 py-3">
                  <p className="text-xs text-stone-400">Time saved</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-brand-green">{calc.monthsSaved} mo</p>
                  <p className="text-xs text-stone-400">{(calc.monthsSaved / 12).toFixed(1)} years earlier</p>
                </div>
                <div className="rounded-lg border border-brand-green/30 bg-brand-green/5 px-4 py-3">
                  <p className="text-xs text-stone-400">Interest saved</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums text-brand-green">{fmt(calc.interestSaved)}</p>
                  <p className="text-xs text-stone-400">{((calc.interestSaved / calc.totalInt) * 100).toFixed(0)}% of total interest</p>
                </div>
              </div>
            </div>
          )}

          <AmortTable baseline={calc.amort} extra={hasExtra ? calc.amortExtra : null} hasExtra={hasExtra} />
        </>
      )}
    </div>
  );
}

// ── Amortization table ────────────────────────────────────────────────────────

function AmortTable({ baseline, extra, hasExtra }: {
  baseline: AmortYear[]; extra: AmortYear[] | null; hasExtra: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-stone-600 transition-colors">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        {open ? 'Hide' : 'Show'} year-by-year amortization
      </button>

      {open && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50 text-stone-400">
                <th className="px-3 py-2 text-left font-medium">Year</th>
                <th className="px-3 py-2 text-right font-medium">Interest</th>
                <th className="px-3 py-2 text-right font-medium">Principal</th>
                <th className="px-3 py-2 text-right font-medium">Balance</th>
                {hasExtra && (
                  <>
                    <th className="px-3 py-2 text-right font-medium border-l border-stone-100 text-brand-green">Balance (early)</th>
                    <th className="px-3 py-2 text-right font-medium text-brand-green">Saved</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {baseline.map((row, i) => {
                const exRow = extra?.[i];
                const saved = exRow ? row.balance - exRow.balance : 0;
                const paidOff = exRow && exRow.balance <= 0.01 && row.balance > 0.01;
                return (
                  <tr key={row.year} className={`hover:bg-stone-50 ${paidOff ? 'bg-brand-green/5' : ''}`}>
                    <td className="px-3 py-2 font-medium text-stone-700">{row.year}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-500">{fmt(row.interest)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-600">{fmt(row.principal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-700">
                      {row.balance > 0.01 ? fmt(row.balance) : <span className="text-brand-green font-semibold">Paid off</span>}
                    </td>
                    {hasExtra && (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-brand-green border-l border-stone-100">
                          {exRow && exRow.balance > 0.01 ? fmt(exRow.balance) : <span className="font-semibold">Paid off</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-brand-green">
                          {saved > 1 ? fmt(saved) : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function MortgageCalculator() {
  const [activeProperty, setActiveProperty] = useState<'Kirby' | 'Kennedy'>('Kirby');

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['Kirby', 'Kennedy'] as const).map(name => (
          <button key={name} type="button" onClick={() => setActiveProperty(name)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeProperty === name
                ? 'bg-stone-800 text-white'
                : 'border border-surface-border text-stone-500 hover:text-stone-700 hover:bg-surface-hover'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <PropertyPanel key={activeProperty} name={activeProperty} dbId={activeProperty.toLowerCase()} />
    </div>
  );
}
