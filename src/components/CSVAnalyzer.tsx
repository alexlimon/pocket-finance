import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { normalizeVendor } from '../lib/vendor-match';
import { detectSubscriptions, groupAlias, CHECKING_LAST4, type CadencedSubscription, type Cadence } from '../lib/subscriptions';
import MortgageCalculator from './MortgageCalculator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CsvTransaction {
  id: string;
  account_last4: string;
  account_source: string;
  date: string;
  post_date: string | null;
  description: string;
  category: string | null;
  type: string | null;
  amount: number;
  memo: string | null;
  uploaded_at: string;
}

interface GmailStatus {
  connected:    boolean;
  lastSync:     string | null;
  ordersCount:  number;
  matchedCount: number;
}

interface AmazonMatch {
  txn_id:         string;
  order_id:       string;
  order_total:    number;
  shipment_count: number;
  all_items_raw:  string | null;
}

type Tab = 'upload' | 'suggestions' | 'subscriptions' | 'categories' | 'amazon' | 'statements' | 'top' | 'vendors' | 'mortgage';
type Granularity = 'month' | 'quarter';

interface Props {
  initialTransactions: string;
  initialGmailStatus:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function isPurchase(t: CsvTransaction): boolean {
  return t.amount < 0 && t.type?.toLowerCase() !== 'payment';
}

// Checking = the 2605 account. Everything else is a credit card.
// Matched on last4 only: account_source is unreliable for older rows
// (non-3606 uploads used to be tagged 'checking' regardless of account).
function isCheckingTxn(t: Pick<CsvTransaction, 'account_source' | 'account_last4'>): boolean {
  return t.account_last4 === '2605';
}

// UTC weekday, parsed manually to avoid local-timezone drift. 0 = Sun … 6 = Sat.
function isWeekend(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

// The n calendar months immediately before `ym` (YYYY-MM), oldest→newest.
function priorMonths(ym: string, n: number): string[] {
  const [y, m] = ym.split('-').map(Number);
  const base = y * 12 + (m - 1);
  return Array.from({ length: n }, (_, i) => {
    const idx = base - n + i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
}

// Calendar-quarter key for a date, e.g. "2026-Q1".
function quarterKey(iso: string): string {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

function periodKey(iso: string, granularity: Granularity): string {
  return granularity === 'month' ? iso.slice(0, 7) : quarterKey(iso);
}

function periodLabel(period: string, granularity: Granularity): string {
  if (granularity === 'month') return monthLabel(period);
  const [y, q] = period.split('-Q');
  return `Q${q} ${y}`;
}

// ISO date of the first day of a period, for comparing against an account's earliest transaction.
function periodStartDate(period: string, granularity: Granularity): string {
  if (granularity === 'month') return `${period}-01`;
  const [y, q] = period.split('-Q').map(Number);
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

// The n periods (months or quarters) immediately before `period`, oldest→newest.
function priorPeriods(period: string, n: number, granularity: Granularity): string[] {
  if (granularity === 'month') return priorMonths(period, n);
  const [y, q] = period.split('-Q').map(Number);
  const base = y * 4 + (q - 1);
  return Array.from({ length: n }, (_, i) => {
    const idx = base - n + i;
    return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`;
  });
}

// ── Computations ──────────────────────────────────────────────────────────────

// (Subscription detection lives in ../lib/subscriptions — cadence engine.)

interface CategoryRow { cat: string; amount: number; pct: number; count: number }

function categorizeSpend(txns: CsvTransaction[]): CategoryRow[] {
  const purchases = txns.filter(isPurchase);
  const byCategory = new Map<string, { amount: number; count: number }>();
  for (const t of purchases) {
    const cat = t.category || 'Other';
    const existing = byCategory.get(cat) ?? { amount: 0, count: 0 };
    byCategory.set(cat, { amount: existing.amount + Math.abs(t.amount), count: existing.count + 1 });
  }
  const total = [...byCategory.values()].reduce((s, v) => s + v.amount, 0);
  return [...byCategory.entries()]
    .map(([cat, { amount, count }]) => ({ cat, amount, count, pct: total > 0 ? amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

interface AmazonData {
  allPurchases: CsvTransaction[];
  byMonth: [string, number][];
  total: number;
}

function getAmazonData(txns: CsvTransaction[]): AmazonData {
  const amazon = txns.filter(t => t.account_last4 === '3606' && isPurchase(t));
  const byMonth = new Map<string, number>();
  for (const t of amazon) {
    const m = t.date.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + Math.abs(t.amount));
  }
  return {
    allPurchases: [...amazon].sort((a, b) => b.date.localeCompare(a.date)),
    byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    total: amazon.reduce((s, t) => s + Math.abs(t.amount), 0),
  };
}

interface StatementMonth { month: string; count: number; total: number }

function getStatements(txns: CsvTransaction[], account_last4: string): StatementMonth[] {
  const rows = txns.filter(t => t.account_last4 === account_last4 && isPurchase(t));
  const byMonth = new Map<string, { count: number; total: number }>();
  for (const t of rows) {
    const m = t.date.slice(0, 7);
    const existing = byMonth.get(m) ?? { count: 0, total: 0 };
    byMonth.set(m, { count: existing.count + 1, total: existing.total + Math.abs(t.amount) });
  }
  return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, { count, total }]) => ({ month, count, total }));
}

interface AccountInfo {
  last4: string; label: string; source: string;
  count: number; minDate: string; maxDate: string; lastUpload: string;
}

function buildAccountInfo(txns: CsvTransaction[]): Map<string, AccountInfo> {
  const map = new Map<string, AccountInfo>();
  const labels: Record<string, string> = { '2605': 'Chase Checking', '3606': 'Amazon CC' };
  for (const t of txns) {
    if (!map.has(t.account_last4)) {
      map.set(t.account_last4, {
        last4: t.account_last4,
        label: labels[t.account_last4] ?? `Chase ···${t.account_last4}`,
        source: t.account_source, count: 0,
        minDate: t.date, maxDate: t.date, lastUpload: t.uploaded_at,
      });
    }
    const a = map.get(t.account_last4)!;
    a.count++;
    if (t.date < a.minDate) a.minDate = t.date;
    if (t.date > a.maxDate) a.maxDate = t.date;
    if (t.uploaded_at > a.lastUpload) a.lastUpload = t.uploaded_at;
  }
  return map;
}

const ACCOUNT_LABELS: Record<string, string> = { '2605': 'Checking', '3606': 'Amazon CC' };
function acctLabel(last4: string): string { return `${ACCOUNT_LABELS[last4] ?? 'Acct'} ···${last4}`; }

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-6 py-10 text-center text-sm text-stone-400">
      {message}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-stone-700">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-stone-400">{subtitle}</p>}
    </div>
  );
}

// ── Panel: Upload ─────────────────────────────────────────────────────────────

function UploadPanel({
  accountInfo,
  uploading, uploadMsg,
  onUpload, onClearAccount,
  gmailStatus, gmailSyncing, gmailSyncMsg,
  onGmailSync,
  amazonUploading, amazonMsg,
  onAmazonUpload,
}: {
  accountInfo:      Map<string, AccountInfo>;
  uploading:        boolean;
  uploadMsg:        string;
  onUpload:         (file: File) => void;
  onClearAccount:   (last4: string) => void;
  gmailStatus:      GmailStatus;
  gmailSyncing:     boolean;
  gmailSyncMsg:     string;
  onGmailSync:      () => void;
  amazonUploading:  boolean;
  amazonMsg:        string;
  onAmazonUpload:   (file: File) => void;
}) {
  const chaseRef  = useRef<HTMLInputElement>(null);
  const amazonRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div className="space-y-8">

      {/* ── Chase CSV ── */}
      <div>
        <SectionHeader
          title="Chase CSV Files"
          subtitle="Export from Chase → Accounts → Download Account Activity. Account is detected from filename."
        />
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault(); setDragging(false);
            Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.csv')).forEach(onUpload);
          }}
          onClick={() => chaseRef.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors
            ${dragging ? 'border-lime-500 bg-lime-50' : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-white'}`}
        >
          <input ref={chaseRef} type="file" accept=".csv,.CSV" multiple className="sr-only"
            onChange={e => { Array.from(e.target.files ?? []).forEach(onUpload); e.target.value = ''; }} />
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-stone-200 text-stone-500 text-lg">↑</div>
          <p className="text-sm font-medium text-stone-700">Drop Chase CSV files here or click to browse</p>
          {uploading
            ? <p className="mt-1 text-xs text-stone-400">Uploading…</p>
            : uploadMsg
              ? <p className={`mt-1 text-xs ${uploadMsg.startsWith('Error') ? 'text-red-500' : 'text-lime-600'}`}>{uploadMsg}</p>
              : <p className="mt-1 text-xs text-stone-400">Checking and Amazon CC supported</p>
          }
        </div>

        {accountInfo.size > 0 && (
          <div className="mt-3 space-y-2">
            {[...accountInfo.values()].map(info => (
              <div key={info.last4} className="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="h-2 w-2 rounded-full bg-lime-500 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-stone-700">{info.label}</p>
                    <p className="text-xs text-stone-400">{info.count.toLocaleString()} txns · {fmtDate(info.minDate)} – {fmtDate(info.maxDate)}</p>
                  </div>
                </div>
                <button onClick={() => onClearAccount(info.last4)}
                  className="text-xs text-stone-300 hover:text-red-400 transition-colors px-2 py-1">
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Amazon Order History ── */}
      <div>
        <SectionHeader
          title="Amazon Order History CSV"
          subtitle="Account → Reports → Order History Reports → download CSV. Maps all orders to CC charges."
        />
        <div
          onClick={() => amazonRef.current?.click()}
          className="flex cursor-pointer items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 hover:bg-white transition-colors"
        >
          <div>
            <p className="text-sm font-medium text-stone-700">
              {amazonMsg
                ? <span className={amazonMsg.startsWith('Error') ? 'text-red-600' : 'text-lime-700'}>{amazonMsg}</span>
                : 'Upload order history to match charges'
              }
            </p>
            <p className="mt-0.5 text-xs text-stone-400">Links order items to each CC transaction line</p>
          </div>
          <input ref={amazonRef} type="file" accept=".csv,.CSV" className="sr-only"
            onChange={e => { const f = e.target.files?.[0]; if (f) onAmazonUpload(f); e.target.value = ''; }} />
          <span className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors ml-4
            ${amazonUploading ? 'bg-stone-400' : amazonMsg && !amazonMsg.startsWith('Error') ? 'bg-lime-600 hover:bg-lime-700' : 'bg-stone-700 hover:bg-stone-600'}`}>
            {amazonUploading ? 'Loading…' : amazonMsg && !amazonMsg.startsWith('Error') ? 'Re-upload' : 'Upload'}
          </span>
        </div>
      </div>

      {/* ── Gmail Sync ── */}
      <div>
        <SectionHeader
          title="Gmail Sync"
          subtitle="Read-only access · fetches Amazon order confirmation emails to match against CC charges."
        />
        {!gmailStatus.connected ? (
          <div className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-4 py-4">
            <div>
              <p className="text-sm font-medium text-stone-700">Connect Gmail</p>
              <p className="text-xs text-stone-400">Authorize once — fetches order emails automatically on sync</p>
            </div>
            <a href="/api/gmail/auth"
              className="shrink-0 rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 ml-4">
              Connect
            </a>
          </div>
        ) : (
          <div className="rounded-xl border border-lime-200 bg-lime-50 px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-lime-800">
                  Gmail connected · {gmailStatus.ordersCount} orders · {gmailStatus.matchedCount} matched
                </p>
                <p className="text-xs text-lime-600 mt-0.5">
                  {gmailStatus.lastSync
                    ? `Last synced ${new Date(gmailStatus.lastSync).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                    : 'Never synced'}
                  {gmailSyncMsg && <span className="ml-2">{gmailSyncMsg}</span>}
                </p>
              </div>
              <button onClick={onGmailSync} disabled={gmailSyncing}
                className="shrink-0 rounded-lg bg-lime-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-lime-800 disabled:opacity-50 ml-4">
                {gmailSyncing ? 'Syncing…' : 'Sync Now'}
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ── Panel: Subscriptions ──────────────────────────────────────────────────────

interface BillAlias { id: string; name: string; vendor_alias: string | null; is_cc_default: number; }
interface Dismissal { vendor_alias: string; account_last4: string; }

const CADENCE_LABELS: Record<Cadence, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semi-annual', annual: 'Yearly',
};
const CADENCE_ORDER: Cadence[] = ['monthly', 'quarterly', 'semiannual', 'annual'];
const MAX_SEEN_CHIPS = 6;

function SubscriptionRow({
  s, bills, mappedId, isSaving, onMap, onCreate, onDismiss, showNext,
}: {
  s: CadencedSubscription;
  bills: BillAlias[];
  mappedId: string;
  isSaving: boolean;
  onMap: (sub: CadencedSubscription, billId: string) => void;
  onCreate: (sub: CadencedSubscription) => void;
  onDismiss: (sub: CadencedSubscription) => void;
  showNext: boolean;
}) {
  const ccBills = bills.filter(b => b.is_cc_default);
  const checkingBills = bills.filter(b => !b.is_cc_default);
  // Monthly rows show month chips; longer cadences show quarter chips.
  // Short labels ("Apr '25", "Q1 '26") + nowrap keep pills on one line so the
  // narrow column wraps *between* pills instead of *inside* them.
  const seenPeriods = s.cadence === 'monthly'
    ? s.periods
    : [...new Set(s.periods.map(p => quarterKey(`${p}-01`)))];
  const seenFull = (p: string) => (s.cadence === 'monthly' ? monthLabel(p) : periodLabel(p, 'quarter'));
  const seenShort = (p: string) => seenFull(p).replace(/^(\S+) (\d{4})$/, (_, a: string, y: string) => `${a} '${y.slice(2)}`);
  const seenShown = seenPeriods.slice(-MAX_SEEN_CHIPS);
  const seenHidden = seenPeriods.length - seenShown.length;
  return (
    <tr className="hover:bg-stone-50">
      <td className="max-w-[180px] truncate px-4 py-2.5 font-medium text-stone-800" title={s.vendor}>
        {s.overdue && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-400 align-middle" title="Overdue — expected charge hasn't appeared" />}
        {s.vendor}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-stone-700">
        {fmt(s.typical)}
        {s.maxAmount !== s.minAmount && (
          <span className="block text-[11px] font-normal text-stone-400">{fmt(s.minAmount)}–{fmt(s.maxAmount)}</span>
        )}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums text-stone-500 sm:table-cell">{fmtDate(s.lastSeen)}</td>
      {showNext && (
        <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums sm:table-cell">
          {s.nextExpected
            ? <span className={s.overdue ? 'font-medium text-red-500' : 'text-stone-500'}>~{fmtDate(s.nextExpected)}</span>
            : <span className="text-stone-300">—</span>}
        </td>
      )}
      <td className="hidden px-4 py-2.5 text-center md:table-cell">
        <div className="flex min-w-[150px] max-w-[230px] flex-wrap justify-center gap-1"
          title={seenPeriods.map(seenFull).join(', ')}>
          {seenShown.map(p => (
            <span key={p} className="whitespace-nowrap rounded-full bg-lime-100 px-2 py-0.5 text-[10px] font-medium leading-4 text-lime-700">{seenShort(p)}</span>
          ))}
          {seenHidden > 0 && <span className="px-1 py-0.5 text-[10px] leading-4 text-stone-400">+{seenHidden}</span>}
        </div>
      </td>
      <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">{fmt(s.annualEst)}</td>
      <td className="hidden px-4 py-2.5 text-center tabular-nums text-stone-500 sm:table-cell" title={`${s.events} recurring charges (${s.charges} transactions)`}>{s.events}×</td>
      <td className="px-4 py-2.5">
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">···{s.account_last4}</span>
      </td>
      <td className="px-4 py-2.5">
        <select
          value={mappedId}
          disabled={isSaving}
          onChange={e => {
            if (e.target.value === '__create__') onCreate(s);
            else onMap(s, e.target.value);
          }}
          className="rounded border border-stone-200 bg-white px-2 py-1 text-xs text-stone-600 disabled:opacity-50"
        >
          <option value="">— unmap —</option>
          {ccBills.length > 0 && (
            <optgroup label="Credit card bills">
              {ccBills.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </optgroup>
          )}
          {checkingBills.length > 0 && (
            <optgroup label="Checking bills">
              {checkingBills.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </optgroup>
          )}
          <option value="__create__">+ Create new bill</option>
        </select>
      </td>
      <td className="px-2 py-2.5">
        <button onClick={() => onDismiss(s)} title="Not a subscription — hide it"
          className="rounded px-1.5 py-0.5 text-stone-300 hover:bg-stone-100 hover:text-stone-500 transition-colors">✕</button>
      </td>
    </tr>
  );
}

function SubscriptionsPanel({ txns, checkingExcluded }: { txns: CsvTransaction[]; checkingExcluded: boolean }) {
  const [bills, setBills] = useState<BillAlias[]>([]);
  const [dismissed, setDismissed] = useState<Dismissal[]>([]);
  const [saving, setSaving] = useState<string | null>(null); // sub key being saved
  const [showDismissed, setShowDismissed] = useState(false);
  const [showAllPossible, setShowAllPossible] = useState(false);
  const [cadenceFilter, setCadenceFilter] = useState<'all' | Cadence | 'irregular'>('all');
  const [sort, setSort] = useState<{ key: 'annual' | 'lastSeen' | 'typical' | 'events'; dir: 'asc' | 'desc' }>({
    key: 'annual', dir: 'desc',
  });
  const POSSIBLE_LIMIT = 25;

  const reloadDismissed = useCallback(async () => {
    try {
      const r = await fetch('/api/budget/subscription-dismiss');
      if (r.ok) setDismissed(await r.json() as Dismissal[]);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    fetch('/api/budget/bill-alias')
      .then(r => r.ok ? r.json() : [])
      .then(data => setBills(data as BillAlias[]))
      .catch(() => {});
    reloadDismissed();
  }, [reloadDismissed]);

  const dismissedSet = useMemo(
    () => new Set(dismissed.map(d => `${d.vendor_alias}||${d.account_last4}`)),
    [dismissed],
  );
  const scan = useMemo(() => detectSubscriptions(txns, dismissedSet), [txns, dismissedSet]);

  // normalized alias → bill_id for already-mapped bills
  const aliasToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of bills) { if (b.vendor_alias) m.set(b.vendor_alias, b.id); }
    return m;
  }, [bills]);

  async function handleMap(sub: CadencedSubscription, billId: string) {
    const alias = sub.alias;
    setSaving(sub.key);
    try {
      const targetId = billId || (aliasToId.get(alias) ?? '');
      if (!targetId) { setSaving(null); return; }
      const res = await fetch('/api/budget/bill-alias', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bill_id: targetId, vendor_alias: billId ? alias : null }),
      });
      if (res.ok) {
        setBills(prev => prev.map(b => {
          if (b.vendor_alias === alias && b.id !== billId) return { ...b, vendor_alias: null };
          if (b.id === billId) return { ...b, vendor_alias: alias };
          if (b.id === targetId && !billId) return { ...b, vendor_alias: null };
          return b;
        }));
      }
    } finally { setSaving(null); }
  }

  async function handleCreate(sub: CadencedSubscription) {
    const alias = sub.alias;
    setSaving(sub.key);
    try {
      // Derive a clean display name: title-case the normalized vendor string
      const name = alias.split(' ')
        .map(w => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
      const res = await fetch('/api/budget/recurring', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          amount:       sub.typical,
          due_day:      sub.due_day,
          is_cc:        sub.account_last4 !== CHECKING_LAST4,
          entity_id:    'household',
          start_month:  new Date().toISOString().slice(0, 7),
          vendor_alias: alias,
        }),
      });
      if (!res.ok) return;
      const { id } = await res.json() as { id: string };
      setBills(prev => [
        ...prev.map(b => b.vendor_alias === alias ? { ...b, vendor_alias: null } : b),
        { id, name, vendor_alias: alias, is_cc_default: sub.account_last4 !== CHECKING_LAST4 ? 1 : 0 },
      ]);
    } finally { setSaving(null); }
  }

  async function handleDismiss(sub: CadencedSubscription) {
    await fetch('/api/budget/subscription-dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor_alias: sub.alias, account_last4: sub.account_last4 }),
    });
    await reloadDismissed();
  }

  async function handleUndismiss(d: Dismissal) {
    await fetch(`/api/budget/subscription-dismiss?vendor_alias=${encodeURIComponent(d.vendor_alias)}&account=${encodeURIComponent(d.account_last4)}`, { method: 'DELETE' });
    await reloadDismissed();
  }

  const SORT_LABELS: Record<typeof sort.key, string> = {
    annual: 'Annual est.', lastSeen: 'Last seen', typical: 'Amount', events: 'Recurrences',
  };

  function toggleSort(key: typeof sort.key) {
    setSort(prev => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }

  function sortRows(rows: CadencedSubscription[]): CadencedSubscription[] {
    if (sort.key === 'annual' && sort.dir === 'desc') return rows; // engine order (overdue first, then annual est.)
    const get = sort.key === 'lastSeen'
      ? (s: CadencedSubscription): string | number => s.lastSeen
      : sort.key === 'typical'
        ? (s: CadencedSubscription): string | number => s.typical
        : sort.key === 'events'
          ? (s: CadencedSubscription): string | number => s.events
          : (s: CadencedSubscription): string | number => s.annualEst;
    const mul = sort.dir === 'desc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a); const vb = get(b);
      return (vb > va ? 1 : vb < va ? -1 : 0) * mul;
    });
  }

  function sortArrow(key: typeof sort.key): string {
    if (sort.key !== key) return '';
    return sort.dir === 'desc' ? ' ▼' : ' ▲';
  }

  function SortTh({ label, k, className }: { label: string; k: typeof sort.key; className?: string }) {
    return (
      <th className={className ?? 'px-4 py-2.5 text-right font-medium'}>
        <button onClick={() => toggleSort(k)} title={`Sort by ${label}`}
          className={`hover:text-stone-800 ${sort.key === k ? 'text-stone-700' : ''}`}>
          {label}<span className="text-stone-400">{sortArrow(k)}</span>
        </button>
      </th>
    );
  }

  function renderTable(rows: CadencedSubscription[], showNext: boolean) {
    return (
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
              <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
              <SortTh label="Typical" k="typical" className="px-4 py-2.5 text-right font-medium" />
              <SortTh label="Last seen" k="lastSeen" className="hidden px-4 py-2.5 text-left font-medium sm:table-cell" />
              {showNext && <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Next exp.</th>}
              <th className="hidden px-4 py-2.5 text-center font-medium md:table-cell">Seen</th>
              <SortTh label="Annual est." k="annual" className="hidden px-4 py-2.5 text-right font-medium sm:table-cell" />
              <SortTh label="×N" k="events" className="hidden px-4 py-2.5 text-center font-medium sm:table-cell" />
              <th className="px-4 py-2.5 text-left font-medium">Acct</th>
              <th className="px-4 py-2.5 text-left font-medium">Bill</th>
              <th className="w-8 px-2 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {sortRows(rows).map(s => (
              <SubscriptionRow
                key={s.key} s={s} bills={bills}
                mappedId={aliasToId.get(s.alias) ?? ''}
                isSaving={saving === s.key}
                onMap={handleMap} onCreate={handleCreate} onDismiss={handleDismiss}
                showNext={showNext}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const totalFound = scan.confirmed.length + scan.possible.length + scan.irregular.length;
  if (!totalFound && !dismissed.length) {
    return <EmptyState message="No recurring charges detected yet — upload more history (yearly finds need ~2 years)." />;
  }
  const visibleCadences = CADENCE_ORDER.filter(c => cadenceFilter === 'all' || c === cadenceFilter);
  const visiblePossible = scan.possible.filter(s => cadenceFilter === 'all' || s.cadence === cadenceFilter);
  const showIrregular = scan.irregular.length > 0 && (cadenceFilter === 'all' || cadenceFilter === 'irregular');
  const visibleCount = visibleCadences.reduce((n, c) => n + scan.confirmed.filter(s => s.cadence === c).length, 0)
    + visiblePossible.length + (showIrregular ? scan.irregular.length : 0);
  return (
    <div className="space-y-5">
      <p className="text-sm text-stone-500">
        Timing-based detection across monthly → yearly cadences. Map a vendor to a budget bill (CC bills feed Reconcile).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={cadenceFilter}
          onChange={e => setCadenceFilter(e.target.value as 'all' | Cadence | 'irregular')}
          className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-800">
          <option value="all">All cadences</option>
          {CADENCE_ORDER.map(c => <option key={c} value={c}>{CADENCE_LABELS[c]}</option>)}
          <option value="irregular">Irregular</option>
        </select>
      </div>
      {checkingExcluded && (
        <p className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-2.5 text-xs text-stone-500">
          Checking is hidden — dues paid from checking (e.g. HOA) won't appear here. Turn off “Exclude checking” above to scan it.
        </p>
      )}
      {!visibleCount && (
        <EmptyState message="Nothing at this cadence — try another filter." />
      )}

      {visibleCadences.map(cadence => {
        const rows = scan.confirmed.filter(s => s.cadence === cadence);
        if (!rows.length) return null;
        return (
          <div key={cadence}>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-stone-700">{CADENCE_LABELS[cadence]}</h3>
              <span className="text-xs text-stone-400">~{fmt(rows.reduce((s, r) => s + r.annualEst, 0))}/yr</span>
            </div>
            {renderTable(rows, true)}
          </div>
        );
      })}

      {visiblePossible.length > 0 && (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-stone-700">Possible <span className="font-normal text-stone-400">— weak signal or variable amounts, needs review</span></h3>
            <span className="text-xs text-stone-400">~{fmt(visiblePossible.reduce((s, r) => s + r.annualEst, 0))}/yr</span>
          </div>
          {renderTable(showAllPossible ? visiblePossible : visiblePossible.slice(0, POSSIBLE_LIMIT), true)}
          {visiblePossible.length > POSSIBLE_LIMIT && (
            <button onClick={() => setShowAllPossible(v => !v)}
              className="mt-2 text-xs text-stone-500 hover:underline">
              {showAllPossible ? 'Show fewer' : `Show all ${visiblePossible.length} (by ${SORT_LABELS[sort.key].toLowerCase()}${sort.dir === 'asc' ? ', ascending' : ''})`}
            </button>
          )}
        </div>
      )}

      {showIrregular && (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-stone-700">Repeating, no clear cadence <span className="font-normal text-stone-400">— installment-style or drifting dues</span></h3>
            <span className="text-xs text-stone-400">~{fmt(scan.irregular.reduce((s, r) => s + r.annualEst, 0))}/yr pace</span>
          </div>
          {renderTable(scan.irregular, false)}
        </div>
      )}

      {dismissed.length > 0 && (
        <p className="text-xs text-stone-400">
          {dismissed.length} hidden
          <button onClick={() => setShowDismissed(v => !v)} className="ml-1.5 hover:underline">
            {showDismissed ? 'hide' : 'show'}
          </button>
          {showDismissed && (
            <span className="ml-2 flex flex-wrap gap-1.5">
              {dismissed.map(d => (
                <span key={`${d.vendor_alias}||${d.account_last4}`}
                  className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">
                  {groupAlias(d.vendor_alias)} ···{d.account_last4}
                  <button onClick={() => handleUndismiss(d)} title="Unhide"
                    className="text-stone-400 hover:text-stone-700">↩</button>
                </span>
              ))}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

// ── Panel: Categories ─────────────────────────────────────────────────────────

const CAT_COLORS: Record<string, string> = {
  'Food & Drink': '#84cc16', 'Shopping': '#f59e0b', 'Travel': '#3b82f6',
  'Entertainment': '#8b5cf6', 'Health & Wellness': '#10b981', 'Gas': '#f97316',
  'Groceries': '#22c55e', 'Bills & Utilities': '#6366f1', 'Personal': '#ec4899', 'Other': '#9ca3af',
};
function barColor(cat: string, i: number): string {
  const palette = ['#84cc16', '#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#f97316', '#ec4899', '#6366f1'];
  return CAT_COLORS[cat] ?? palette[i % palette.length]!;
}

function CategoriesPanel({ txns }: { txns: CsvTransaction[] }) {
  const rows = useMemo(() => categorizeSpend(txns), [txns]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (!rows.length) return <EmptyState message="No purchase data yet." />;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-stone-500">Total spend:</span>
        <span className="font-semibold text-stone-800">{fmt(total)}</span>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.cat}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium text-stone-700">{r.cat}</span>
              <span className="tabular-nums text-stone-500">{fmt(r.amount)} · {(r.pct * 100).toFixed(1)}% · {r.count} txns</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
              <div className="h-2 rounded-full transition-all" style={{ width: `${r.pct * 100}%`, backgroundColor: barColor(r.cat, i) }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Panel: Amazon ─────────────────────────────────────────────────────────────

function AmazonPanel({
  txns, gmailStatus, matches, onGoToUpload,
}: {
  txns:        CsvTransaction[];
  gmailStatus: GmailStatus;
  matches:     AmazonMatch[];
  onGoToUpload: () => void;
}) {
  const data    = useMemo(() => getAmazonData(txns), [txns]);
  const has3606 = txns.some(t => t.account_last4 === '3606');

  const matchMap = useMemo(() => {
    const m = new Map<string, AmazonMatch>();
    for (const match of matches) m.set(match.txn_id, match);
    return m;
  }, [matches]);

  if (!has3606) return <EmptyState message="Upload Chase3606_Activity…CSV in the Upload tab to see Amazon CC analysis." />;

  return (
    <div className="space-y-5">
      {/* Gmail status bar (display only — actions in Upload tab) */}
      <div className={`flex items-center justify-between rounded-xl border px-4 py-3 ${gmailStatus.connected ? 'border-lime-200 bg-lime-50' : 'border-stone-200 bg-stone-50'}`}>
        {gmailStatus.connected ? (
          <>
            <p className="text-sm text-lime-700">
              Gmail connected · {gmailStatus.ordersCount} orders · {gmailStatus.matchedCount} matched
            </p>
            <button onClick={onGoToUpload} className="text-xs text-lime-600 hover:underline">Sync in Upload tab →</button>
          </>
        ) : (
          <>
            <p className="text-sm text-stone-500">Connect Gmail to match orders to CC charges</p>
            <button onClick={onGoToUpload} className="text-xs text-stone-500 hover:underline">Go to Upload tab →</button>
          </>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-stone-700">Monthly Spend</h3>
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
                <th className="px-4 py-2.5 text-left font-medium">Month</th>
                <th className="px-4 py-2.5 text-right font-medium">Charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.byMonth.map(([m, total]) => (
                <tr key={m} className="hover:bg-stone-50">
                  <td className="px-4 py-2.5 text-stone-700">{monthLabel(m)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-stone-800">{fmt(total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-stone-200 bg-stone-50">
                <td className="px-4 py-2.5 text-sm font-semibold text-stone-700">Total</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-stone-800">{fmt(data.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-stone-700">
          All Transactions
          <span className="ml-2 font-normal text-stone-400">({data.allPurchases.length})</span>
        </h3>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <div className="max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Description / Items</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.allPurchases.map((t: CsvTransaction) => {
                  const match = matchMap.get(t.id);
                  const items: { name: string; qty: number }[] = match?.all_items_raw
                    ? match.all_items_raw.split('||').flatMap(chunk => {
                        try { return JSON.parse(chunk) as { name: string; qty: number }[]; } catch { return []; }
                      })
                    : [];
                  return (
                    <tr key={t.id} className="hover:bg-stone-50">
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-stone-500">{fmtDate(t.date)}</td>
                      <td className="px-4 py-2.5">
                        <div className="max-w-[320px]">
                          <span className="truncate text-stone-500 text-xs font-mono" title={t.description}>{t.description}</span>
                          {match && (
                            <div className="mt-0.5">
                              <span className="mr-1 rounded-full bg-lime-100 px-1.5 py-0.5 text-[10px] font-medium text-lime-700">#{match.order_id}</span>
                              {items.slice(0, 2).map((item, i) => (
                                <span key={i} className="mr-1 truncate text-xs text-stone-700">{item.qty > 1 ? `${item.qty}× ` : ''}{item.name}</span>
                              ))}
                              {items.length > 2 && <span className="text-xs text-stone-400">+{items.length - 2} more</span>}
                            </div>
                          )}
                          {!match && gmailStatus.connected && (
                            <div className="mt-0.5 text-[10px] text-stone-300">no email match</div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium text-stone-800">{fmt(Math.abs(t.amount))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Panel: Statements ─────────────────────────────────────────────────────────

function StatementsPanel({ txns }: { txns: CsvTransaction[] }) {
  const accounts = useMemo(() => [...new Set(txns.map(t => t.account_last4))].sort(), [txns]);
  const [activeAccount, setActiveAccount] = useState('');
  const selectedAccount = activeAccount || accounts[0] || '';
  const statements = useMemo(() => getStatements(txns, selectedAccount), [txns, selectedAccount]);

  if (!accounts.length) return <EmptyState message="No transaction data yet." />;
  return (
    <div className="space-y-3">
      {accounts.length > 1 && (
        <div className="flex gap-1.5">
          {accounts.map(a => (
            <button key={a} onClick={() => setActiveAccount(a)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                ${selectedAccount === a ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
              {acctLabel(a)}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-stone-500">Purchases grouped by calendar month.</p>
      {statements.length === 0 ? <EmptyState message="No purchase transactions found for this account." /> : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
                <th className="px-4 py-2.5 text-left font-medium">Statement Month</th>
                <th className="px-4 py-2.5 text-center font-medium">Transactions</th>
                <th className="px-4 py-2.5 text-right font-medium">Total Charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {statements.map(s => (
                <tr key={s.month} className="hover:bg-stone-50">
                  <td className="px-4 py-2.5 font-medium text-stone-800">{monthLabel(s.month)}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums text-stone-600">{s.count}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-stone-800">{fmt(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Computations: Top Vendors ─────────────────────────────────────────────────

interface VendorSpend {
  vendor: string;
  total: number;
  count: number;
  accounts: string[];
}

function findTopVendors(txns: CsvTransaction[], year: string): VendorSpend[] {
  const filtered = txns.filter(t => isPurchase(t) && (year === 'all' || t.date.startsWith(year)));
  const byVendor = new Map<string, CsvTransaction[]>();
  for (const t of filtered) {
    const key = normalizeVendor(t.description);
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key)!.push(t);
  }
  const results: VendorSpend[] = [];
  for (const [, rows] of byVendor) {
    const accounts = [...new Set(rows.map(t => t.account_last4))];
    const vendor = rows.reduce((best, t) => t.description.length > best.length ? t.description : best, '');
    results.push({
      vendor,
      total: Math.round(rows.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
      count: rows.length,
      accounts,
    });
  }
  return results.sort((a, b) => b.total - a.total).slice(0, 40);
}

// ── Panel: Top Vendors ────────────────────────────────────────────────────────

function TopVendorsPanel({ txns }: { txns: CsvTransaction[] }) {
  const years = useMemo(() => {
    const ys = [...new Set(txns.map(t => t.date.slice(0, 4)))].sort().reverse();
    return ys;
  }, [txns]);
  const [year, setYear] = useState<string>('all');

  const vendors = useMemo(() => findTopVendors(txns, year), [txns, year]);
  const grandTotal = useMemo(() => vendors.reduce((s, v) => s + v.total, 0), [vendors]);

  if (!txns.length) return <EmptyState message="No transaction data yet." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => setYear('all')}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
            ${year === 'all' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
          All time
        </button>
        {years.map(y => (
          <button key={y} onClick={() => setYear(y)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
              ${year === y ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
            {y}
          </button>
        ))}
      </div>
      {!vendors.length ? <EmptyState message="No spend found for this period." /> : (
        <>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
                  <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">% of spend</th>
                  <th className="hidden px-4 py-2.5 text-center font-medium sm:table-cell">Txns</th>
                  <th className="px-4 py-2.5 text-left font-medium">Acct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {vendors.map((v, i) => (
                  <tr key={i} className="hover:bg-stone-50">
                    <td className="max-w-[220px] truncate px-4 py-2.5 font-medium text-stone-800" title={v.vendor}>{v.vendor}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-stone-700">{fmt(v.total)}</td>
                    <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">
                      {grandTotal > 0 ? (v.total / grandTotal * 100).toFixed(1) : '0.0'}%
                    </td>
                    <td className="hidden px-4 py-2.5 text-center tabular-nums text-stone-500 sm:table-cell">{v.count}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {v.accounts.map(a => (
                          <span key={a} className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">···{a}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-stone-400">
            Top {vendors.length} vendors · Total: {fmt(grandTotal)}
          </p>
        </>
      )}
    </div>
  );
}

// ── Panel: Top Purchases ──────────────────────────────────────────────────────

function TopPurchasesPanel({ txns }: { txns: CsvTransaction[] }) {
  const accounts = useMemo(() => [...new Set(txns.map(t => t.account_last4))].sort(), [txns]);
  const years = useMemo(() => [...new Set(txns.map(t => t.date.slice(0, 4)))].sort().reverse(), [txns]);
  const [filter, setFilter] = useState('all');
  const [year, setYear] = useState('all');
  const top = useMemo(() => {
    let filtered = txns.filter(isPurchase);
    if (filter !== 'all') filtered = filtered.filter(t => t.account_last4 === filter);
    if (year !== 'all') filtered = filtered.filter(t => t.date.startsWith(year));
    return filtered.sort((a, b) => a.amount - b.amount).slice(0, 30);
  }, [txns, filter, year]);

  if (!txns.length) return <EmptyState message="No transaction data yet." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {['all', ...accounts].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
              ${filter === f ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
            {f === 'all' ? 'All accounts' : acctLabel(f)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setYear('all')}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
            ${year === 'all' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
          All years
        </button>
        {years.map(y => (
          <button key={y} onClick={() => setYear(y)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
              ${year === y ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
            {y}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
              <th className="px-4 py-2.5 text-left font-medium">Date</th>
              <th className="px-4 py-2.5 text-left font-medium">Description</th>
              <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Category</th>
              <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Acct</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {top.map(t => (
              <tr key={t.id} className="hover:bg-stone-50">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-stone-500">{fmtDate(t.date)}</td>
                <td className="px-4 py-2.5">
                  <div className="max-w-[220px] truncate text-stone-700" title={t.description}>{t.description}</div>
                </td>
                <td className="hidden px-4 py-2.5 text-stone-500 sm:table-cell">{t.category ?? '—'}</td>
                <td className="hidden px-4 py-2.5 sm:table-cell">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">···{t.account_last4}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-stone-800">{fmt(Math.abs(t.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Panel: Suggestions ────────────────────────────────────────────────────────
// Behavioral "stop doing this" callouts for one month vs the prior 3 months.
// All spend magnitudes use Math.abs (CSV convention: negative = money out).

interface LeanCategory {
  cat:     string;
  lean:    number;   // spent in the leanest month
  avg:     number;   // average monthly spend across the previous year
  current: number;   // spent this month
}

interface Benchmark {
  leanPeriod: string;         // leanest period within the baseline window
  leanTotal:  number;
  avgSpend:   number;         // average period across the baseline window
  target:     number;         // a realistic "medium" between lean and average
  categories: LeanCategory[]; // per-category: leanest period vs this period
}

interface Suggestions {
  period:          string;
  granularity:     Granularity;
  total:           number;
  txnCount:        number;
  baselinePeriods: number;
  topMerchants:    { vendor: string; count: number; total: number }[];
  topPurchases:    CsvTransaction[];
  otherPurchases:  CsvTransaction[];
  otherCount:      number;
  otherTotal:      number;
  smallCount:      number;
  smallTotal:      number;
  weekendShare:    number;
  benchmark:       Benchmark | null;
  headlines:       string[];
}

const SMALL_PURCHASE          = 15;
const CATEGORY_MIN            = 25;  // per-category floor worth showing in the benchmark table
const BASELINE_WINDOW_MONTH   = 12;  // "the previous year" — trailing 12 months
const BASELINE_WINDOW_QUARTER = 8;   // trailing 2 years — quarters are coarser, so look further back
const MIN_REAL_TXNS_MONTH     = 5;   // a month with fewer looks like a partial statement
const MIN_REAL_TXNS_QUARTER   = 15;  // ditto, scaled for a full quarter's worth of activity
const MATERIAL_OVERAGE        = 150; // dollar gap vs the lean period worth a headline (per month)

function computeSuggestions(txns: CsvTransaction[], period: string, granularity: Granularity): Suggestions {
  // Quarters aggregate ~3x the transactions/dollars of a month — scale dollar
  // and count thresholds accordingly so headlines stay meaningful either way.
  const periodMultiplier = granularity === 'month' ? 1 : 3;
  const baselineWindow   = granularity === 'month' ? BASELINE_WINDOW_MONTH : BASELINE_WINDOW_QUARTER;
  const minRealTxns      = granularity === 'month' ? MIN_REAL_TXNS_MONTH : MIN_REAL_TXNS_QUARTER;
  const periodWord       = granularity === 'month' ? 'month' : 'quarter';
  const baselineSpan     = granularity === 'month' ? 'last year' : 'over the past 2 years';

  const purchases = txns.filter(isPurchase);
  const cur  = purchases.filter(t => periodKey(t.date, granularity) === period);
  const basePeriodSet = new Set(priorPeriods(period, baselineWindow, granularity));
  const base = purchases.filter(t => basePeriodSet.has(periodKey(t.date, granularity)));

  const total = cur.reduce((s, t) => s + Math.abs(t.amount), 0);

  // Top merchants this month, grouped by normalized vendor, labeled with the
  // longest raw description (matches Top Vendors / Subscriptions convention).
  const byVendor = new Map<string, CsvTransaction[]>();
  for (const t of cur) {
    const key = normalizeVendor(t.description);
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key)!.push(t);
  }
  const merchants = [...byVendor.values()].map(rows => ({
    vendor: rows.reduce((best, t) => t.description.length > best.length ? t.description : best, ''),
    count:  rows.length,
    total:  rows.reduce((s, t) => s + Math.abs(t.amount), 0),
  }));
  const topMerchants = [...merchants].sort((a, b) => b.total - a.total).slice(0, 6);

  const byAmount = [...cur].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const topPurchases = byAmount.slice(0, 50);
  const rest = byAmount.slice(50);
  const otherCount = rest.length;
  const otherTotal = rest.reduce((s, t) => s + Math.abs(t.amount), 0);

  const curByCat = new Map<string, number>();
  for (const t of cur) curByCat.set(t.category || 'Other', (curByCat.get(t.category || 'Other') ?? 0) + Math.abs(t.amount));

  const small = cur.filter(t => Math.abs(t.amount) < SMALL_PURCHASE);
  const smallTotal = small.reduce((s, t) => s + Math.abs(t.amount), 0);

  const weekendSpend = cur.filter(t => isWeekend(t.date)).reduce((s, t) => s + Math.abs(t.amount), 0);
  const weekendShare = total > 0 ? weekendSpend / total : 0;

  // Benchmark — leanest period within the baseline window, broken down per
  // category. Skip near-empty periods that are really partial statements, and
  // skip periods that predate full coverage of the accounts active this
  // period — otherwise a quarter from before an account's CSV history began
  // (missing that account's spend entirely) looks artificially "lean".
  const acctMinDate = new Map<string, string>();
  for (const t of purchases) {
    const known = acctMinDate.get(t.account_last4);
    if (!known || t.date < known) acctMinDate.set(t.account_last4, t.date);
  }
  const curAccounts = new Set(cur.map(t => t.account_last4));
  const hasFullCoverage = (candidatePeriod: string) => {
    const start = periodStartDate(candidatePeriod, granularity);
    for (const acct of curAccounts) {
      const minDate = acctMinDate.get(acct);
      if (!minDate || minDate > start) return false;
    }
    return true;
  };

  const periodAgg = new Map<string, { total: number; count: number }>();
  for (const t of base) {
    const key = periodKey(t.date, granularity);
    const a = periodAgg.get(key) ?? { total: 0, count: 0 };
    a.total += Math.abs(t.amount); a.count += 1;
    periodAgg.set(key, a);
  }
  const realPeriods = [...periodAgg.entries()].filter(([p, a]) => a.count >= minRealTxns && hasFullCoverage(p));

  let benchmark: Benchmark | null = null;
  if (realPeriods.length >= 3) {
    const [leanPeriod, leanAgg] = realPeriods.reduce((min, e) => (e[1].total < min[1].total ? e : min));
    const avgSpend = realPeriods.reduce((s, [, a]) => s + a.total, 0) / realPeriods.length;
    const realPeriodSet = new Set(realPeriods.map(([p]) => p));

    const leanByCat = new Map<string, number>();
    const sumByCat  = new Map<string, number>(); // summed across real periods, for the average column
    for (const t of base) {
      const key = periodKey(t.date, granularity);
      if (!realPeriodSet.has(key)) continue;
      const cat = t.category || 'Other';
      sumByCat.set(cat, (sumByCat.get(cat) ?? 0) + Math.abs(t.amount));
      if (key === leanPeriod) leanByCat.set(cat, (leanByCat.get(cat) ?? 0) + Math.abs(t.amount));
    }
    const categoryMin = CATEGORY_MIN * periodMultiplier;
    const categories: LeanCategory[] = [...new Set([...curByCat.keys(), ...leanByCat.keys(), ...sumByCat.keys()])]
      .map(cat => ({
        cat,
        lean:    leanByCat.get(cat) ?? 0,
        avg:     (sumByCat.get(cat) ?? 0) / realPeriods.length,
        current: curByCat.get(cat) ?? 0,
      }))
      .filter(c => c.current >= categoryMin || c.lean >= categoryMin || c.avg >= categoryMin)
      .sort((a, b) => (b.current - b.lean) - (a.current - a.lean)); // biggest overspend vs lean first

    benchmark = { leanPeriod, leanTotal: leanAgg.total, avgSpend, target: (leanAgg.total + avgSpend) / 2, categories };
  }

  // Headlines — blunt callouts, ordered by how much they matter in dollars.
  const headlines: string[] = [];

  if (benchmark && total > benchmark.target * 1.1)
    headlines.push(`You're ${fmt(total - benchmark.target)} over a realistic target of ${fmt(benchmark.target)} — your leanest ${periodWord} ${baselineSpan} was ${periodLabel(benchmark.leanPeriod, granularity)} at ${fmt(benchmark.leanTotal)}.`);

  const topCat = benchmark?.categories[0];
  if (topCat && topCat.current - topCat.lean >= MATERIAL_OVERAGE * periodMultiplier)
    headlines.push(`${topCat.cat}: ${fmt(topCat.current)} this ${periodWord} vs ${fmt(topCat.lean)} in your leanest ${periodWord} — ${fmt(topCat.current - topCat.lean)} more.`);

  const frequent = [...merchants].sort((a, b) => b.count - a.count)[0];
  if (frequent && frequent.count >= 8 * periodMultiplier)
    headlines.push(`${frequent.count} charges from ${frequent.vendor} this ${periodWord} (${fmt(frequent.total)}).`);

  if (small.length >= 15 * periodMultiplier)
    headlines.push(`${small.length} purchases under ${fmt(SMALL_PURCHASE)} added up to ${fmt(smallTotal)}.`);

  if (weekendShare >= 0.55 && total > 0)
    headlines.push(`${Math.round(weekendShare * 100)}% of your spend landed on weekends.`);

  return {
    period, granularity, total, txnCount: cur.length, baselinePeriods: realPeriods.length,
    topMerchants, topPurchases, otherPurchases: rest, otherCount, otherTotal, smallCount: small.length, smallTotal, weekendShare, benchmark, headlines,
  };
}

function SuggestionsPanel({ txns }: { txns: CsvTransaction[] }) {
  const [granularity, setGranularity] = useState<Granularity>('month');
  const periods = useMemo(
    () => [...new Set(txns.filter(isPurchase).map(t => periodKey(t.date, granularity)))].sort().reverse(),
    [txns, granularity],
  );
  const [period, setPeriod] = useState<string>('');
  useEffect(() => { setPeriod(''); }, [granularity]);
  const active = period || periods[0] || '';
  const s = useMemo(() => active ? computeSuggestions(txns, active, granularity) : null, [txns, active, granularity]);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const periodWord = granularity === 'month' ? 'month' : 'quarter';

  if (!txns.length) return <EmptyState message="No transaction data yet. Upload CSVs in the Upload tab." />;
  if (!s || s.txnCount === 0) return <EmptyState message={`No purchases found for this ${periodWord}.`} />;

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-stone-200 bg-white p-0.5">
          {(['month', 'quarter'] as Granularity[]).map(g => (
            <button key={g} type="button" onClick={() => setGranularity(g)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                granularity === g ? 'bg-stone-800 text-white' : 'text-stone-500 hover:text-stone-800'
              }`}>
              {g}
            </button>
          ))}
        </div>
        <select value={active} onChange={e => setPeriod(e.target.value)}
          className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-800">
          {periods.map(p => <option key={p} value={p}>{periodLabel(p, granularity)}</option>)}
        </select>
        <span className="text-xs text-stone-400">
          vs {s.baselinePeriods}-{periodWord} history · {fmt(s.total)} total
        </span>
      </div>

      {/* Headlines */}
      {s.headlines.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <ul className="space-y-1.5">
            {s.headlines.map((h, i) => (
              <li key={i} className="flex gap-2 text-sm text-stone-700">
                <span className="text-amber-500">▲</span><span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-500">
          No standout patterns this {periodWord} — spending looks in line with your usual.
        </div>
      )}

      {/* Comparing periods: leanest period, baseline average, and this period, per category */}
      {s.benchmark && (
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Comparing {periodWord}s</p>
            <p className="text-xs text-stone-400">
              {periodLabel(s.benchmark.leanPeriod, granularity)} was your leanest {periodWord} · target ~{fmt(s.benchmark.target)}
            </p>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-xs text-stone-400">
                <th className="py-1.5 text-left font-medium">Category</th>
                <th className="py-1.5 text-right font-medium">{periodLabel(s.benchmark.leanPeriod, granularity)}</th>
                <th className="py-1.5 text-right font-medium">{granularity === 'month' ? 'Yearly avg' : '2-yr avg'}</th>
                <th className="py-1.5 text-right font-medium">This {periodWord}</th>
                <th className="py-1.5 text-right font-medium">Δ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {s.benchmark.categories.map((c, i) => {
                const delta = c.current - c.lean;
                return (
                  <tr key={i}>
                    <td className="max-w-0 truncate py-1.5 text-stone-700" title={c.cat}>{c.cat}</td>
                    <td className="py-1.5 text-right tabular-nums text-stone-400">{fmt(c.lean)}</td>
                    <td className="py-1.5 text-right tabular-nums text-stone-400">{fmt(c.avg)}</td>
                    <td className="py-1.5 text-right tabular-nums text-stone-700">{fmt(c.current)}</td>
                    <td className={`py-1.5 text-right tabular-nums font-medium ${delta > 0 ? 'text-red-500' : 'text-lime-600'}`}>
                      {delta > 0 ? '+' : ''}{fmt(delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-stone-200 font-semibold text-stone-800">
                <td className="py-1.5 text-left">Total</td>
                <td className="py-1.5 text-right tabular-nums text-stone-400">{fmt(s.benchmark.leanTotal)}</td>
                <td className="py-1.5 text-right tabular-nums text-stone-400">{fmt(s.benchmark.avgSpend)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmt(s.total)}</td>
                <td className={`py-1.5 text-right tabular-nums ${s.total - s.benchmark.leanTotal > 0 ? 'text-red-500' : 'text-lime-600'}`}>
                  {s.total - s.benchmark.leanTotal > 0 ? '+' : ''}{fmt(s.total - s.benchmark.leanTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Top merchants */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">Top merchants this {periodWord}</p>
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {s.topMerchants.map((m, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-stone-600" title={m.vendor}>
                {m.vendor} <span className="text-stone-400">×{m.count}</span>
              </span>
              <span className="shrink-0 tabular-nums font-medium text-stone-800">{fmt(m.total)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Top 50 purchases */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">Top 50 purchases this {periodWord}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-xs text-stone-400">
                <th className="py-1.5 text-left font-medium">#</th>
                <th className="py-1.5 text-left font-medium">Date</th>
                <th className="py-1.5 text-left font-medium">Description</th>
                <th className="py-1.5 text-left font-medium">Category</th>
                <th className="py-1.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {s.topPurchases.map((t, i) => (
                <tr key={t.id}>
                  <td className="py-1.5 text-stone-400">{i + 1}</td>
                  <td className="whitespace-nowrap py-1.5 tabular-nums text-stone-500">{fmtDate(t.date)}</td>
                  <td className="max-w-[220px] truncate py-1.5 text-stone-700" title={t.description}>{t.description}</td>
                  <td className="py-1.5 text-stone-500">{t.category ?? '—'}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-stone-800">{fmt(Math.abs(t.amount))}</td>
                </tr>
              ))}
              {s.otherCount > 0 && (
                <>
                  <tr className="cursor-pointer hover:bg-stone-50" onClick={() => setOtherExpanded(v => !v)}>
                    <td className="py-1.5 text-stone-400">51</td>
                    <td className="py-1.5"></td>
                    <td className="py-1.5 italic text-stone-500">
                      <span className="mr-1 inline-block w-3 text-stone-400">{otherExpanded ? '▾' : '▸'}</span>
                      Other ({s.otherCount} purchases)
                    </td>
                    <td className="py-1.5"></td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-stone-800">{fmt(s.otherTotal)}</td>
                  </tr>
                  {otherExpanded && s.otherPurchases.map((t, i) => (
                    <tr key={t.id} className="bg-stone-50/50">
                      <td className="py-1.5 text-stone-400">{i + 51}</td>
                      <td className="whitespace-nowrap py-1.5 tabular-nums text-stone-500">{fmtDate(t.date)}</td>
                      <td className="max-w-[220px] truncate py-1.5 text-stone-700" title={t.description}>{t.description}</td>
                      <td className="py-1.5 text-stone-500">{t.category ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium text-stone-800">{fmt(Math.abs(t.amount))}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Nav items ─────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: Tab; label: string; icon: string }[] = [
  { id: 'suggestions',   label: 'Suggestions',   icon: '✦' },
  { id: 'subscriptions', label: 'Subscriptions', icon: '↻' },
  { id: 'categories',    label: 'Categories',    icon: '◫' },
  { id: 'vendors',       label: 'Top Vendors',   icon: '⊕' },
  { id: 'top',           label: 'Top Purchases', icon: '↓' },
  { id: 'amazon',        label: 'Amazon',        icon: '⊡' },
  { id: 'statements',    label: 'Statements',    icon: '≡' },
  { id: 'mortgage',      label: 'Mortgage',      icon: '⌂' },
  { id: 'upload',        label: 'Upload',        icon: '↑' },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function CSVAnalyzer({ initialTransactions, initialGmailStatus }: Props) {
  const [transactions, setTransactions] = useState<CsvTransaction[]>(() => {
    try { return JSON.parse(initialTransactions) as CsvTransaction[]; } catch { return []; }
  });
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>(() => {
    try { return JSON.parse(initialGmailStatus) as GmailStatus; }
    catch { return { connected: false, lastSync: null, ordersCount: 0, matchedCount: 0 }; }
  });
  const [matches,      setMatches]      = useState<AmazonMatch[]>([]);
  const [activeTab,    setActiveTab]    = useState<Tab>('suggestions');
  const [uploading,    setUploading]    = useState(false);
  const [uploadMsg,    setUploadMsg]    = useState('');
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncMsg, setGmailSyncMsg] = useState('');
  const [amazonUploading, setAmazonUploading] = useState(false);
  const [amazonMsg,       setAmazonMsg]       = useState('');
  const [excludeChecking, setExcludeChecking] = useState(() => {
    try {
      const v = localStorage.getItem('analyze-exclude-checking');
      return v === null ? true : v === '1';
    } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem('analyze-exclude-checking', excludeChecking ? '1' : '0'); } catch { /* ignore */ }
  }, [excludeChecking]);

  const accountInfo = useMemo(() => buildAccountInfo(transactions), [transactions]);

  // Visible set for every analysis tab + export. Upload keeps the full list.
  const visibleTransactions = useMemo(
    () => (excludeChecking ? transactions.filter(t => !isCheckingTxn(t)) : transactions),
    [transactions, excludeChecking],
  );

  const enrichedTxns = useMemo<CsvTransaction[]>(() => {
    if (!matches.length) return visibleTransactions;
    const matchMap = new Map(matches.map(m => [m.txn_id, m]));
    return visibleTransactions.map(t => {
      const match = matchMap.get(t.id);
      if (!match?.all_items_raw) return t;
      const items: { name: string; qty: number }[] = match.all_items_raw.split('||').flatMap(chunk => {
        try { return JSON.parse(chunk) as { name: string; qty: number }[]; } catch { return []; }
      });
      const primaryName = items[0]?.name;
      return primaryName ? { ...t, description: primaryName } : t;
    });
  }, [visibleTransactions, matches]);

  const reloadMatches = useCallback(async () => {
    try {
      const res = await fetch('/api/gmail/matches');
      if (!res.ok) return;
      setMatches(await res.json() as AmazonMatch[]);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { if (gmailStatus.connected) reloadMatches(); }, [gmailStatus.connected, reloadMatches]);

  const reloadTransactions = useCallback(async () => {
    const res = await fetch('/api/csv/transactions');
    setTransactions(await res.json() as CsvTransaction[]);
  }, []);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true); setUploadMsg('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const res  = await fetch('/api/csv/upload', { method: 'POST', body: fd });
      const data = await res.json() as { ok?: boolean; inserted?: number; skipped?: number; account?: string; error?: string };
      if (!res.ok || data.error) { setUploadMsg(`Error: ${data.error ?? 'Upload failed'}`); return; }
      setUploadMsg(`···${data.account}: +${data.inserted} new rows (${data.skipped} already loaded)`);
      await reloadTransactions();
    } catch { setUploadMsg('Network error'); }
    finally { setUploading(false); }
  }, [reloadTransactions]);

  const handleClearAccount = useCallback(async (last4: string) => {
    await fetch(`/api/csv/transactions?account=${last4}`, { method: 'DELETE' });
    await reloadTransactions();
  }, [reloadTransactions]);

  const handleGmailSync = useCallback(async () => {
    setGmailSyncing(true); setGmailSyncMsg('');
    try {
      const res  = await fetch('/api/gmail/sync', { method: 'POST' });
      const data = await res.json() as { inserted?: number; totalMatches?: number; error?: string };
      if (!res.ok || data.error) { setGmailSyncMsg(`Error: ${data.error}`); return; }
      setGmailSyncMsg(`${data.inserted} new orders · ${data.totalMatches} matched`);
      const statusRes = await fetch('/api/gmail/status');
      const newStatus = await statusRes.json() as GmailStatus;
      setGmailStatus(newStatus);
      await reloadMatches();
    } catch { setGmailSyncMsg('Network error'); }
    finally { setGmailSyncing(false); }
  }, [reloadMatches]);

  const handleAmazonUpload = useCallback(async (file: File) => {
    setAmazonUploading(true); setAmazonMsg('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const res  = await fetch('/api/csv/amazon-orders', { method: 'POST', body: fd });
      const data = await res.json() as { ok?: boolean; orders?: number; matched?: number; total3606?: number; error?: string };
      if (!res.ok || data.error) { setAmazonMsg(`Error: ${data.error}`); return; }
      setAmazonMsg(`${data.orders} orders loaded · ${data.matched} of ${data.total3606} CC transactions matched`);
      setGmailStatus(prev => ({ ...prev, ordersCount: data.orders ?? 0, matchedCount: data.matched ?? 0 }));
      await reloadMatches();
    } catch { setAmazonMsg('Network error'); }
    finally { setAmazonUploading(false); }
  }, [reloadMatches]);

  const TAB_TITLES: Record<Tab, string> = {
    upload:        'Upload Data',
    suggestions:   'Suggestions',
    subscriptions: 'Subscriptions',
    categories:    'Spending by Category',
    amazon:        'Amazon',
    statements:    'Statements',
    top:           'Top Purchases',
    vendors:       'Top Vendors',
    mortgage:      'Mortgage Calculator',
  };

  return (
    <div className="flex flex-col md:flex-row gap-4 md:gap-6 min-h-[600px]">

      {/* ── Mobile: horizontal scroll tabs ── */}
      <div className="md:hidden flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [-webkit-overflow-scrolling:touch]">
        {NAV_ITEMS.map(item => (
          <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
            className={`shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === item.id
                ? 'bg-stone-800 text-white'
                : 'border border-surface-border text-stone-500'
            }`}
          >
            <span className="text-base leading-none opacity-70">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      {/* ── Desktop: left nav ── */}
      <nav className="hidden md:block w-44 shrink-0">
        <div className="sticky top-6 space-y-0.5">
          {NAV_ITEMS.map(item => (
            <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                activeTab === item.id
                  ? 'bg-stone-800 text-white'
                  : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'
              }`}
            >
              <span className="text-base leading-none opacity-60">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Content ── */}
      <div className="flex-1 min-w-0">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold text-stone-800">{TAB_TITLES[activeTab]}</h1>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={excludeChecking}
              title="Hide Chase checking transactions in every tab and in the CSV export"
              onClick={() => setExcludeChecking(v => !v)}
              className="flex cursor-pointer items-center gap-2 select-none"
            >
              <span
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  excludeChecking ? 'bg-stone-800' : 'bg-stone-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    excludeChecking ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </span>
              <span className="text-sm text-stone-500">Exclude checking</span>
            </button>
            <a
              href={excludeChecking ? '/api/transactions/export?exclude_checking=1' : '/api/transactions/export'}
              className="shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-600 hover:text-stone-800"
            >Download CSV</a>
          </div>
        </div>

        {activeTab === 'upload' && (
          <UploadPanel
            accountInfo={accountInfo}
            uploading={uploading} uploadMsg={uploadMsg}
            onUpload={handleUpload} onClearAccount={handleClearAccount}
            gmailStatus={gmailStatus} gmailSyncing={gmailSyncing} gmailSyncMsg={gmailSyncMsg}
            onGmailSync={handleGmailSync}
            amazonUploading={amazonUploading} amazonMsg={amazonMsg}
            onAmazonUpload={handleAmazonUpload}
          />
        )}
        {activeTab === 'suggestions'   && <SuggestionsPanel   txns={enrichedTxns} />}
        {activeTab === 'subscriptions' && <SubscriptionsPanel txns={enrichedTxns} checkingExcluded={excludeChecking} />}
        {activeTab === 'categories'    && <CategoriesPanel    txns={enrichedTxns} />}
        {activeTab === 'amazon'        && (
          <AmazonPanel
            txns={visibleTransactions} gmailStatus={gmailStatus} matches={matches}
            onGoToUpload={() => setActiveTab('upload')}
          />
        )}
        {activeTab === 'statements'    && <StatementsPanel    txns={enrichedTxns} />}
        {activeTab === 'vendors'       && <TopVendorsPanel    txns={enrichedTxns} />}
        {activeTab === 'top'           && <TopPurchasesPanel  txns={enrichedTxns} />}
        {activeTab === 'mortgage'      && <MortgageCalculator />}
      </div>

    </div>
  );
}
