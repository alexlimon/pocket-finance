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

function parseDate(s: string): string {
  // MM/DD/YYYY → YYYY-MM-DD
  const parts = s.split('/');
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  return s;
}

function makeId(account_last4: string, date: string, description: string, rawAmount: string): string {
  // Deterministic fingerprint — unique per logical transaction, safe as SQLite TEXT PK
  return `${account_last4}|${date}|${description}|${rawAmount}`;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let formData: FormData;
  try { formData = await context.request.formData(); }
  catch { return json({ error: 'Expected multipart/form-data' }, 400); }

  const file = formData.get('file') as File | null;
  if (!file) return json({ error: 'Missing file' }, 400);

  // Extract account last 4 from filename: Chase1957_Activity... → '1957'
  const filenameMatch = file.name.match(/Chase(\d{4})_/i);
  const account_last4 = filenameMatch?.[1] ?? 'unknown';
  // 3606 = Amazon CC, everything else treated as checking
  const account_source = account_last4 === '3606' ? 'amazon-cc' : 'checking';

  const text = await file.text();
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return json({ error: 'File has no data rows' }, 400);

  const header = parseCSVLine(lines[0]!).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const col = (name: string) => header.indexOf(name);

  // Detect checking format (Chase checking export uses "Posting Date" not "Transaction Date")
  const isChecking = col('posting_date') !== -1 && col('transaction_date') === -1;

  const dateIdx   = isChecking ? col('posting_date') : col('transaction_date');
  const postIdx   = isChecking ? -1 : col('post_date');
  const descIdx   = col('description');
  const catIdx    = col('category');
  const typeIdx   = col('type');
  const amountIdx = col('amount');
  const memoIdx   = col('memo');

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) {
    return json({ error: 'CSV missing required columns (Transaction Date / Posting Date, Description, Amount)' }, 400);
  }

  // Types to skip for checking accounts: credit card payments and savings transfers
  const CHECKING_SKIP_TYPES = new Set(['LOAN_PMT', 'ACCT_XFER']);
  // Description substrings to skip for checking accounts: mortgage payments
  const CHECKING_SKIP_DESC = ['JPMORGAN CHASE   CHASE ACH', 'PROVIDENT FUNDIN ACH PMT'];

  const client = getClient(env);
  let inserted = 0;
  let skipped = 0;

  try {
    for (const line of lines.slice(1)) {
      const f = parseCSVLine(line);
      const rawDate   = f[dateIdx]   ?? '';
      const rawPost   = postIdx   >= 0 ? (f[postIdx]   ?? '') : '';
      const desc      = f[descIdx]   ?? '';
      const category  = catIdx   >= 0 ? (f[catIdx]   ?? '') : '';
      const type      = typeIdx  >= 0 ? (f[typeIdx]  ?? '') : '';
      const rawAmount = amountIdx >= 0 ? (f[amountIdx] ?? '0') : '0';
      const memo      = memoIdx  >= 0 ? (f[memoIdx]  ?? '') : '';

      if (!rawDate || !desc) continue;
      const amount = parseFloat(rawAmount);
      if (isNaN(amount)) continue;

      // Skip CC payments, savings transfers, and mortgage payments for checking accounts
      if (isChecking && CHECKING_SKIP_TYPES.has(type)) { skipped++; continue; }
      if (isChecking && CHECKING_SKIP_DESC.some(s => desc.includes(s))) { skipped++; continue; }

      const date     = parseDate(rawDate);
      const postDate = rawPost ? parseDate(rawPost) : null;
      const id       = makeId(account_last4, date, desc, rawAmount);

      const result = await client.execute({
        sql: `INSERT OR IGNORE INTO csv_transactions
              (id, account_last4, account_source, date, post_date, description, category, type, amount, memo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, account_last4, account_source, date, postDate, desc,
               category || null, type || null, amount, memo || null],
      });

      if (result.rowsAffected > 0) inserted++;
      else skipped++;
    }

    return json({ ok: true, inserted, skipped, account: account_last4 });
  } finally {
    client.close();
  }
}
