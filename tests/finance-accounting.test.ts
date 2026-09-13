import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, it, mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/finance_accounting_tests_only';
process.env.JWT_SECRET='finance-accounting-tests-only-secret';

const {pool}=await import('../src/db/pool.js');
const journal=await import('../src/modules/finance/journal.service.js');
const journalRepo=await import('../src/modules/finance/journal.repo.js');
const documents=await import('../src/modules/commercial-documents/commercial-documents.repo.js');
const projection=await import('../src/modules/finance/invoice-journal.projection.js');
const {DOMAIN_EVENT_TYPES}=await import('../src/events/domain-event.types.js');
const {decimalToMinorUnits}=await import('../src/modules/finance/money.js');
const db=new PGlite();
let owner='';let workspace='';let otherWorkspace='';

before(async()=>{
  for(const file of(await readdir('src/database/migrations')).filter((name)=>name.endsWith('.sql')).sort())await db.exec(await readFile(`src/database/migrations/${file}`,'utf8'));
  const execute=async(sql:string,values:unknown[]=[])=>(async()=>{const result=await db.query(sql,values);return{rows:result.rows,rowCount:result.affectedRows??result.rows.length};})();
  mock.method(pool,'query',execute as never);
  mock.method(pool,'connect',(async()=>({query:execute,release(){}})) as never);
  owner=(await db.query<{id:string}>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`,[`finance-${crypto.randomUUID()}@example.test`])).rows[0]!.id;
  workspace=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Finance workspace',$1) RETURNING id`,[owner])).rows[0]!.id;
  otherWorkspace=(await db.query<{id:string}>(`INSERT INTO workspaces(name,created_by) VALUES('Other finance workspace',$1) RETURNING id`,[owner])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$2,'owner')`,[workspace,owner,otherWorkspace]);
});
after(async()=>{mock.restoreAll();await pool.end();await db.close();});

describe('balanced operational journals',()=>{
  it('posts balanced groups atomically, safely retries, and isolates tenants',async()=>{
    const occurredAt='2026-09-13T07:00:00.000Z';
    const input={workspaceId:workspace,journalType:'MANUAL_TEST',occurredAt,currency:'cny',idempotencyKey:'manual:test:one',referenceType:'test',referenceId:'one',actorId:owner,metadata:{purpose:'verification'},lines:[{lineKey:'cash',accountCode:'cash',direction:'DEBIT' as const,amountMinor:1250},{lineKey:'revenue',accountCode:'sales_revenue',direction:'CREDIT' as const,amountMinor:1250}]};
    const first=await journal.postBalancedJournal(input);
    const second=await journal.postBalancedJournal(input);
    assert.equal(second.id,first.id);assert.equal(second.idempotent,true);assert.equal(first.lines.length,2);
    await assert.rejects(()=>journal.postBalancedJournal({...input,lines:[{...input.lines[0]!,amountMinor:1300},{...input.lines[1]!,amountMinor:1300}]}),/idempotency key was already used/i);
    await assert.rejects(()=>journal.postBalancedJournal({...input,idempotencyKey:'manual:test:unbalanced',lines:[input.lines[0]!,{...input.lines[1]!,amountMinor:1200}]}),/must balance/i);
    assert.equal(await journalRepo.getJournal(otherWorkspace,first.id),null);
    const balance=await journalRepo.getAccountBalance(workspace,'CASH','CNY');assert.equal(balance.balanceMinor,'1250');assert.equal(balance.balanceDirection,'DEBIT');
    const trial=await journalRepo.getTrialBalance(workspace,'CNY');assert.equal(trial.balanced,true);assert.deepEqual(trial.totals,{debitsMinor:'1250',creditsMinor:'1250'});
    await assert.rejects(()=>db.query(`DELETE FROM financial_journals WHERE id=$1`,[first.id]),/append-only/i);
    await assert.rejects(()=>db.query(`DELETE FROM financial_ledger_entries WHERE entry_group_id=$1`,[first.id]),/append-only/i);
  });

  it('converts decimal values to safe ISO minor units with explicit rounding',()=>{
    assert.equal(decimalToMinorUnits('10.005','CNY'),1001);
    assert.equal(decimalToMinorUnits('101','JPY'),101);
    assert.throws(()=>decimalToMinorUnits('999999999999999999999','CNY'),/safe operational ledger limit/i);
  });
});

describe('invoice receivable lifecycle',()=>{
  it('records idempotent partial/full payments and projects truthful balanced journals',async()=>{
    const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(workspace_id,invoice_number,invoice_type,status,currency,grand_total,tax_total,amount_due,issued_at,created_by,updated_by) VALUES($1,$2,'STANDARD','ISSUED','CNY',100,10,100,NOW(),$3,$3) RETURNING id`,[workspace,`INV-TEST-${crypto.randomUUID()}`,owner])).rows[0]!;
    const issuedEvent={id:crypto.randomUUID(),sequence:'1',workspaceId:workspace,type:DOMAIN_EVENT_TYPES.INVOICE_ISSUED,version:1,aggregateType:'invoice',aggregateId:invoice.id,payload:{invoiceId:invoice.id},metadata:{actorId:owner},idempotencyKey:null,status:'processing' as const,attempts:1,maxAttempts:12,availableAt:new Date().toISOString(),lockedAt:null,lockedBy:null,processedAt:null,deadLetteredAt:null,lastError:null,occurredAt:new Date().toISOString()};
    const issued=await projection.projectInvoiceJournalEvent(issuedEvent);assert.ok('journalId' in issued);
    const issuedAgain=await projection.projectInvoiceJournalEvent({...issuedEvent,id:crypto.randomUUID()});assert.equal('idempotent' in issuedAgain&&issuedAgain.idempotent,true);
    const issuedJournal=await journalRepo.getJournal(workspace,(issued as{journalId:string}).journalId);assert.deepEqual(issuedJournal?.lines.map((line)=>[line.accountCode,line.direction,line.amountMinor]),[['ACCOUNTS_RECEIVABLE','DEBIT','10000'],['SALES_REVENUE','CREDIT','9000'],['TAX_PAYABLE','CREDIT','1000']]);

    const firstInput={amount:'40.00',paymentMethod:'BANK_TRANSFER' as const,paymentReference:'BANK-ONE',idempotencyKey:`payment:${crypto.randomUUID()}`,metadata:{bankStatement:'pending'}};
    const first=await documents.recordInvoicePayment(workspace,invoice.id,owner,firstInput);assert.equal(first.invoice?.invoice.status,'PARTIALLY_PAID');assert.equal(first.invoice?.invoice.amountDue,'60.0000');
    const retry=await documents.recordInvoicePayment(workspace,invoice.id,owner,firstInput);assert.equal(retry.payment.id,first.payment.id);assert.equal(retry.idempotent,true);
    await assert.rejects(()=>documents.recordInvoicePayment(workspace,invoice.id,owner,{...firstInput,amount:'41.00'}),/idempotency key was already used/i);
    await assert.rejects(()=>documents.recordInvoicePayment(workspace,invoice.id,owner,{...firstInput,idempotencyKey:`payment:${crypto.randomUUID()}`,amount:'61.00'}),/exceeds the invoice amount due/i);
    const partialEvent={...issuedEvent,id:crypto.randomUUID(),sequence:'2',type:DOMAIN_EVENT_TYPES.INVOICE_PARTIALLY_PAID,payload:{invoiceId:invoice.id,paymentId:first.payment.id}};
    await projection.projectInvoiceJournalEvent(partialEvent);

    const second=await documents.recordInvoicePayment(workspace,invoice.id,owner,{amount:'60',paymentMethod:'WECHAT_PAY',idempotencyKey:`payment:${crypto.randomUUID()}`});assert.equal(second.invoice?.invoice.status,'PAID');assert.equal(second.invoice?.invoice.amountDue,'0.0000');
    const paidEvent={...issuedEvent,id:crypto.randomUUID(),sequence:'3',type:DOMAIN_EVENT_TYPES.INVOICE_PAID,payload:{invoiceId:invoice.id,paymentId:second.payment.id}};
    await projection.projectInvoiceJournalEvent(paidEvent);
    const ar=await journalRepo.getAccountBalance(workspace,'ACCOUNTS_RECEIVABLE','CNY');assert.equal(ar.balanceMinor,'0');assert.equal(ar.balanceDirection,'BALANCED');
    const clearing=await journalRepo.getAccountBalance(workspace,'PAYMENT_CLEARING','CNY');assert.equal(clearing.debitsMinor,'10000');
    const trial=await journalRepo.getTrialBalance(workspace,'CNY');assert.equal(trial.balanced,true);assert.equal(trial.totals.debitsMinor,'21250');assert.equal(trial.totals.creditsMinor,'21250');
    await assert.rejects(()=>db.query(`UPDATE invoice_payments SET amount_minor=1 WHERE id=$1`,[first.payment.id]),/append-only/i);
  });

  it('does not recognize proforma invoices as receivables',async()=>{
    const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(workspace_id,invoice_number,invoice_type,status,currency,grand_total,amount_due,issued_at,created_by) VALUES($1,$2,'PROFORMA','ISSUED','CNY',25,25,NOW(),$3) RETURNING id`,[workspace,`PROFORMA-${crypto.randomUUID()}`,owner])).rows[0]!;
    await assert.rejects(()=>documents.recordInvoicePayment(workspace,invoice.id,owner,{amount:'25',paymentMethod:'OTHER',idempotencyKey:`payment:${crypto.randomUUID()}`}),/proforma invoice/i);
  });
});
