import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseAmount(s: string): number {
  // Handles "14.05", "'-1.02'", "-1.02", ""
  const cleaned = s.replace(/['"]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function isoToDate(s: string): string {
  // "2020-04-28T07:27:35Z" → "2020-04-28"
  return s.slice(0, 10);
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let formData: FormData;
  try { formData = await context.request.formData(); }
  catch { return json({ error: 'Expected multipart/form-data' }, 400); }

  const file = formData.get('file') as File | null;
  if (!file) return json({ error: 'Missing file' }, 400);

  const text  = await file.text();
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return json({ error: 'Empty file' }, 400);

  // Parse header → column indexes
  const header = parseCSVLine(lines[0]!).map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());
  const col = (name: string) => header.indexOf(name);

  const orderIdIdx   = col('order id');
  const productIdx   = col('product name');
  const shipDateIdx  = col('ship date');
  const totalIdx     = col('total amount');
  const paymentIdx   = col('payment method type');
  const qtyIdx       = col('original quantity');
  const asinIdx      = col('asin');

  if (orderIdIdx === -1 || totalIdx === -1 || shipDateIdx === -1) {
    return json({ error: 'CSV missing required columns — make sure this is an Amazon Order History export' }, 400);
  }

  // Group line items by order_id — aggregate total and collect items
  const orders = new Map<string, {
    order_id:   string;
    total:      number;
    shipDates:  string[];
    items:      { name: string; qty: number; asin: string }[];
    payment:    string;
  }>();

  for (const line of lines.slice(1)) {
    const f = parseCSVLine(line);
    const orderId  = f[orderIdIdx]  ?? '';
    const product  = f[productIdx]  ?? '';
    const shipDate = f[shipDateIdx] ?? '';
    const total    = parseAmount(f[totalIdx] ?? '0');
    const payment  = f[paymentIdx]  ?? '';
    const qty      = parseInt(f[qtyIdx] ?? '1', 10) || 1;
    const asin     = f[asinIdx]     ?? '';

    if (!orderId || !shipDate || shipDate === 'Not Applicable') continue;

    if (!orders.has(orderId)) {
      orders.set(orderId, { order_id: orderId, total: 0, shipDates: [], items: [], payment });
    }
    const o = orders.get(orderId)!;
    if (total > 0) o.total += total;          // skip refund/discount lines
    const dateStr = isoToDate(shipDate);
    if (!o.shipDates.includes(dateStr)) o.shipDates.push(dateStr);
    if (product && product !== 'Not Available') o.items.push({ name: product.slice(0, 100), qty, asin });
  }

  // ── Build all rows in memory, then batch-insert ───────────────────────────
  const shipmentRows: { messageId: string; orderId: string; lastShip: string; total: number; itemsJson: string; subject: string }[] = [];

  for (const o of orders.values()) {
    const lastShip = [...o.shipDates].sort().at(-1)!;
    const subject  = `Order ${o.order_id} · ${o.items.length} item${o.items.length !== 1 ? 's' : ''}`;
    shipmentRows.push({ messageId: `oh_${o.order_id}`, orderId: o.order_id, lastShip, total: o.total, itemsJson: JSON.stringify(o.items), subject });
  }

  // ── Match in-memory (no extra DB round-trips) ──────────────────────────────
  const txnRes = await (async () => {
    const client = getClient(env);
    try {
      const [txnR] = await Promise.all([
        client.execute(`SELECT id, date, amount FROM csv_transactions WHERE account_last4 = '3606'`),
      ]);
      return txnR;
    } finally { client.close(); }
  })();
  const txns = txnRes.rows as unknown as { id: string; date: string; amount: number }[];

  const usedTxns = new Set<string>();
  const matchRows: { txnId: string; orderId: string }[] = [];

  for (const row of shipmentRows) {
    const shipMs = new Date(row.lastShip).getTime();
    const PAD    = 4 * 86_400_000;
    const match  = txns.find(t => {
      if (usedTxns.has(t.id)) return false;
      const amountOk = Math.abs(Math.abs(t.amount) - row.total) < 0.02;
      const txnMs    = new Date(t.date).getTime();
      return amountOk && txnMs >= shipMs - PAD && txnMs <= shipMs + PAD;
    });
    if (match) { usedTxns.add(match.id); matchRows.push({ txnId: match.id, orderId: row.orderId }); }
  }

  // ── Single batch write: clear + insert all at once ─────────────────────────
  const client = getClient(env);
  try {
    await client.batch([
      { sql: `DELETE FROM amazon_shipments WHERE message_id LIKE 'oh_%'`, args: [] },
      { sql: `DELETE FROM amazon_order_matches`, args: [] },
      ...shipmentRows.map(r => ({
        sql:  `INSERT OR REPLACE INTO amazon_shipments (message_id, order_id, email_date, amount, items_json, email_subject) VALUES (?,?,?,?,?,?)`,
        args: [r.messageId, r.orderId, r.lastShip, r.total, r.itemsJson, r.subject],
      })),
      ...matchRows.map(r => ({
        sql:  `INSERT OR REPLACE INTO amazon_order_matches (txn_id, order_id) VALUES (?,?)`,
        args: [r.txnId, r.orderId],
      })),
    ], 'write');

    return json({ ok: true, orders: shipmentRows.length, matched: matchRows.length, total3606: txns.length });
  } finally {
    client.close();
  }
}
