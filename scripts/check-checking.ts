import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
const c = readFileSync('.dev.vars', 'utf-8');
const vars: Record<string,string> = {};
for (const l of c.split('\n')) { const t = l.trim(); if(!t||t.startsWith('#'))continue; const i=t.indexOf('='); if(i>-1)vars[t.slice(0,i).trim()]=t.slice(i+1).trim(); }
const db = createClient({ url: vars.TURSO_DATABASE_URL, authToken: vars.TURSO_AUTH_TOKEN });

const sum = await db.execute(`SELECT month, income_alex, income_maham, income_other, checking_before, savings_before, savings_after, cc_budget, cc_recurring_budget FROM monthly_summary WHERE month >= '2026-01' ORDER BY month`);
const cash = await db.execute(`SELECT month, type, amount FROM cash_expenses WHERE month >= '2026-01'`);
const bills = await db.execute(`
  SELECT bp.month, SUM(bp.amount) AS fixed_checking
  FROM bill_payments bp JOIN budget_config bc ON bc.id=bp.bill_id
  WHERE bp.month>='2026-01' AND bp.is_paid=1 AND COALESCE(bp.is_cc, bc.is_cc_default)=0
  GROUP BY bp.month`);

const cashByMonth: Record<string,{inc:number,exp:number}> = {};
for (const r of cash.rows as any[]) { const m=r.month; (cashByMonth[m]??={inc:0,exp:0}); if(r.type==='income')cashByMonth[m].inc+=r.amount; else cashByMonth[m].exp+=r.amount; }
const billsByMonth: Record<string,number> = {};
for (const r of bills.rows as any[]) billsByMonth[r.month]=r.fixed_checking;

const rows = sum.rows as any[];
const out = [];
for (let i=0; i<rows.length; i++) {
  const r = rows[i], m = r.month;
  const income = r.income_alex + r.income_maham + (cashByMonth[m]?.inc ?? 0);
  const ccPay = (r.cc_budget ?? 0) + (r.cc_recurring_budget ?? 0);
  const fixed = billsByMonth[m] ?? 0;
  const cashExp = cashByMonth[m]?.exp ?? 0;
  const net = income - fixed - ccPay - cashExp;
  const savTx = (r.savings_after ?? 0) - (r.savings_before ?? 0);
  const computedEnd = r.checking_before + net - savTx;
  const nextStart = rows[i+1]?.checking_before ?? null;
  const delta = nextStart !== null ? (computedEnd - nextStart) : null;
  out.push({ month: m, start: r.checking_before, inc: +income.toFixed(2), fixed, ccPay: +ccPay.toFixed(2), cashExp, net: +net.toFixed(2), savTx, compEnd: +computedEnd.toFixed(2), nextStart, delta: delta !== null ? +delta.toFixed(2) : null });
}
console.table(out);
db.close();
