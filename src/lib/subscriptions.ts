// Cadence-based recurring-charge detection for the Analyze > Subscriptions tab.
// Pure logic (no DB, no DOM): timing regularity is the signal. Amount stability
// is only enforced for monthly finds — quarterly+ charges (FabFitFun, HOA dues)
// drift too much in size for that gate to work.
import { normalizeVendor } from './vendor-match';

export const CHECKING_LAST4 = '2605';

export interface SubTxn {
  date: string;
  description: string;
  amount: number;
  type: string | null;
  account_last4: string;
}

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type Confidence = 'confirmed' | 'possible';

export interface CadencedSubscription {
  key: string;                    // dismiss key: normalized vendor + account
  vendor: string;                 // display name (longest raw description)
  alias: string;                  // normalized vendor (for bill mapping)
  account_last4: string;
  cadence: Cadence | 'irregular';
  confidence: Confidence;
  intervalMedianDays: number | null;
  typical: number;                // median event amount
  minAmount: number;
  maxAmount: number;
  events: number;                 // merged event count
  charges: number;                // raw transaction count
  firstSeen: string;
  lastSeen: string;
  nextExpected: string | null;
  overdue: boolean;
  periods: string[];              // event months (YYYY-MM) for display chips
  due_day: number | null;
  annualEst: number;
}

export interface SubscriptionScan {
  confirmed: CadencedSubscription[];
  possible: CadencedSubscription[];
  irregular: CadencedSubscription[];
}

const DAY = 86400000;
const CADENCES: { cadence: Cadence; days: number; perYear: number; minEvents: number }[] = [
  { cadence: 'monthly',    days: 30.44,  perYear: 12, minEvents: 4 },
  { cadence: 'quarterly',  days: 91.31,  perYear: 4,  minEvents: 5 },
  { cadence: 'semiannual', days: 182.62, perYear: 2,  minEvents: 4 },
  { cadence: 'annual',     days: 365.25, perYear: 1,  minEvents: 3 },
];
const CONFIRM_TOL = 0.20;   // median gap within ±20% of a cadence (or a multiple of it)
const POSSIBLE_TOL = 0.35;  // looser second pass for the "Possible" section
const MERGE_GAP_DAYS = 6;   // same-week charges (installments) count as one event
const MIN_GAP_DAYS = 21;    // faster than this is a spend habit, not a subscription
const ANNUAL_MIN_SPAN = 300;
const ANNUAL_CONFIRM_SPAN = 600;
const MODE_FREQ_MIN = 0.6;  // ≥60% of events within 2% of the median = fixed-price sub
const MONTHLY_SPREAD_MAX = 1.0; // (max-min)/median ceiling for streak-based monthly
const MIN_TYPICAL = 1.0;    // ignore sub-dollar noise (verification micro-deposits)

export function dismissKey(alias: string, account_last4: string): string {
  return `${alias}||${account_last4}`;
}

function isPurchase(t: SubTxn): boolean {
  return t.amount < 0 && t.type?.toLowerCase() !== 'payment';
}

// Payment-processor segments carry per-payment reference codes
// ("PL*NeighborhoodM WEB PMTS 2FM2C8 WEB ID: 9000801046") that defeat plain
// normalization — every charge looks like a new vendor. Cut them before grouping.
export function groupAlias(description: string): string {
  // Cut processor tails first ("PL*NeighborhoodM WEB PMTS 2FM2C8 WEB ID: …").
  let s = description.replace(/\s+web\s+(pmts|pmnt|single|id)\b.*/i, '').trim();
  // Drop 2-letter processor prefixes ("PL*NeighborhoodM" → "NeighborhoodM").
  // Without this, normalizeVendor's trailing "*SUFFIX" rule eats the whole
  // name down to "PL".
  s = s.replace(/^[a-z]{2}\*/i, '');
  return normalizeVendor(s) || normalizeVendor(description);
}

function dayNum(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / DAY);
}

function isoFromDay(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Fit { cadence: Cadence; perYear: number; minEvents: number; multiples: number }

// Fit a median gap to the nearest cadence, allowing skipped cycles for
// sub-annual cadences (a ~203-day gap is 2× quarterly). Annual never allows
// multiples — a "skipped year" can't be established from ~2 years of history.
// Prefers fewer skipped cycles, then closest fit.
function fitCadence(gap: number, tol: number): Fit | null {
  const cands: (Fit & { err: number })[] = [];
  for (let k = 1; k <= 3; k++) {
    for (const c of CADENCES) {
      if (c.cadence === 'annual' && k > 1) continue;
      const err = Math.abs(gap - k * c.days) / (k * c.days);
      if (err <= tol) cands.push({ cadence: c.cadence, perYear: c.perYear, minEvents: c.minEvents, multiples: k, err });
    }
  }
  cands.sort((a, b) => a.multiples - b.multiples || a.err - b.err);
  return cands[0] ?? null;
}

// Legacy signal, kept narrow: charges in 2+ consecutive calendar months with
// stable amounts. On its own it only qualifies for Possible — it used to
// confirm on a single stable pair (two garage-flooring installments, …).
function legacyPairStable(byMonth: Map<string, number>): boolean {
  const months = [...byMonth.keys()].sort();
  return months.some((ym, i) => {
    if (i === 0) return false;
    const [y1, m1] = months[i - 1]!.split('-').map(Number);
    const [y2, m2] = ym.split('-').map(Number);
    if (y2! * 12 + m2! !== y1! * 12 + m1! + 1) return false;
    const a1 = byMonth.get(months[i - 1]!)!;
    const a2 = byMonth.get(ym)!;
    return Math.abs(a1 - a2) / ((a1 + a2) / 2) <= 0.10;
  });
}

interface MergedEvent { date: string; amount: number }

function analyzeGroup(key: string, rows: SubTxn[], today: string): CadencedSubscription | null {
  const sep = key.lastIndexOf('||');
  const alias = key.slice(0, sep);
  const account_last4 = key.slice(sep + 2);
  if (alias.length <= 2) return null; // over-stripped stub ("SQ", "DD") — not a vendor

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  // Merge same-week charges (installments / duplicate postings) into one event.
  const events: MergedEvent[] = [];
  for (const t of sorted) {
    const amt = Math.abs(t.amount);
    const last = events[events.length - 1];
    if (last && dayNum(t.date) - dayNum(last.date) <= MERGE_GAP_DAYS) {
      last.amount = round2(last.amount + amt);
    } else {
      events.push({ date: t.date, amount: amt });
    }
  }
  if (events.length < 2) return null;

  const gaps = events.slice(1).map((e, i) => dayNum(e.date) - dayNum(events[i]!.date));
  const med = median(gaps);
  if (med < MIN_GAP_DAYS) return null; // spend habit (daily/weekly), not a subscription

  const amounts = events.map(e => e.amount);
  const typical = median(amounts);
  const minAmount = Math.min(...amounts);
  const maxAmount = Math.max(...amounts);
  const vendor = rows.reduce((best, t) => (t.description.length > best.length ? t.description : best), '');
  const days = events.map(e => parseInt(e.date.slice(8, 10), 10));
  const due_day = Math.round(median(days));
  const periods = [...new Set(events.map(e => e.date.slice(0, 7)))].sort();
  const firstSeen = events[0]!.date;
  const lastSeen = events[events.length - 1]!.date;
  const spanDays = dayNum(lastSeen) - dayNum(firstSeen);

  const base = {
    key, vendor, alias, account_last4,
    typical: round2(typical), minAmount: round2(minAmount), maxAmount: round2(maxAmount),
    events: events.length, charges: rows.length,
    firstSeen, lastSeen, periods, due_day,
    intervalMedianDays: Math.round(med * 10) / 10,
  };

  const finish = (
    cadence: Cadence | 'irregular',
    confidence: Confidence,
    perYear: number | null,
    sum: number,
  ): CadencedSubscription => {
    let nextExpected: string | null = null;
    let overdue = false;
    if (cadence !== 'irregular') {
      const nextDay = dayNum(lastSeen) + Math.round(med);
      nextExpected = isoFromDay(nextDay);
      overdue = dayNum(today) > nextDay + Math.round(med * 0.2);
    }
    const annualEst = perYear !== null
      ? round2(typical * perYear)
      : round2(spanDays > 0 ? (sum * 365) / spanDays : sum);
    return { ...base, cadence, confidence, nextExpected, overdue, annualEst };
  };

  const sum = round2(amounts.reduce((s, a) => s + a, 0));
  const byMonth = new Map<string, number>();
  for (const e of events) {
    const ym = e.date.slice(0, 7);
    byMonth.set(ym, round2((byMonth.get(ym) ?? 0) + e.amount));
  }

  // Monthly evidence. Fixed-price subs repeat the same amount (Spotify, Hulu —
  // tolerating a few odd add-on charges); usage bills (water, power) show up
  // as long unbroken month streaks instead.
  const spread = typical > 0 ? (maxAmount - minAmount) / typical : 0;
  const inMode = typical > 0 ? amounts.filter(a => Math.abs(a - typical) / typical <= 0.02).length : 0;
  // Small-n mode fractions are meaningless (2 of 3 identical = coincidence),
  // so demand at least 3 in-mode charges and ≥60% overall.
  const modeCount = Math.max(3, Math.ceil(amounts.length * MODE_FREQ_MIN));
  const monthNums = periods.map(p => {
    const [y, m] = p.split('-').map(Number);
    return y! * 12 + m!;
  });
  let streak = 1;
  let run = 1;
  for (let i = 1; i < monthNums.length; i++) {
    run = monthNums[i]! === monthNums[i - 1]! + 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }
  if (typical >= MIN_TYPICAL && events.length >= 3
      && (inMode >= modeCount || (streak >= 5 && spread <= MONTHLY_SPREAD_MAX))) {
    return finish('monthly', 'confirmed', 12, sum);
  }

  // Strict interval fit for longer cadences. Quarterly needs depth — 3-4
  // sightings at roughly quarterly gaps are usually habits, not subscriptions
  // (hence no amount gate here either: FabFitFun's amounts swing 30×).
  const fit = fitCadence(med, CONFIRM_TOL);
  if (fit && fit.cadence !== 'monthly' && events.length >= fit.minEvents
      && (fit.cadence !== 'annual' || (spanDays >= ANNUAL_CONFIRM_SPAN && spread <= 0.5))) {
    return finish(fit.cadence, 'confirmed', fit.perYear, sum);
  }

  // Possible section: review queue, not verdicts. Two sightings can be
  // coincidence (any two restaurant visits fit *something*), so non-annual
  // cadences need 3+ events; annual allows exactly 2 but demands a strict
  // timing fit, enough span, and corroborating amounts.
  const loose = fitCadence(med, POSSIBLE_TOL);
  if (typical >= MIN_TYPICAL && loose && events.length >= 3 && loose.cadence !== 'annual') {
    return finish(loose.cadence, 'possible', loose.perYear, sum);
  }
  if (typical >= MIN_TYPICAL && events.length === 2 && spanDays >= ANNUAL_MIN_SPAN && spread <= 0.5) {
    const strict = fitCadence(med, CONFIRM_TOL);
    if (strict && strict.cadence === 'annual') {
      return finish('annual', 'possible', 1, sum);
    }
  }
  // Stable-pair monthly signal with real depth (variable usage bills live here).
  if (typical >= MIN_TYPICAL && events.length >= 3
      && (legacyPairStable(byMonth) || loose?.cadence === 'monthly')) {
    return finish('monthly', 'possible', 12, sum);
  }

  // Path 4 — repeating but no cadence fits (installment-style dues, irregular HOA).
  if (events.length >= 4) {
    return finish('irregular', 'confirmed', null, sum);
  }
  return null;
}

export function detectSubscriptions(
  txns: SubTxn[],
  dismissed: Set<string> = new Set(),
  todayIso?: string,
): SubscriptionScan {
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  const groups = new Map<string, SubTxn[]>();
  for (const t of txns) {
    if (!isPurchase(t)) continue;
    if (normalizeVendor(t.description).startsWith('AMAZON')) continue;
    const key = dismissKey(groupAlias(t.description), t.account_last4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const scan: SubscriptionScan = { confirmed: [], possible: [], irregular: [] };
  for (const [key, rows] of groups) {
    if (dismissed.has(key)) continue;
    const sub = analyzeGroup(key, rows, today);
    if (!sub) continue;
    if (sub.cadence === 'irregular') scan.irregular.push(sub);
    else if (sub.confidence === 'confirmed') scan.confirmed.push(sub);
    else scan.possible.push(sub);
  }

  const byValue = (
    a: CadencedSubscription,
    b: CadencedSubscription,
  ): number => Number(b.overdue) - Number(a.overdue) || b.annualEst - a.annualEst;
  const byAnnual = (
    a: CadencedSubscription,
    b: CadencedSubscription,
  ): number => b.annualEst - a.annualEst;
  scan.confirmed.sort(byValue);
  scan.possible.sort(byAnnual);
  scan.irregular.sort(byAnnual);
  return scan;
}
