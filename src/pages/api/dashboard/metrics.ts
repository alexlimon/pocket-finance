import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import {
  totalCash, totalCreditDebt, netCash,
  safeToSpend, monthlySpending, monthlyIncome,
  avgMonthlyBurn, budgetProgress, statusLight,
  propertyPL, eoyProjection,
  type AccountRow, type TransactionRow, type BudgetRow, type IncomeRow,
} from '../../../lib/finance';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const [acctRes, txnRes, budgetRes, incomeRes] = await Promise.all([
      client.execute('SELECT * FROM accounts WHERE is_active = 1'),
      client.execute(`
        SELECT * FROM transactions
        WHERE is_hidden = 0
          AND date >= date('now', '-90 days')
        LIMIT 500
      `),
      client.execute('SELECT * FROM budget_config'),
      client.execute('SELECT * FROM income_sources WHERE is_active = 1'),
    ]);

    const accounts     = acctRes.rows     as unknown as AccountRow[];
    const transactions = txnRes.rows      as unknown as TransactionRow[];
    const budgets      = budgetRes.rows   as unknown as BudgetRow[];
    const incomes      = incomeRes.rows   as unknown as IncomeRow[];

    const sts      = safeToSpend(accounts, budgets, transactions);
    const spending = monthlySpending(transactions);
    const light    = statusLight({
      safeToSpendAmount:   sts.amount,
      bills:               sts.bills,
      currentMonthlySpend: spending,
      monthlyBudgetTarget: budgets.reduce((s, b) => s + (b.monthly_target ?? 0), 0),
    });

    return json({
      accounts: {
        totalCash:        totalCash(accounts),
        totalCreditDebt:  totalCreditDebt(accounts),
        netCash:          netCash(accounts),
      },
      safeToSpend:   sts.amount,
      upcomingBills: sts.bills,
      monthly: {
        spending: spending,
        income:   monthlyIncome(transactions),
        avgBurn:  avgMonthlyBurn(transactions),
      },
      budgetProgress: budgetProgress(budgets, transactions),
      properties: {
        kirby:   propertyPL(transactions, 'kirby'),
        kennedy: propertyPL(transactions, 'kennedy'),
      },
      eoyProjection: eoyProjection({ accounts, transactions, incomeSources: incomes }),
      statusLight: light,
    });
  } finally {
    client.close();
  }
}
