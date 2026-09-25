/**
 * Seed the demo: an invented bakery's drive, users, bills and a month of
 * history, produced by running the REAL pipeline (sync, intake, duplicate
 * gate, reading, suggestions, queue, payments) rather than inserting
 * finished rows. What you see on first start is what the code does.
 *
 *   --if-empty  do nothing when users already exist (used by docker compose)
 *   --reset     drop everything, including the local drive, and start over
 */
import { rm } from 'node:fs/promises';
import { closePool, pool, q, q1 } from '../src/lib/db';
import { driveRoot, setDrive } from '../src/lib/drive';
import { LocalDrive } from '../src/lib/drive/local-drive';
import { setExtractor } from '../src/lib/extract';
import { MockExtractor } from '../src/lib/extract/mock';
import { BILLS, buildFixtureSet, FOLDER_RULES, FOLDERS, INBOXES, LEFT_UNPAID } from '../src/lib/fixtures';
import { hashPassword, loadUser } from '../src/lib/server/auth';
import { ensureOccurrences } from '../src/lib/server/bills';
import { logEvent, notify } from '../src/lib/server/events';
import { createDedupDeleteJob, createReprocessJob, verifyCandidate } from '../src/lib/server/jobs';
import { createPayment } from '../src/lib/server/payments';
import { enqueue } from '../src/lib/server/queue';
import { confirmFiling, updateFields } from '../src/lib/server/receipts';
import { deltaSync, ensureSyncState } from '../src/lib/server/sync';
import { createWorker, selfHeal, tick, type WorkerCtx } from '../src/lib/server/worker';
import { MockPaymentProvider } from '../src/lib/payments/provider';
import { newTraceId } from '../src/lib/ids';
import { migrate } from './migrate';

export const DEMO_PASSWORD = 'receipts-demo';

const log = (...a: unknown[]) => console.log('[seed]', ...a);

async function settle(ctx: WorkerCtx, what: string, done: () => Promise<boolean>, maxMs = 30_000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await tick(ctx);
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  log(`warning: "${what}" did not settle within ${maxMs} ms`);
}

const idle = async () => {
  const r = await q1<{ ops: number; ocr: number; jobs: number; pay: number; untaken: number }>(
    `SELECT (SELECT count(*) FROM operations WHERE status IN ('pending', 'running')) AS ops,
            (SELECT count(*) FROM receipts WHERE ocr_state IN ('queued', 'running')) AS ocr,
            (SELECT count(*) FROM jobs WHERE status IN ('queued', 'running')) AS jobs,
            (SELECT count(*) FROM payments WHERE status IN ('submitted', 'processing') OR (status = 'paid' AND receipt_file_id IS NULL)) AS pay,
            (SELECT count(*) FROM drive_items d JOIN inbox_folders ib ON ib.folder_id = d.parent_id LEFT JOIN receipts r ON r.file_id = d.id
              WHERE r.file_id IS NULL AND NOT d.is_folder AND d.deleted_at IS NULL) AS untaken`);
  return r!.ops + r!.ocr + r!.jobs + r!.pay + r!.untaken === 0;
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--reset')) {
    log('reset: dropping schema and drive');
    await pool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await rm(driveRoot(), { recursive: true, force: true });
  }
  await migrate();
  const existing = await q1<{ n: number }>('SELECT count(*) AS n FROM users');
  if (existing!.n > 0) {
    if (args.includes('--if-empty')) { log('already seeded, nothing to do'); return; }
    throw new Error('database already has users; run with --reset to start over');
  }

  process.env.PAYMENT_SETTLE_MS ??= '400';
  const today = new Date().toISOString().slice(0, 10);
  const fx = buildFixtureSet(today);
  log(`building drive at ${driveRoot()} with ${fx.files.length} receipts`);

  // 1. The drive as it was before the app existed. Written straight to the
  //    drive, the way a scanner or phone app would, not through the queue.
  const drive = new LocalDrive(driveRoot());
  setDrive(drive);
  setExtractor(new MockExtractor({ rateLimitEvery: 11, retryAfterMs: 300 }));
  const g = globalThis as unknown as { __roPayments?: unknown };
  g.__roPayments = new MockPaymentProvider(400);

  const ids = new Map<string, string>();
  ids.set('', await drive.rootId());
  for (const f of FOLDERS) {
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const item = await drive.createFolder(ids.get(parent)!, f.split('/').pop()!);
    ids.set(f, item.id);
  }
  // Filed receipts first, so they are "older" than anything in the inboxes.
  const ordered = [...fx.files.filter((f) => f.role === 'filed'), ...fx.files.filter((f) => f.role !== 'filed' && f.role !== 'duplicate'), ...fx.files.filter((f) => f.role === 'duplicate')];
  for (const f of ordered) {
    const folder = f.path.slice(0, f.path.lastIndexOf('/'));
    const item = await drive.upload(ids.get(folder)!, f.path.split('/').pop()!, f.bytes);
    ids.set(f.path, item.id);
  }

  // 2. People, configuration and bills.
  await ensureSyncState();
  await q(`UPDATE sync_state SET subscription_expires_at = now() + interval '2 days' WHERE name = 'drive'`);
  const hash = await hashPassword(DEMO_PASSWORD);
  const users = await q<{ id: number; email: string }>(
    `INSERT INTO users (email, name, role, password_hash, avatar_color, status_text) VALUES
       ('lia@example.com', 'Lia Moreno', 'admin', $1, '#0f766e', 'Owner. Files receipts on Monday mornings.'),
       ('tom@example.com', 'Tom Reyes', 'member', $1, '#b45309', 'Head baker. Buys flour and dairy.'),
       ('ines@example.com', 'Ines Park', 'viewer', $1, '#7c3aed', 'Bookkeeper (read-only).')
     RETURNING id, email`, [hash]);
  const lia = users.find((u) => u.email.startsWith('lia'))!.id;
  const tom = users.find((u) => u.email.startsWith('tom'))!.id;
  const ines = users.find((u) => u.email.startsWith('ines'))!.id;

  const ctx = createWorker({ backoffBaseMs: 40 });
  await selfHeal(ctx);
  await deltaSync(ctx.id); // mirror the drive, including folder ids

  for (const ib of INBOXES) await q('INSERT INTO inbox_folders (folder_id, label, is_primary) VALUES ($1, $2, $3)', [ids.get(ib.path), ib.label, ib.primary]);
  for (const r of FOLDER_RULES) await q('INSERT INTO folder_rules (pattern, folder_id, created_by) VALUES ($1, $2, $3)', [r.pattern, ids.get(r.path), lia]);
  for (const p of ['Inbox', 'Phone scans', 'Suppliers']) await q('INSERT INTO user_folder_scopes (user_id, folder_id) VALUES ($1, $2)', [tom, ids.get(p)]);
  for (const p of ['Utilities', 'Rent', 'Taxes']) await q('INSERT INTO user_folder_scopes (user_id, folder_id) VALUES ($1, $2)', [ines, ids.get(p)]);
  const startsOn = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 4, 1)).toISOString().slice(0, 10);
  for (const b of BILLS) {
    await q(`INSERT INTO bills (name, payee, amount_cents, tolerance_pct, due_day, method, folder_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [b.name, b.payee, b.amountCents, b.tolerancePct, b.dueDay, b.method, ids.get(b.folder), startsOn]);
  }
  await ensureOccurrences(today);

  // 3. Run the pipeline until everything has been hashed, gated and read.
  await settle(ctx, 'initial intake', async () => {
    const r = await q1<{ n: number }>(`SELECT count(*) AS n FROM drive_items d LEFT JOIN receipts r ON r.file_id = d.id
                                        WHERE NOT d.is_folder AND d.deleted_at IS NULL AND (d.sha256 IS NULL OR r.file_id IS NULL OR r.ocr_state IN ('queued', 'running'))`);
    // Filed receipts are read too ("backfill"), so the classifier has history.
    await q(`INSERT INTO receipts (file_id, ocr_state) SELECT d.id, 'queued' FROM drive_items d
              LEFT JOIN receipts r ON r.file_id = d.id LEFT JOIN inbox_folders ib ON ib.folder_id = d.parent_id
             WHERE NOT d.is_folder AND d.deleted_at IS NULL AND r.file_id IS NULL AND ib.folder_id IS NULL`);
    return r!.n === 0;
  }, 60_000);
  log('intake done');

  const U = async (id: number) => (await loadUser(id))!;
  const byName = async (name: string, folder = 'Inbox') => (await q1<{ id: string }>(`SELECT d.id FROM drive_items d WHERE d.name = $1 AND d.parent_id = $2 AND d.deleted_at IS NULL`, [name, ids.get(folder)]))!.id;
  const fileIn = (role: string) => fx.files.find((f) => f.role === role)!;

  // 4. Duplicates: prove one, delete another through an observable job.
  const cands = await q<{ id: number; name: string }>(`SELECT dc.id, d.name FROM duplicate_candidates dc JOIN drive_items d ON d.id = dc.file_id ORDER BY dc.id`);
  const boxCopy = cands.find((c) => c.name === 'boxwell-order-copy.pdf');
  const firstOther = cands.find((c) => c !== boxCopy);
  if (firstOther) await verifyCandidate(firstOther.id, lia, newTraceId());
  if (boxCopy) {
    await createDedupDeleteJob([boxCopy.id], await U(lia), newTraceId());
    await settle(ctx, 'dedup delete job', idle);
  }
  log(`duplicates: ${cands.length} found`);

  // 5. Filing: one confirmation that needs retries (the drive throttles twice).
  const goldenInbox = await q1<{ file_id: string }>(`SELECT file_id FROM receipt_view WHERE in_inbox AND payee = 'Golden Mill Flour' AND stage = 'suggested' ORDER BY name LIMIT 1`);
  if (goldenInbox) {
    drive.faults.set('move', { remaining: 2, code: 'throttled' });
    await confirmFiling([{ fileId: goldenInbox.file_id }], await U(tom), newTraceId());
    await settle(ctx, 'throttled filing', idle);
    drive.faults.delete('move');
  }
  // Two quick confirmations that go through first time.
  const two = await q<{ file_id: string }>(`SELECT file_id FROM receipt_view WHERE in_inbox AND stage = 'suggested' AND payee IN ('Riverton City Tax Office', 'Maple Street Properties') LIMIT 2`);
  if (two.length) {
    await confirmFiling(two.map((t) => ({ fileId: t.file_id })), await U(lia), newTraceId());
    await settle(ctx, 'confirmations', idle);
  }

  // 6. Dead letters, each a different kind of failure.
  const collision = fileIn('collision');
  const collisionId = await byName(collision.path.split('/').pop()!);
  await confirmFiling([{ fileId: collisionId, folderId: ids.get('Suppliers/Dairy') }], await U(tom), newTraceId());
  await settle(ctx, 'collision', idle);

  const oldFiled = await q1<{ id: string; name: string; parent_id: string }>(`SELECT id, name, parent_id FROM drive_items WHERE parent_id = $1 AND NOT is_folder ORDER BY name LIMIT 1`, [ids.get('Equipment')]);
  if (oldFiled) {
    drive.faults.set('move', { remaining: 3, code: 'serviceUnavailable' });
    await enqueue({ kind: 'drive.move', idempotencyKey: `rename:${oldFiled.id}:seed`, maxAttempts: 3, traceId: newTraceId(), createdBy: lia, subjectId: oldFiled.id,
      payload: { itemId: oldFiled.id, targetParentId: oldFiled.parent_id, name: `oven-parts-${today.slice(0, 7)}.pdf`, intent: 'rename', snapshot: { name: oldFiled.name, isFolder: false, size: 0 } } });
    await settle(ctx, 'exhausted rename', idle);
    drive.faults.delete('move');
  }
  const archiveMe = await q1<{ id: string; name: string }>(`SELECT id, name FROM drive_items WHERE parent_id = $1 AND NOT is_folder LIMIT 1`, [ids.get('Suppliers/Packaging')]);
  if (archiveMe) {
    await enqueue({ kind: 'drive.move', idempotencyKey: `move:${archiveMe.id}:seed-deadline`, deadlineMs: 1, traceId: newTraceId(), createdBy: lia, subjectId: archiveMe.id,
      payload: { itemId: archiveMe.id, targetParentId: ids.get('Archive'), name: archiveMe.name, intent: 'move', snapshot: { name: archiveMe.name, isFolder: false, size: 0 } } });
    await new Promise((r) => setTimeout(r, 20));
    await settle(ctx, 'deadline', idle);
  }
  await enqueue({ kind: 'drive.delete', idempotencyKey: 'delete:loc_000000000000', traceId: newTraceId(), createdBy: lia, payload: { itemId: 'loc_000000000000', name: 'old-scan.pdf', intent: 'delete' } });

  // 7. Reading: a person fixes a torn receipt, and an old misreading gets a re-read proposal.
  const tornId = await byName(fileIn('torn').path.split('/').pop()!);
  await updateFields(tornId, { payee: 'Harbor Dairy Co-op' }, await U(tom), newTraceId());
  const mangledId = await byName(fileIn('mangled').path.split('/').pop()!);
  await q(`UPDATE receipts SET payee = 'Boxwel Packagng', amount_cents = amount_cents + 900, confidence = 0.62 WHERE file_id = $1`, [mangledId]);
  await q(`UPDATE receipts SET reprocess = true, ocr_state = 'queued' WHERE file_id = $1`, [mangledId]);
  const filedSample = await q<{ file_id: string }>(`SELECT file_id FROM receipt_view WHERE stage = 'filed' AND path LIKE '/Utilities/%' ORDER BY name LIMIT 6`);
  await createReprocessJob(filedSample.map((f) => f.file_id), await U(lia), newTraceId());
  await settle(ctx, 'reading', idle);

  // 8. Payments: one that settles and returns a receipt, one the provider declines.
  const internet = await q1<{ id: number; expected_cents: number }>(
    `SELECT o.id, o.expected_cents FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id WHERE b.name = 'Internet' AND o.due_date = $1`, [fx.paymentsCenterDue]);
  if (internet) {
    await createPayment({ method: 'pix', payee: 'Northwind Fiber', amountCents: internet.expected_cents, pixKey: 'billing@northwind-fiber.example.com', billOccurrenceId: internet.id, idempotencyKey: 'seed-payment-internet' }, await U(lia), newTraceId());
  }
  await createPayment({ method: 'transfer', payee: 'DECLINE Test Supplier', amountCents: 12_345, bankCode: '999', branch: '0000', account: '12345-6', idempotencyKey: 'seed-payment-declined' }, await U(lia), newTraceId());
  await settle(ctx, 'payments', idle, 30_000);

  // 9. A few human touches for the activity feed.
  await q(`UPDATE users SET last_login_at = now() - interval '2 days 3 hours' WHERE id = $1`, [tom]);
  await q(`UPDATE users SET last_login_at = now() - interval '6 days' WHERE id = $1`, [ines]);
  await logEvent({ source: 'audit', action: 'auth.login', message: 'Lia Moreno signed in', actorId: lia });
  await logEvent({ source: 'audit', action: 'auth.login', message: 'Tom Reyes signed in', actorId: tom });
  await notify({ roles: ['admin', 'member', 'viewer'], kind: 'welcome', title: 'Welcome to the demo workspace', body: `Everything here is invented. ${BILLS.find((b) => b.key === LEFT_UNPAID)?.name} is left unpaid on purpose.`, link: '/' });
  await q(`INSERT INTO settings (key, value, updated_by) VALUES ('dedup.enabled', 'true', $1) ON CONFLICT DO NOTHING`, [lia]);

  const s = await q1<Record<string, number>>(
    `SELECT (SELECT count(*) FROM drive_items WHERE NOT is_folder AND deleted_at IS NULL) AS files,
            (SELECT count(*) FROM receipt_view WHERE in_inbox AND stage IN ('suggested', 'needs_decision', 'unreadable')) AS waiting,
            (SELECT count(*) FROM duplicate_candidates) AS duplicates,
            (SELECT count(*) FROM operations WHERE status = 'dead') AS dead,
            (SELECT count(*) FROM bill_occurrences WHERE status = 'paid') AS bills_paid,
            (SELECT count(*) FROM payments) AS payments`);
  log('done:', JSON.stringify(s));
  log(`sign in as lia@example.com / tom@example.com / ines@example.com with password "${DEMO_PASSWORD}"`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
