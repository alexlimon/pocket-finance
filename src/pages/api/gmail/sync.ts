import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import {
  getValidToken,
  listMessageIds,
  fetchMessage,
  parseAmazonEmail,
  saveLastSync,
} from '../../../lib/gmail';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const clientId     = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: 'Google credentials not configured' }, 500);

  const accessToken = await getValidToken(env, clientId, clientSecret);
  if (!accessToken) return json({ error: 'Gmail not connected' }, 401);

  const client = getClient(env);
  try {
    // Bound search to earliest 3606 transaction date
    const dateRes  = await client.execute(
      `SELECT MIN(date) as min_date FROM csv_transactions WHERE account_last4 = '3606'`
    );
    const minDate   = (dateRes.rows[0]?.min_date as string | null) ?? '2026-01-01';
    const afterDate = minDate.slice(0, 10).replace(/-/g, '/');

    // Shipment emails only — each has the per-shipment amount, not the full order total
    const ids = await listMessageIds(accessToken, `from:ship-confirm@amazon.com after:${afterDate}`, 500);

    let fetched = 0, inserted = 0;

    for (const messageId of ids) {
      fetched++;
      const msg = await fetchMessage(accessToken, messageId);
      if (!msg) continue;

      const parsed = parseAmazonEmail(msg);
      if (!parsed) continue;

      const { orderId, grandTotal, items, emailDate, subject } = parsed;

      const result = await client.execute({
        sql: `INSERT OR IGNORE INTO amazon_shipments
              (message_id, order_id, email_date, amount, items_json, email_subject)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [messageId, orderId, emailDate, grandTotal, JSON.stringify(items), subject],
      });
      if (result.rowsAffected > 0) inserted++;
    }

    // Aggregate: group by order_id, sum amounts, collect date range
    const shipmentsRes = await client.execute(`
      SELECT order_id,
             SUM(amount)      as total,
             MIN(email_date)  as first_date,
             MAX(email_date)  as last_date
      FROM amazon_shipments
      GROUP BY order_id
    `);
    const orders = shipmentsRes.rows as unknown as {
      order_id: string; total: number; first_date: string; last_date: string;
    }[];

    // Load all 3606 CC transactions
    const txnRes = await client.execute(
      `SELECT id, date, amount FROM csv_transactions WHERE account_last4 = '3606'`
    );
    const txns = txnRes.rows as unknown as { id: string; date: string; amount: number }[];

    // Match: summed order total → single CC transaction within the shipment date window
    const usedTxns = new Set<string>();
    let totalMatches = 0, newMatches = 0;

    for (const order of orders) {
      const firstMs = new Date(order.first_date).getTime();
      const lastMs  = new Date(order.last_date).getTime();
      const PAD     = 3 * 86_400_000; // ±3 days outside shipment window

      const match = txns.find(t => {
        if (usedTxns.has(t.id)) return false;
        const amountOk = Math.abs(Math.abs(t.amount) - order.total) < 0.02;
        const txnMs    = new Date(t.date).getTime();
        const dateOk   = txnMs >= firstMs - PAD && txnMs <= lastMs + PAD;
        return amountOk && dateOk;
      });

      if (match) {
        usedTxns.add(match.id);
        totalMatches++;
        const r = await client.execute({
          sql:  `INSERT OR IGNORE INTO amazon_order_matches (txn_id, order_id) VALUES (?, ?)`,
          args: [match.id, order.order_id],
        });
        if (r.rowsAffected > 0) newMatches++;
      }
    }

    await saveLastSync(env);

    return json({ ok: true, fetched, inserted, totalMatches, newMatches });
  } finally {
    client.close();
  }
}
