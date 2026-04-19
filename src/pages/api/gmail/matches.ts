import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    // For each matched txn, return all shipment items for that order_id
    const result = await client.execute(`
      SELECT
        m.txn_id,
        m.order_id,
        SUM(s.amount)                          AS order_total,
        COUNT(s.message_id)                    AS shipment_count,
        GROUP_CONCAT(s.items_json, '||')       AS all_items_raw
      FROM amazon_order_matches m
      JOIN amazon_shipments s ON s.order_id = m.order_id
      GROUP BY m.txn_id, m.order_id
    `);
    return json(result.rows);
  } finally {
    client.close();
  }
}
