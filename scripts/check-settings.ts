import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
const c = readFileSync('.dev.vars', 'utf-8');
const vars: Record<string,string> = {};
for (const l of c.split('\n')) { const t = l.trim(); if(!t||t.startsWith('#'))continue; const i=t.indexOf('='); if(i>-1)vars[t.slice(0,i).trim()]=t.slice(i+1).trim(); }
const db = createClient({ url: vars.TURSO_DATABASE_URL, authToken: vars.TURSO_AUTH_TOKEN });
const cols = await db.execute("PRAGMA table_info(bill_payments)");
console.log('bill_payments columns:', cols.rows.map((r:any) => r.name));
const bpSample = await db.execute("SELECT * FROM bill_payments WHERE is_skipped=1 LIMIT 5");
console.log('skipped payments:', JSON.stringify(bpSample.rows, null, 2));
db.close();
