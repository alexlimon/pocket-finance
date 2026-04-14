import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient } from '../../../lib/db';
import * as XLSX from 'xlsx';
import type { MonthlySummary, BillRow, CCCharge, CashExpense } from '../../../lib/budget';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const year   = context.url.searchParams.get('year') ?? String(new Date().getFullYear());
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const client = getClient(env);
  let summaries:  Record<string, MonthlySummary> = {};
  let billsByMonth: Record<string, BillRow[]>    = {};
  let ccByMonth:    Record<string, CCCharge[]>   = {};
  let cashByMonth:  Record<string, CashExpense[]>= {};
  let allBills:     { id: string; name: string; is_cc_default: number; due_day: number | null }[] = [];

  try {
    const [sumR, billCfgR, billPayR, ccR, cashR] = await Promise.all([
      client.execute({ sql: `SELECT * FROM monthly_summary WHERE month LIKE ?`, args: [`${year}-%`] }),
      client.execute({ sql: `SELECT id, name, is_cc_default, due_day FROM budget_config WHERE is_recurring = 1 ORDER BY is_cc_default, name` }),
      client.execute({
        sql: `SELECT bc.id as bill_id, bc.name, bc.is_cc_default, bp.month, bp.amount as paid_amount, bp.is_paid, bp.is_cc
              FROM budget_config bc JOIN bill_payments bp ON bc.id = bp.bill_id WHERE bp.month LIKE ?`,
        args: [`${year}-%`],
      }),
      client.execute({ sql: `SELECT * FROM cc_charges WHERE month LIKE ?`, args: [`${year}-%`] }),
      client.execute({ sql: `SELECT * FROM cash_expenses WHERE month LIKE ?`, args: [`${year}-%`] }),
    ]);

    for (const r of sumR.rows)     summaries[String((r as any).month)]  = r as unknown as MonthlySummary;
    allBills = billCfgR.rows as unknown as typeof allBills;
    for (const r of billPayR.rows as unknown as any[]) {
      const m = r.month;
      if (!billsByMonth[m]) billsByMonth[m] = [];
      billsByMonth[m].push({ ...r, actual_amount: Number(r.paid_amount ?? 0) });
    }
    for (const r of ccR.rows  as unknown as CCCharge[])   { if (!ccByMonth[r.month])   ccByMonth[r.month]   = []; ccByMonth[r.month].push(r);   }
    for (const r of cashR.rows as unknown as CashExpense[]){ if (!cashByMonth[r.month]) cashByMonth[r.month] = []; cashByMonth[r.month].push(r); }
  } finally { client.close(); }

  function sumOf(month: string, key: keyof MonthlySummary): number {
    return Number(summaries[month]?.[key] ?? 0);
  }
  function paidBillAmt(month: string, billId: string): number {
    return (billsByMonth[month] ?? []).find((b:any) => b.bill_id === billId && b.is_paid)?.actual_amount ?? 0;
  }
  function ccTotal(month: string): number {
    const recurring = (billsByMonth[month] ?? []).filter((b:any)=>b.is_cc&&b.is_paid).reduce((s:number,b:any)=>s+b.actual_amount,0);
    const variable  = (ccByMonth[month] ?? []).reduce((s,c)=>s+c.amount,0);
    return recurring + variable;
  }

  // Build rows
  const rows: (string | number)[][] = [];
  const headerRow: (string | number)[] = ['', 'Due', '', ...MONTHS, 'Total', 'Goal', 'AVG'];
  rows.push(headerRow);

  function dataRow(label: string, due: string | number, vals: (number | '')[], total?: number): (string|number)[] {
    const t = total ?? (vals as number[]).filter(v=>v!=='').reduce((a,b)=>a+b,0);
    return [label, due, '', ...vals, t, '', vals.filter(v=>v!=='').length ? t / vals.filter(v=>v!=='').length : ''];
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
    const vals = months.map(m => { const a = paidBillAmt(m, bill.id); return a ? -a : ''; });
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
    const vals = months.map(m => { const a = paidBillAmt(m, bill.id); return a ? -a : ''; });
    rows.push(dataRow(bill.name, bill.due_day ?? '', vals));
  }
  const ccRecTotals = months.map(m =>
    -(billsByMonth[m] ?? []).filter((b:any)=>b.is_cc&&b.is_paid).reduce((s:number,b:any)=>s+b.actual_amount,0)
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
    const out = (billsByMonth[m]??[]).filter((b:any)=>!b.is_cc&&b.is_paid).reduce((s:number,b:any)=>s+b.actual_amount,0);
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
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Budget-${year}.xlsx"`,
    },
  });
}
