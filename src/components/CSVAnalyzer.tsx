import { useState, useMemo, useCallback, useRef, useEffect } from 'react';

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
  all_items_raw:  string | null; // shipment items_json arrays joined by '||'
}

type Tab = 'subscriptions' | 'categories' | 'amazon' | 'statements' | 'top';

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

// Chase CC: negative = purchase, positive = payment
// Chase Checking: negative = debit out, positive = deposit
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
  return desc
    .toUpperCase()
    .trim()
    // "AMAZON PRIME*A1B2C3" → "AMAZON PRIME"
    .replace(/\*[A-Z0-9]+$/, '')
    // trailing transaction/store IDs: "STARBUCKS #12345" → "STARBUCKS", "NETFLIX 8X9YZ" → "NETFLIX"
    .replace(/\s+#?\d{4,}$/, '')
    // trailing 2-letter state/country code
    .replace(/\s+[A-Z]{2}$/, '')
    .trim();
}

function findSubscriptions(txns: CsvTransaction[]): Subscription[] {
  const purchases = txns.filter(t => isPurchase(t) && !normalizeVendor(t.description).startsWith('AMAZON'));

  // First pass: group by (normalizedVendor, account_last4) — same vendor across months
  const byVendorAcct = new Map<string, CsvTransaction[]>();
  for (const t of purchases) {
    const key = `${normalizeVendor(t.description)}||${t.account_last4}`;
    if (!byVendorAcct.has(key)) byVendorAcct.set(key, []);
    byVendorAcct.get(key)!.push(t);
  }

  const results: Subscription[] = [];
  for (const [, rows] of byVendorAcct) {
    // Per month: sum all charges under this vendor (handles same-month duplicates / split charges)
    const byMonth = new Map<string, number>();
    for (const t of rows) {
      const ym = t.date.slice(0, 7);
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + Math.abs(t.amount));
    }
    const months = [...byMonth.keys()].sort();
    // Require at least 2 back-to-back consecutive months with amounts within 10% of each other
    const hasConsecutive = months.some((ym, i) => {
      if (i === 0) return false;
      const [y1, m1] = months[i - 1]!.split('-').map(Number);
      const [y2, m2] = ym.split('-').map(Number);
      if (y2 * 12 + m2 !== y1 * 12 + m1 + 1) return false;
      const a1 = byMonth.get(months[i - 1]!)!;
      const a2 = byMonth.get(ym)!;
      const avg = (a1 + a2) / 2;
      return Math.abs(a1 - a2) / avg <= 0.10;
    });
    if (!hasConsecutive) continue;

    // Use the median monthly amount as the representative charge
    const monthlyAmounts = months.map(m => byMonth.get(m)!).sort((a, b) => a - b);
    const medianAmt = monthlyAmounts[Math.floor(monthlyAmounts.length / 2)]!;

    // Pick the most descriptive original description (longest after trimming)
    const vendor = rows.reduce((best, t) => t.description.length > best.length ? t.description : best, '');

    results.push({
      vendor,
      amount: Math.round(medianAmt * 100) / 100,
      total: Math.round(monthlyAmounts.reduce((s, a) => s + a, 0) * 100) / 100,
      months,
      count: rows.length,
      account_last4: rows[0]!.account_last4,
    });
  }

  return results.sort((a, b) => b.months.length - a.months.length || b.amount - a.amount);
}

interface CategoryRow {
  cat: string;
  amount: number;
  pct: number;
  count: number;
}

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

interface StatementMonth {
  month: string;
  count: number;
  total: number;
}

function getStatements(txns: CsvTransaction[], account_last4: string): StatementMonth[] {
  const rows = txns.filter(t => t.account_last4 === account_last4 && isPurchase(t));
  const byMonth = new Map<string, { count: number; total: number }>();
  for (const t of rows) {
    const m = t.date.slice(0, 7);
    const existing = byMonth.get(m) ?? { count: 0, total: 0 };
    byMonth.set(m, { count: existing.count + 1, total: existing.total + Math.abs(t.amount) });
  }
  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, { count, total }]) => ({ month, count, total }));
}

// ── Account status card ────────────────────────────────────────────────────────

interface AccountInfo {
  last4: string;
  label: string;
  source: string;
  count: number;
  minDate: string;
  maxDate: string;
  lastUpload: string;
}

function buildAccountInfo(txns: CsvTransaction[]): Map<string, AccountInfo> {
  const map = new Map<string, AccountInfo>();
  const labels: Record<string, string> = {
    '1957': 'Chase Checking',
    '3606': 'Amazon CC',
  };
  for (const t of txns) {
    if (!map.has(t.account_last4)) {
      map.set(t.account_last4, {
        last4: t.account_last4,
        label: labels[t.account_last4] ?? `Chase ···${t.account_last4}`,
        source: t.account_source,
        count: 0,
        minDate: t.date,
        maxDate: t.date,
        lastUpload: t.uploaded_at,
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

// ── Upload drop zone (single, dynamic) ───────────────────────────────────────

function UploadZone({ onUpload }: { onUpload: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) return;
    onUpload(file);
  };

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handle(f); }}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors
        ${dragging ? 'border-lime-500 bg-lime-50' : 'border-stone-300 bg-stone-50 hover:border-stone-400 hover:bg-white'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.CSV"
        multiple
        className="sr-only"
        onChange={e => { Array.from(e.target.files ?? []).forEach(handle); e.target.value = ''; }}
      />
      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-stone-200 text-stone-500 text-lg">
        ↑
      </div>
      <p className="text-sm font-medium text-stone-700">Drop Chase CSV files here or click to browse</p>
      <p className="mt-0.5 text-xs text-stone-400">Account is detected automatically from the filename</p>
    </div>
  );
}

// ── Tab button ────────────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
        ${active
          ? 'bg-stone-800 text-white'
          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}
    >
      {children}
    </button>
  );
}

// ── Panel: Subscriptions ──────────────────────────────────────────────────────

function SubscriptionsPanel({ txns }: { txns: CsvTransaction[] }) {
  const subs = useMemo(() => findSubscriptions(txns), [txns]);

  if (!subs.length) {
    return <EmptyState message="No recurring charges detected yet — upload at least 2 months of data." />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-500">
        Same vendor + same amount appearing in 2+ different months. Sorted by monthly cost.
      </p>
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
              <th className="px-2 py-2 text-left font-medium sm:px-4 sm:py-2.5">Vendor</th>
              <th className="px-2 py-2 text-right font-medium sm:px-4 sm:py-2.5">Amount</th>
              <th className="hidden px-4 py-2.5 text-center font-medium sm:table-cell">Months seen</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Actual total</th>
              <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Annual est.</th>
              <th className="px-2 py-2 text-left font-medium sm:px-4 sm:py-2.5">Acct</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {subs.map((s, i) => (
              <tr key={i} className="hover:bg-stone-50">
                <td className="max-w-[140px] truncate px-2 py-2 font-medium text-stone-800 sm:max-w-[220px] sm:px-4 sm:py-2.5" title={s.vendor}>
                  {s.vendor}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-stone-700 sm:px-4 sm:py-2.5">{fmt(s.amount)}</td>
                <td className="hidden px-4 py-2.5 text-center sm:table-cell">
                  <div className="flex flex-wrap justify-center gap-1">
                    {s.months.map(m => (
                      <span key={m} className="rounded-full bg-lime-100 px-1.5 py-0.5 text-[10px] font-medium text-lime-700">
                        {monthLabel(m)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-600 sm:table-cell">{fmt(s.total)}</td>
                <td className="hidden px-4 py-2.5 text-right tabular-nums text-stone-500 sm:table-cell">{fmt(s.amount * 12)}</td>
                <td className="px-2 py-2 sm:px-4 sm:py-2.5">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">
                    ···{s.account_last4}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-400">
        Total subscriptions detected: {subs.length} · Est. annual total: {fmt(subs.reduce((s, r) => s + r.amount * 12, 0))}
      </p>
    </div>
  );
}

// ── Panel: Categories ─────────────────────────────────────────────────────────

const CAT_COLORS: Record<string, string> = {
  'Food & Drink': '#84cc16',
  'Shopping': '#f59e0b',
  'Travel': '#3b82f6',
  'Entertainment': '#8b5cf6',
  'Health & Wellness': '#10b981',
  'Gas': '#f97316',
  'Groceries': '#22c55e',
  'Bills & Utilities': '#6366f1',
  'Personal': '#ec4899',
  'Other': '#9ca3af',
};

function barColor(cat: string, i: number): string {
  if (CAT_COLORS[cat]) return CAT_COLORS[cat]!;
  const palette = ['#84cc16', '#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#f97316', '#ec4899', '#6366f1'];
  return palette[i % palette.length]!;
}

function CategoriesPanel({ txns }: { txns: CsvTransaction[] }) {
  const rows = useMemo(() => categorizeSpend(txns), [txns]);
  const total = rows.reduce((s, r) => s + r.amount, 0);

  if (!rows.length) {
    return <EmptyState message="No purchase data yet." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-stone-500">Total spend across all categories:</span>
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
              <div
                className="h-2 rounded-full transition-all"
                style={{ width: `${r.pct * 100}%`, backgroundColor: barColor(r.cat, i) }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Panel: Amazon ─────────────────────────────────────────────────────────────

function GmailBanner({
  status,
  onSync,
  syncing,
  syncMsg,
}: {
  status:   GmailStatus;
  onSync:   () => void;
  syncing:  boolean;
  syncMsg:  string;
}) {
  if (!status.connected) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-stone-700">Connect Gmail to match orders to purchases</p>
          <p className="text-xs text-stone-400">Read-only access · only fetches Amazon order emails</p>
        </div>
        <a
          href="/api/gmail/auth"
          className="shrink-0 rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
        >
          Connect Gmail
        </a>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-lime-200 bg-lime-50 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-lime-800">
          Gmail connected · {status.ordersCount} orders · {status.matchedCount} matched
        </p>
        <p className="text-xs text-lime-600">
          {status.lastSync
            ? `Last synced ${new Date(status.lastSync).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
            : 'Never synced'}
          {syncMsg && <span className="ml-2">{syncMsg}</span>}
        </p>
      </div>
      <button
        onClick={onSync}
        disabled={syncing}
        className="shrink-0 rounded-lg bg-lime-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-lime-800 disabled:opacity-50"
      >
        {syncing ? 'Syncing…' : 'Sync Now'}
      </button>
    </div>
  );
}

function AmazonPanel({
  txns,
  gmailStatus,
  matches,
  onGmailSync,
}: {
  txns:        CsvTransaction[];
  gmailStatus: GmailStatus;
  matches:     AmazonMatch[];
  onGmailSync: (updated: GmailStatus) => void;
}) {
  const data    = useMemo(() => getAmazonData(txns), [txns]);
  const has3606 = txns.some(t => t.account_last4 === '3606');
  const [syncing,      setSyncing]      = useState(false);
  const [syncMsg,      setSyncMsg]      = useState('');
  const [ohUploading,  setOhUploading]  = useState(false);
  const [ohMsg,        setOhMsg]        = useState('');
  const ohInputRef = useRef<HTMLInputElement>(null);

  const matchMap = useMemo(() => {
    const m = new Map<string, AmazonMatch>();
    for (const match of matches) m.set(match.txn_id, match);
    return m;
  }, [matches]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res  = await fetch('/api/gmail/sync', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; fetched?: number; parsed?: number; inserted?: number; totalMatches?: number; error?: string };
      if (!res.ok || data.error) { setSyncMsg(`Error: ${data.error}`); return; }
      setSyncMsg(`${data.inserted} new orders · ${data.totalMatches} matched`);
      const statusRes = await fetch('/api/gmail/status');
      const newStatus = await statusRes.json() as GmailStatus;
      onGmailSync(newStatus);
    } catch {
      setSyncMsg('Network error');
    } finally {
      setSyncing(false);
    }
  }, [onGmailSync]);

  const handleOrderHistoryUpload = useCallback(async (file: File) => {
    setOhUploading(true);
    setOhMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res  = await fetch('/api/csv/amazon-orders', { method: 'POST', body: fd });
      const data = await res.json() as { ok?: boolean; orders?: number; matched?: number; total3606?: number; error?: string };
      if (!res.ok || data.error) { setOhMsg(`Error: ${data.error}`); return; }
      setOhMsg(`${data.orders} orders loaded · ${data.matched} of ${data.total3606} CC transactions matched`);
      // Reload matches
      onGmailSync({ ...gmailStatus, ordersCount: data.orders ?? 0, matchedCount: data.matched ?? 0 });
      // bubble matches up via a status update — parent reloads them via reloadMatches
    } catch {
      setOhMsg('Network error');
    } finally {
      setOhUploading(false);
    }
  }, [gmailStatus, onGmailSync]);

  if (!has3606) {
    return <EmptyState message="Upload Chase3606_Activity…CSV to see Amazon CC analysis." />;
  }

  return (
    <div className="space-y-5">
      {/* Order History CSV upload */}
      <div
        onClick={() => ohInputRef.current?.click()}
        className="flex cursor-pointer items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 hover:bg-white transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-stone-700">Amazon Order History CSV</p>
          <p className="text-xs text-stone-400">
            {ohMsg || 'Account → Reports → Order History Reports → download CSV · maps all orders to CC charges'}
          </p>
        </div>
        <input ref={ohInputRef} type="file" accept=".csv,.CSV" className="sr-only"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleOrderHistoryUpload(f); e.target.value = ''; }} />
        <span className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors
          ${ohUploading ? 'bg-stone-400' : ohMsg && !ohMsg.startsWith('Error') ? 'bg-lime-600 hover:bg-lime-700' : 'bg-stone-700 hover:bg-stone-600'}`}>
          {ohUploading ? 'Loading…' : ohMsg && !ohMsg.startsWith('Error') ? 'Re-upload' : 'Upload'}
        </span>
      </div>

      <GmailBanner status={gmailStatus} onSync={handleSync} syncing={syncing} syncMsg={syncMsg} />

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
                <th className="px-2 py-2 text-left font-medium sm:px-4 sm:py-2.5">Date</th>
                <th className="px-2 py-2 text-left font-medium sm:px-4 sm:py-2.5">Description / Items</th>
                <th className="px-2 py-2 text-right font-medium sm:px-4 sm:py-2.5">Amount</th>
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
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-stone-500 sm:px-4 sm:py-2.5">{fmtDate(t.date)}</td>
                    <td className="px-2 py-2 sm:px-4 sm:py-2.5">
                      <div className="max-w-[200px] sm:max-w-[320px]">
                        <span className="truncate text-stone-500 text-xs font-mono" title={t.description}>{t.description}</span>
                        {match && (
                          <div className="mt-0.5">
                            <span className="mr-1 rounded-full bg-lime-100 px-1.5 py-0.5 text-[10px] font-medium text-lime-700">
                              #{match.order_id}
                            </span>
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
                    <td className="px-2 py-2 text-right tabular-nums font-medium text-stone-800 sm:px-4 sm:py-2.5">{fmt(Math.abs(t.amount))}</td>
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
  const [activeAccount, setActiveAccount] = useState<string>('');

  const selectedAccount = activeAccount || accounts[0] || '';
  const statements = useMemo(() => getStatements(txns, selectedAccount), [txns, selectedAccount]);

  if (!accounts.length) {
    return <EmptyState message="No transaction data yet." />;
  }

  return (
    <div className="space-y-3">
      {accounts.length > 1 && (
        <div className="flex items-center gap-1.5">
          {accounts.map(a => (
            <button
              key={a}
              onClick={() => setActiveAccount(a)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                ${selectedAccount === a ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}
            >
              {acctLabel(a)}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-stone-500">
        Purchases grouped by calendar month — cross-reference against what you entered in Budget → CC charges.
      </p>
      {statements.length === 0 ? (
        <EmptyState message="No purchase transactions found for this account." />
      ) : (
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
      <p className="text-xs text-stone-400">
        Billing cycle cutoff may shift some charges to the next statement. Compare with your actual Chase statement to verify.
      </p>
    </div>
  );
}

// ── Panel: Top Purchases ──────────────────────────────────────────────────────

const ACCOUNT_LABELS: Record<string, string> = {
  '1957': 'Checking',
  '3606': 'Amazon CC',
};

function acctLabel(last4: string): string {
  return `${ACCOUNT_LABELS[last4] ?? 'Acct'} ···${last4}`;
}

function TopPurchasesPanel({ txns }: { txns: CsvTransaction[] }) {
  const accounts = useMemo(() => [...new Set(txns.map(t => t.account_last4))].sort(), [txns]);
  const [filter, setFilter] = useState('all');
  const top = useMemo(() => {
    let filtered = txns.filter(isPurchase);
    if (filter !== 'all') filtered = filtered.filter(t => t.account_last4 === filter);
    return filtered.sort((a, b) => a.amount - b.amount).slice(0, 30);
  }, [txns, filter]);

  if (!txns.length) {
    return <EmptyState message="No transaction data yet." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {['all', ...accounts].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
              ${filter === f ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}
          >
            {f === 'all' ? 'All' : acctLabel(f)}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500">
              <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Date</th>
              <th className="px-2 py-2 text-left font-medium sm:px-4 sm:py-2.5">Description</th>
              <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Category</th>
              <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Acct</th>
              <th className="px-2 py-2 text-right font-medium sm:px-4 sm:py-2.5">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {top.map(t => (
              <tr key={t.id} className="hover:bg-stone-50">
                <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums text-stone-500 sm:table-cell">{fmtDate(t.date)}</td>
                <td className="px-2 py-2 sm:px-4 sm:py-2.5">
                  <div className="max-w-[180px] truncate text-stone-700 sm:max-w-[220px]" title={t.description}>{t.description}</div>
                  <div className="mt-0.5 text-[10px] text-stone-400 sm:hidden">{fmtDate(t.date)} · {t.category ?? '—'}</div>
                </td>
                <td className="hidden px-4 py-2.5 text-stone-500 sm:table-cell">{t.category ?? '—'}</td>
                <td className="hidden px-4 py-2.5 sm:table-cell">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono text-stone-500">
                    ···{t.account_last4}
                  </span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums font-semibold text-stone-800 sm:px-4 sm:py-2.5">
                  {fmt(Math.abs(t.amount))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-6 py-10 text-center text-sm text-stone-400">
      {message}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'categories',    label: 'Categories' },
  { id: 'amazon',        label: 'Amazon' },
  { id: 'statements',    label: 'Statements' },
  { id: 'top',           label: 'Top Purchases' },
];

export default function CSVAnalyzer({ initialTransactions, initialGmailStatus }: Props) {
  const [transactions, setTransactions] = useState<CsvTransaction[]>(() => {
    try { return JSON.parse(initialTransactions) as CsvTransaction[]; }
    catch { return []; }
  });
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>(() => {
    try { return JSON.parse(initialGmailStatus) as GmailStatus; }
    catch { return { connected: false, lastSync: null, ordersCount: 0, matchedCount: 0 }; }
  });
  const [matches, setMatches] = useState<AmazonMatch[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('subscriptions');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const accountInfo = useMemo(() => buildAccountInfo(transactions), [transactions]);

  // Replace Amazon transaction descriptions with the primary product name when matched.
  // This lets subscription detection work on real product names instead of opaque reference codes.
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
      if (!primaryName) return t;
      return { ...t, description: primaryName };
    });
  }, [transactions, matches]);

  const reloadMatches = useCallback(async () => {
    try {
      const res  = await fetch('/api/gmail/matches');
      if (!res.ok) return;
      const rows = await res.json() as AmazonMatch[];
      setMatches(rows);
    } catch { /* non-critical */ }
  }, []);

  // Load matches on mount if Gmail is connected
  useEffect(() => {
    if (gmailStatus.connected) reloadMatches();
  }, [gmailStatus.connected, reloadMatches]);

  const reloadTransactions = useCallback(async () => {
    const res = await fetch('/api/csv/transactions');
    const rows = await res.json() as CsvTransaction[];
    setTransactions(rows);
  }, []);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/csv/upload', { method: 'POST', body: fd });
      const data = await res.json() as { ok?: boolean; inserted?: number; skipped?: number; account?: string; error?: string };
      if (!res.ok || data.error) {
        setUploadMsg(`Error: ${data.error ?? 'Upload failed'}`);
        return;
      }
      setUploadMsg(`···${data.account}: +${data.inserted} new rows (${data.skipped} already loaded)`);
      await reloadTransactions();
    } catch {
      setUploadMsg('Network error');
    } finally {
      setUploading(false);
    }
  }, [reloadTransactions]);

  const handleClearAccount = useCallback(async (last4: string) => {
    await fetch(`/api/csv/transactions?account=${last4}`, { method: 'DELETE' });
    await reloadTransactions();
  }, [reloadTransactions]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-stone-800">Transaction Analysis</h1>
        <p className="mt-0.5 text-sm text-stone-500">
          Upload Chase CSV exports to analyze subscriptions, spending, and CC charges.
        </p>
      </div>

      {/* Upload zone */}
      <div className="space-y-3">
        <UploadZone onUpload={handleUpload} />
        {uploading && <p className="text-xs text-stone-400">Uploading…</p>}
        {uploadMsg && (
          <p className={`text-xs ${uploadMsg.startsWith('Error') ? 'text-red-500' : 'text-lime-600'}`}>
            {uploadMsg}
          </p>
        )}

        {/* Loaded accounts */}
        {accountInfo.size > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...accountInfo.values()].map(info => (
              <div key={info.last4} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
                <span className="h-2 w-2 rounded-full bg-lime-500" />
                <span className="font-medium text-stone-700">{info.label}</span>
                <span className="font-mono text-xs text-stone-400">···{info.last4}</span>
                <span className="text-stone-400">·</span>
                <span className="text-xs text-stone-500">{info.count.toLocaleString()} txns</span>
                <span className="text-xs text-stone-400">{fmtDate(info.minDate)} – {fmtDate(info.maxDate)}</span>
                <button
                  onClick={() => handleClearAccount(info.last4)}
                  className="ml-1 text-stone-300 hover:text-red-400 transition-colors"
                  title="Remove this account's data"
                >✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs + panels */}
      {transactions.length > 0 ? (
        <div className="rounded-xl border border-stone-200 bg-white p-3 sm:p-5">
          <div className="mb-4 overflow-x-auto sm:mb-5">
            <div className="flex min-w-max gap-1 border-b border-stone-100 pb-3 sm:pb-4">
              {TABS.map(tab => (
                <TabBtn key={tab.id} active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
                  {tab.label}
                </TabBtn>
              ))}
            </div>
          </div>
          {activeTab === 'subscriptions' && <SubscriptionsPanel txns={enrichedTxns} />}
          {activeTab === 'categories'    && <CategoriesPanel    txns={enrichedTxns} />}
          {activeTab === 'amazon'        && <AmazonPanel        txns={transactions} gmailStatus={gmailStatus} matches={matches} onGmailSync={s => { setGmailStatus(s); reloadMatches(); }} />}
          {activeTab === 'statements'    && <StatementsPanel    txns={enrichedTxns} />}
          {activeTab === 'top'           && <TopPurchasesPanel  txns={enrichedTxns} />}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-stone-500">No transaction data yet</p>
          <p className="mt-1 text-xs text-stone-400">
            Upload your Chase CSV files above — data persists across sessions.
          </p>
        </div>
      )}
    </div>
  );
}
