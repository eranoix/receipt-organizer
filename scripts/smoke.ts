const BASE = process.env.BASE_URL ?? 'http://localhost:5610';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'receipts-demo';
let failures = 0;

function ok(cond: unknown, what: string, extra?: unknown) {
  if (cond) console.log(`ok   - ${what}`);
  else {
    failures += 1;
    console.log(`FAIL - ${what}`, extra ?? '');
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

function client(cookie: string) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T; res: Response }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') ?? '';
    const json = (ct.includes('json') ? await res.json() : {}) as T;
    return { status: res.status, json, res };
  };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 45_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 750));
  }
  ok(false, `timed out waiting for: ${what}`);
  return null;
}

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  ok(health.ok, 'health endpoint answers');

  const page = await fetch(`${BASE}/login`);
  ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"), 'CSP header present');
  ok(page.headers.get('x-content-type-options') === 'nosniff', 'nosniff header present');
  ok(page.headers.get('x-frame-options') === 'SAMEORIGIN', 'frame header present');

  const anon = await fetch(`${BASE}/api/files`);
  ok(anon.status === 401, 'API refuses anonymous requests', anon.status);

  const lia = client(await login('lia@example.com'));

  const review = await lia<{ rows: { file_id: string; name: string; stage: string; suggestion_folder_id: string; suggestion_path: string }[] }>('GET', '/api/review?stage=suggested');
  const pick = review.json.rows.find((r) => r.stage === 'suggested');
  ok(pick, 'review queue has a suggested receipt', review.json);
  if (pick) {
    const trace = `tr-smoke-${Date.now()}`;
    const conf = await lia<{ queued: unknown[] }>('POST', '/api/review/confirm', { items: [{ fileId: pick.file_id }] }, { 'x-trace-id': trace });
    ok(conf.status === 200 && conf.json.queued.length === 1, `confirm queued a move of ${pick.name} to ${pick.suggestion_path}`, conf.json);
    const filed = await until('receipt filed', async () => {
      const d = await lia<{ receipt: { stage: string; parent_id: string } }>('GET', `/api/receipts/${pick.file_id}`);
      return d.json.receipt?.stage === 'filed' && d.json.receipt.parent_id === pick.suggestion_folder_id;
    });
    ok(filed, 'receipt is now filed in the suggested folder');
    const logs = await lia<{ rows: { source: string; action: string }[] }>('GET', `/api/ops/logs?trace=${trace}&state=all`);
    ok(logs.json.rows.some((r) => r.source === 'audit' && r.action === 'receipt.confirmed') && logs.json.rows.some((r) => r.source === 'queue'),
      'operations center correlates the audit entry and the queue operation by trace', logs.json.rows.map((r) => r.action));
  }

  const dups = await lia<{ rows: { status: string }[] }>('GET', '/api/duplicates');
  ok(dups.json.rows.some((r) => r.status === 'suspected' || r.status === 'proven'), 'duplicates are waiting for a decision');
  const dlq = await lia<{ total: number }>('GET', '/api/ops/logs?state=open&source=queue');
  ok(dlq.json.total > 0, `dead-letter queue has ${dlq.json.total} item(s)`);

  const tree = await lia<{ folders: { id: string; path: string }[] }>('GET', '/api/files/tree');
  const util = tree.json.folders.find((f) => f.path === '/Utilities/Electricity');
  const zip = await lia('POST', '/api/files/zip', { ids: [util?.id] });
  const bytes = Buffer.from(await zip.res.arrayBuffer());
  ok(zip.status === 200 && bytes.subarray(0, 2).toString() === 'PK', `ZIP download works (${zip.res.headers.get('x-file-count')} files)`);

  const status = await lia<{ level: string; headline: string; checks: unknown[] }>('GET', '/api/status');
  ok(['operational', 'degraded', 'outage'].includes(status.json.level) && status.json.checks.length > 5, `status verdict: ${status.json.level}`);
  const hb = await until('worker heartbeat', async () => {
    const s = await lia<{ checks: { id: string; status: string }[] }>('GET', '/api/status');
    return s.json.checks.find((c) => c.id === 'worker' && c.status === 'ok');
  }, 20_000);
  ok(hb, 'worker is alive');

  const tom = client(await login('tom@example.com'));
  const elec = await lia<{ items: { id: string; isFolder: boolean }[] }>('GET', `/api/files?folder=${util?.id}`);
  const secret = elec.json.items.find((i) => !i.isFolder);
  const denied = await tom('GET', `/api/files/${secret?.id}/content`);
  ok(denied.status === 404, 'member gets 404 for a file outside their scope', denied.status);
  const ines = client(await login('ines@example.com'));
  const viewerWrite = await ines('POST', '/api/review/confirm', { items: [{ fileId: 'x' }] });
  ok(viewerWrite.status === 403, 'viewer cannot file receipts', viewerWrite.status);

  const pay = await lia<{ openBills: { id: number; name: string; payee: string; expected_cents: number }[] }>('GET', '/api/payments');
  const bill = pay.json.openBills[0];
  ok(bill, 'there is an open bill to pay');
  if (bill) {
    const key = `smoke-${Date.now()}`;
    const body = { method: 'pix', payee: bill.payee, amountCents: bill.expected_cents, pixKey: 'billing@payee.example.com', billOccurrenceId: bill.id, idempotencyKey: key };
    const created = await lia<{ id: number }>('POST', '/api/payments', body);
    const again = await lia<{ id: number; duplicate: boolean }>('POST', '/api/payments', body);
    ok(created.status === 200 && again.json.duplicate && again.json.id === created.json.id, 'same payment request twice pays once');
    const settled = await until('payment receipt read and bill paid', async () => {
      const b = await lia<{ occurrences: { id: number; status: string; receipt_file_id: string | null }[] }>('GET', '/api/bills');
      return b.json.occurrences.find((o) => o.id === bill.id && o.status === 'paid' && o.receipt_file_id);
    }, 60_000);
    ok(settled, `${bill.name} is marked paid by the receipt the provider returned`);
  }

  let limited = false;
  for (let i = 0; i < 12 && !limited; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lia@example.com', password: 'wrong' }) });
    limited = r.status === 429;
  }
  ok(limited, 'login is rate limited');

  console.log(failures ? `\n${failures} check(s) failed` : '\nsmoke passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
