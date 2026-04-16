import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient } from '../../../lib/db';
import * as XLSX from 'xlsx';
import type { MonthlySummary, CCCharge, CashExpense } from '../../../lib/budget';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const year   = context.url.searchParams.get('year') ?? String(new Date().getFullYear());
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const client = getClient(env);
  let summaries:    Record<string, MonthlySummary> = {};
  let payByMonthBill: Record<string, { amount: number; is_skipped: number }> = {}; // key = "month|bill_id"
  let ccByMonth:    Record<string, CCCharge[]>    = {};
  let cashByMonth:  Record<string, CashExpense[]> = {};
  let ccVarByMonth: Record<string, number>        = {};
  let allBills:     { id: string; name: string; monthly_target: number | null; is_cc_default: number; due_day: number | null; start_month: string | null; end_month: string | null }[] = [];

  try {
    const [sumR, billCfgR, billPayR, ccR, cashR, ccVarR] = await Promise.all([
      client.execute({ sql: `SELECT * FROM monthly_summary WHERE month LIKE ?`, args: [`${year}-%`] }),
      client.execute({ sql: `SELECT id, name, monthly_target, is_cc_default, due_day, start_month, end_month FROM budget_config WHERE is_recurring = 1 ORDER BY is_cc_default, name`, args: [] }),
      client.execute({
        sql: `SELECT bill_id, month, amount, is_skipped FROM bill_payments WHERE month LIKE ?`,
        args: [`${year}-%`],
      }),
      client.execute({ sql: `SELECT * FROM cc_charges WHERE month LIKE ?`, args: [`${year}-%`] }),
      client.execute({ sql: `SELECT * FROM cash_expenses WHERE month LIKE ?`, args: [`${year}-%`] }),
      client.execute({ sql: `SELECT month, SUM(amount) as total FROM cc_variable_spend WHERE month LIKE ? GROUP BY month`, args: [`${year}-%`] }),
    ]);

    for (const r of sumR.rows) summaries[String((r as any).month)] = r as unknown as MonthlySummary;
    allBills = billCfgR.rows as unknown as typeof allBills;
    for (const r of billPayR.rows as unknown as any[]) {
      payByMonthBill[`${r.month}|${r.bill_id}`] = { amount: Number(r.amount), is_skipped: Number(r.is_skipped) };
    }
    for (const r of ccR.rows   as unknown as CCCharge[])   { if (!ccByMonth[r.month])   ccByMonth[r.month]   = []; ccByMonth[r.month].push(r);   }
    for (const r of cashR.rows as unknown as CashExpense[]) { if (!cashByMonth[r.month]) cashByMonth[r.month] = []; cashByMonth[r.month].push(r); }
    for (const r of ccVarR.rows as unknown as { month: string; total: number }[]) {
      ccVarByMonth[r.month] = Number(r.total);
    }
  } finally { client.close(); }

  function sumOf(month: string, key: keyof MonthlySummary): number {
    return Number(summaries[month]?.[key] ?? 0);
  }
  // Resolves a bill's amount for a month: payment override → monthly_target → 0. Skipped = 0.
  function billAmt(month: string, billId: string): number {
    const cfg = allBills.find(b => b.id === billId);
    if (cfg?.start_month && month < cfg.start_month) return 0;
    if (cfg?.end_month   && month > cfg.end_month)   return 0;
    const pay = payByMonthBill[`${month}|${billId}`];
    if (pay?.is_skipped === 1) return 0;
    return pay ? pay.amount : Number(cfg?.monthly_target ?? 0);
  }
  function ccTotal(month: string): number {
    const variable     = ccVarByMonth[month] ?? 0;
    const bigPurchases = (ccByMonth[month] ?? []).reduce((s, c) => s + c.amount, 0);
    return variable + bigPurchases;
  }

  // Build rows
  const rows: (string | number)[][] = [];
  const headerRow: (string | number)[] = ['', 'Due', '', ...MONTHS, 'Total', 'Goal', 'AVG'];
  rows.push(headerRow);

  function dataRow(label: string, due: string | number, vals: (number | '')[], total?: number): (string|number)[] {
    const nonEmpty = vals.filter((v): v is number => v !== '');
    const t = total ?? nonEmpty.reduce((a, b) => a + b, 0);
    return [label, due, '', ...vals, t, '', nonEmpty.length ? t / nonEmpty.length : ''];
  }

  // Bank accounts
  rows.push(['Bank Accounts']);
  rows.push(['Checking']);
  rows.push(dataRow('Before', '', months.map(m => sumOf(m,'checking_before') || '')));
  rows.push(dataRow('After',  '', months.map(m => sumOf(m,'checking_after')  || '')));
  rows.push(['Savings']);
  rows.push(dataRow('Before', '', months.map(m => sumOf(m,'savings_before') || '')));
  rows.push(dataRow('After',  '', months.map(m => sumOf(m,'savings_after')  || '')));
  rows.push([]);

  // Income
  rows.push(['Income']);
  rows.push(dataRow('Alex',  '', months.map(m => sumOf(m,'income_alex')   || '')));
  rows.push(dataRow('Maham', '', months.map(m => sumOf(m,'income_maham')  || '')));
  rows.push(dataRow('Other', '', months.map(m => sumOf(m,'income_other')  || '')));
  const incTotals = months.map(m => sumOf(m,'income_alex') + sumOf(m,'income_maham') + sumOf(m,'income_other'));
  rows.push(dataRow('Total', '', incTotals.map(v=>v||'')));
  rows.push([]);

  // Fixed bills (non-CC)
  rows.push(['Expenses', 'Date Due']);
  const checkingBills = allBills.filter(b => !b.is_cc_default);
  for (const bill of checkingBills) {
    const vals = months.map(m => { const a = billAmt(m, bill.id); return a ? -a : ''; });
    rows.push(dataRow(bill.name, bill.due_day ?? '', vals));
  }
  // CC payment line
  const ccPayments = months.map(m => { const t = ccTotal(m); return t ? -t : ''; });
  rows.push(dataRow('Credit Card', 12, ccPayments));
  rows.push([]);

  // CC recurring breakdown
  rows.push(['Recurring Bills', 'Date Due', 'Default']);
  const ccBillsCfg = allBills.filter(b => b.is_cc_default);
  for (const bill of ccBillsCfg) {
    const vals = months.map(m => { const a = billAmt(m, bill.id); return a ? -a : ''; });
    rows.push(dataRow(bill.name, bill.due_day ?? '', vals));
  }
  const ccRecTotals = months.map(m =>
    -ccBillsCfg.reduce((s, b) => s + billAmt(m, b.id), 0)
  );
  rows.push(dataRow('Total Recurring', '', ccRecTotals.map(v=>v||'')));
  rows.push([]);

  // CC variable + big purchases
  rows.push(['Major Purchases / Variable CC']);
  const uniqueDescs = new Set<string>();
  for (const ccs of Object.values(ccByMonth)) for (const c of ccs) uniqueDescs.add(c.description);
  for (const desc of uniqueDescs) {
    const vals = months.map(m => { const c = ccByMonth[m]?.find(x=>x.description===desc); return c ? -c.amount : ''; });
    rows.push(dataRow(desc, '', vals));
  }
  rows.push([]);

  // Cash expenses
  rows.push(['Other Cash']);
  const uniqueCash = new Set<string>();
  for (const ces of Object.values(cashByMonth)) for (const e of ces) uniqueCash.add(e.description);
  for (const desc of uniqueCash) {
    const vals = months.map(m => { const e = cashByMonth[m]?.find(x=>x.description===desc); return e ? -e.amount : ''; });
    rows.push(dataRow(desc, '', vals));
  }
  rows.push([]);

  // Net
  const nets = months.map((m, i) => {
    const inc = incTotals[i];
    const out = checkingBills.reduce((s, b) => s + billAmt(m, b.id), 0);
    const cc  = ccTotal(m);
    return inc - out - cc;
  });
  rows.push(dataRow('Net', '', nets.map(v=>v||'')));

  // Build workbook
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 28 }, { wch: 6 }, { wch: 4 },
    ...Array(12).fill({ wch: 11 }),
    { wch: 12 }, { wch: 8 }, { wch: 10 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, `${year} Budget`);
  const buf  = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;
  const binary = atob(buf);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  return new Response(blob, {
    headers: {
      'Content-Disposition': `attachment; filename="Budget-${year}.xlsx"`,
    },
  });
}
