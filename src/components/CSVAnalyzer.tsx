import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
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

type Tab = 'upload' | 'subscriptions' | 'categories' | 'amazon' | 'statements' | 'top' | 'mortgage';

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

// ── Computations ──────────────────────────────────────────────────────────────

interface Subscription {
  vendor: string;
  amount: number;
  total: number;
  months: string[];
  count: number;
  account_last4: string;
}

function normalizeVendor(desc: string): string {
  return desc.toUpperCase().trim()
    .replace(/\*[A-Z0-9]+$/, '')
    .replace(/\s+#?\d{4,}$/, '')
    .replace(/\s+[A-Z]{2}$/, '')
    .trim();
}

function findSubscriptions(txns: CsvTransaction[]): Subscription[] {
  const purchases = txns.filter(t => isPurchase(t) && !normalizeVendor(t.description).startsWith('AMAZON'));
  const byVendorAcct = new Map<string, CsvTransaction[]>();
  for (const t of purchases) {
    const key = `${normalizeVendor(t.description)}||${t.account_last4}`;
    if (!byVendorAcct.has(key)) byVendorAcct.set(key, []);
    byVendorAcct.get(key)!.push(t);
  }
  const results: Subscription[] = [];
  for (const [, rows] of byVendorAcct) {
    const byMonth = new Map<string, number>();
    for (const t of rows) {
      const ym = t.date.slice(0, 7);
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + Math.abs(t.amount));
    }
    const months = [...byMonth.keys()].sort();
    const hasConsecutive = months.some((ym, i) => {
      if (i === 0) return false;
      const [y1, m1] = months[i - 1]!.split('-').map(Number);
      const [y2, m2] = ym.split('-').map(Number);
      if (y2 * 12 + m2 !== y1 * 12 + m1 + 1) return false;
      const a1 = byMonth.get(months[i - 1]!)!;
      const a2 = byMonth.get(ym)!;
      return Math.abs(a1 - a2) / ((a1 + a2) / 2) <= 0.10;
    });
    if (!hasConsecutive) continue;
    const monthlyAmounts = months.map(m => byMonth.get(m)!).sort((a, b) => a - b);
    const medianAmt = monthlyAmounts[Math.floor(monthlyAmounts.length / 2)]!;
    const vendor = rows.reduce((best, t) => t.description.length > best.length ? t.description : best, '');
    results.push({
      vendor,
      amount: Math.round(medianAmt * 100) / 100,
      total: Math.round(monthlyAmounts.reduce((s, a) => s + a, 0) * 100) / 100,
      months, count: rows.length, account_last4: rows[0]!.account_last4,
    });
  }
  return results.sort((a, b) => b.months.length - a.months.length || b.amount - a.amount);
}

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
  const labels: Record<string, string> = { '1957': 'Chase Checking', '3606': 'Amazon CC' };
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

const ACCOUNT_LABELS: Record<string, string> = { '1957': 'Checking', '3606': 'Amazon CC' };
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

function SubscriptionsPanel({ txns }: { txns: CsvTransaction[] }) {
  const subs = useMemo(() => findSubscriptions(txns), [txns]);
  if (!subs.length) return <EmptyState message="No recurring charges detected yet — upload at least 2 months of data." />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-500">Same vendor + same amount in 2+ consecutive months. Sorted by monthly cost.</p>
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
              <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="hidden px-4 py-2.5 text-center font-medium sm:table-cell">Months seen</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Actual total</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Annual est.</th>
              <th className="px-4 py-2.5 text-left font-medium">Acct</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {subs.map((s, i) => (
              <tr key={i} className="hover:bg-stone-50">
                <td className="max-w-[220px] truncate px-4 py-2.5 font-medium text-stone-800" title={s.vendor}>{s.vendor}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-stone-700">{fmt(s.amount)}</td>
                <td className="hidden px-4 py-2.5 text-center sm:table-cell">
                  <div className="flex flex-wrap justify-center gap-1">
                    {s.months.map(m => (
                      <span key={m} className="rounded-full bg-lime-100 px-1.5 py-0.5 text-[10px] font-medium text-lime-700">{monthLabel(m)}</span>
                    ))}
                  </div>
                </td>
                <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-600 sm:table-cell">{fmt(s.total)}</td>
                <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">{fmt(s.amount * 12)}</td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">···{s.account_last4}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-400">
        {subs.length} subscriptions detected · Est. annual total: {fmt(subs.reduce((s, r) => s + r.amount * 12, 0))}
      </p>
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

// ── Panel: Top Purchases ──────────────────────────────────────────────────────

function TopPurchasesPanel({ txns }: { txns: CsvTransaction[] }) {
  const accounts = useMemo(() => [...new Set(txns.map(t => t.account_last4))].sort(), [txns]);
  const [filter, setFilter] = useState('all');
  const top = useMemo(() => {
    let filtered = txns.filter(isPurchase);
    if (filter !== 'all') filtered = filtered.filter(t => t.account_last4 === filter);
    return filtered.sort((a, b) => a.amount - b.amount).slice(0, 30);
  }, [txns, filter]);

  if (!txns.length) return <EmptyState message="No transaction data yet." />;
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {['all', ...accounts].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
              ${filter === f ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}>
            {f === 'all' ? 'All' : acctLabel(f)}
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

// ── Nav items ─────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: Tab; label: string; icon: string }[] = [
  { id: 'subscriptions', label: 'Subscriptions', icon: '↻' },
  { id: 'categories',    label: 'Categories',    icon: '◫' },
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
  const [activeTab,    setActiveTab]    = useState<Tab>('subscriptions');
  const [uploading,    setUploading]    = useState(false);
  const [uploadMsg,    setUploadMsg]    = useState('');
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailSyncMsg, setGmailSyncMsg] = useState('');
  const [amazonUploading, setAmazonUploading] = useState(false);
  const [amazonMsg,       setAmazonMsg]       = useState('');

  const accountInfo = useMemo(() => buildAccountInfo(transactions), [transactions]);

  const enrichedTxns = useMemo<CsvTransaction[]>(() => {
    if (!matches.length) return transactions;
    const matchMap = new Map(matches.map(m => [m.txn_id, m]));
    return transactions.map(t => {
      const match = matchMap.get(t.id);
      if (!match?.all_items_raw) return t;
      const items: { name: string; qty: number }[] = match.all_items_raw.split('||').flatMap(chunk => {
        try { return JSON.parse(chunk) as { name: string; qty: number }[]; } catch { return []; }
      });
      const primaryName = items[0]?.name;
      return primaryName ? { ...t, description: primaryName } : t;
    });
  }, [transactions, matches]);

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
    subscriptions: 'Subscriptions',
    categories:    'Spending by Category',
    amazon:        'Amazon',
    statements:    'Statements',
    top:           'Top Purchases',
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
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-stone-800">{TAB_TITLES[activeTab]}</h1>
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
        {activeTab === 'subscriptions' && <SubscriptionsPanel txns={enrichedTxns} />}
        {activeTab === 'categories'    && <CategoriesPanel    txns={enrichedTxns} />}
        {activeTab === 'amazon'        && (
          <AmazonPanel
            txns={transactions} gmailStatus={gmailStatus} matches={matches}
            onGoToUpload={() => setActiveTab('upload')}
          />
        )}
        {activeTab === 'statements'    && <StatementsPanel    txns={enrichedTxns} />}
        {activeTab === 'top'           && <TopPurchasesPanel  txns={enrichedTxns} />}
        {activeTab === 'mortgage'      && <MortgageCalculator />}
      </div>

    </div>
  );
}
