import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface Item {
  name: string;
  qty:  number;
}

function parseItems(allItemsRaw: string | null): Item[] {
  return allItemsRaw
    ? allItemsRaw.split('||').flatMap(chunk => {
        try { return JSON.parse(chunk) as Item[]; } catch { return []; }
      })
    : [];
}

function productNames(items: Item[]): string {
  return items.map(i => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(' + ');
}

interface ChaseRow {
  date:           string;
  account_last4:  string;
  account_source: string;
  description:    string;
  category:       string | null;
  type:           string | null;
  amount:         number;
  memo:           string | null;
  order_id:       string | null;
  all_items_raw:  string | null;
}

interface BigPurchaseRow {
  date:          string | null;
  month:         string;
  description:   string;
  amount:        number;
  category_name: string | null;
}

interface UnmatchedOrderRow {
  order_id:      string;
  total:         number;
  last_date:     string;
  all_items_raw: string | null;
}

interface CsvLine {
  date:            string;
  account:         string;
  description:     string;
  amount:          number;
  category:        string | null;
  type:            string | null;
  memo:            string | null;
  amazon_order_id: string | null;
  raw_description: string | null;
  source:          string;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const params = new URL(context.request.url).searchParams;
  const excludeChecking = params.get('exclude_checking') === '1' || params.get('exclude_checking') === 'true';
  // Checking = the 2605 account; everything else is a credit card.
  // Filtered on last4 only — stored account_source is unreliable for older rows.
  const chaseWhere = excludeChecking ? `WHERE t.account_last4 <> '2605'` : '';

  const client = getClient(env);
  try {
    const [chaseRes, bigRes, orderRes] = await Promise.all([
      client.execute(`
        SELECT
          t.date,
          t.account_last4,
          t.account_source,
          t.description,
          t.category,
          t.type,
          t.amount,
          t.memo,
          m.order_id,
          m.all_items_raw
        FROM csv_transactions t
        LEFT JOIN (
          SELECT m2.txn_id,
                 m2.order_id,
                 GROUP_CONCAT(s.items_json, '||') AS all_items_raw
          FROM amazon_order_matches m2
          JOIN amazon_shipments s ON s.order_id = m2.order_id
          GROUP BY m2.txn_id, m2.order_id
        ) m ON m.txn_id = t.id
        ${chaseWhere}
        ORDER BY t.date ASC, t.account_last4 ASC
      `),
      client.execute(`
        SELECT
          c.date,
          c.month,
          c.description,
          c.amount,
          COALESCE(cat.name, c.category_id) AS category_name
        FROM cc_charges c
        LEFT JOIN categories cat ON c.category_id = cat.id
        WHERE c.card = 'apple'
          AND c.is_big_purchase = 1
          AND COALESCE(c.is_estimated, 0) = 0
        ORDER BY c.date ASC
      `),
      client.execute(`
        SELECT
          s.order_id,
          SUM(s.amount)             AS total,
          MAX(s.email_date)         AS last_date,
          GROUP_CONCAT(s.items_json, '||') AS all_items_raw
        FROM amazon_shipments s
        WHERE s.order_id NOT IN (SELECT order_id FROM amazon_order_matches)
        GROUP BY s.order_id
        ORDER BY last_date ASC
      `),
    ]);

    const out: CsvLine[] = [];

    // ── Source 1: Chase CSV feed (Amazon-matched rows get product-name descriptions) ──
    for (const r of chaseRes.rows as unknown as ChaseRow[]) {
      const description = (() => {
        const names = productNames(parseItems(r.all_items_raw));
        return (r.order_id && names) ? names : r.description;
      })();
      out.push({
        date:            r.date,
        account:         r.account_last4,
        description,
        amount:          r.amount,
        category:        r.category,
        type:            r.type,
        memo:            r.memo,
        amazon_order_id: r.order_id,
        raw_description: r.description,
        source:          'chase-csv',
      });
    }

    // ── Source 2: Apple Card big purchases (swiped only, estimates hidden) ──
    for (const r of bigRes.rows as unknown as BigPurchaseRow[]) {
      out.push({
        date:            r.date ?? `${r.month}-01`,
        account:         'apple-card',
        description:     r.description,
        amount:          -Math.abs(r.amount),   // Chase convention: negative = money out
        category:        r.category_name,
        type:            null,
        memo:            null,
        amazon_order_id: null,
        raw_description: r.description,
        source:          'apple-big-purchase',
      });
    }

    // ── Source 3: Amazon orders with no matching CC transaction ──
    for (const r of orderRes.rows as unknown as UnmatchedOrderRow[]) {
      const names = productNames(parseItems(r.all_items_raw));
      out.push({
        date:            r.last_date,
        account:         'amazon-cc',
        description:     names || `Amazon order ${r.order_id}`,
        amount:          -Math.round(Math.abs(r.total) * 100) / 100,
        category:        null,
        type:            null,
        memo:            null,
        amazon_order_id: r.order_id,
        raw_description: null,
        source:          'amazon-order-unmatched',
      });
    }

    out.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));

    const header = ['date', 'account', 'description', 'amount', 'category', 'type', 'memo', 'amazon_order_id', 'raw_description', 'source'];
    const lines  = [header.join(',')];
    for (const r of out) {
      lines.push([
        r.date,
        r.account,
        r.description,
        r.amount,
        r.category,
        r.type,
        r.memo,
        r.amazon_order_id,
        r.raw_description,
        r.source,
      ].map(csvField).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(`\uFEFF${lines.join('\r\n')}`, {
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="transactions-${stamp}.csv"`,
      },
    });
  } finally {
    client.close();
  }
}
