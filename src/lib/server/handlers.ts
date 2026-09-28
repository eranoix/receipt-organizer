import { q, q1 } from '../db';
import { drive } from '../drive';
import type { OperationQueue, QueueHooks } from '../queue/engine';
import { PermanentError } from '../queue/errors';
import type { Operation } from '../queue/types';
import { paymentProvider } from '../payments/provider';
import { logEvent, notify, resolveDuplicateWarning } from './events';
import { applyItems, markDeleted } from './mirror';
import { queueFor } from './queue';

type P = Record<string, unknown>;
const str = (p: P, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || !v) throw new PermanentError(`payload is missing "${k}"`, 'validationFailed');
  return v;
};

export function registerHandlers(queue: OperationQueue): OperationQueue {
  queue.register('drive.createFolder', {
    breaker: 'drive',
    async run(p, { signal, attempt }) {
      const parentId = str(p, 'parentId');
      const name = str(p, 'name');
      if (attempt > 1) {
        const existing = await drive().childByName(parentId, name, signal);
        if (existing?.isFolder) {
          await applyItems([existing]);
          await afterFolderCreated(p, existing.id);
          return { outcome: 'noop', detail: 'folder already existed' };
        }
      }
      const item = await drive().createFolder(parentId, name, signal);
      await applyItems([item]);
      await afterFolderCreated(p, item.id);
      return { outcome: 'applied' };
    },
    async probe(p, signal) {
      return !!(await drive().childByName(str(p, 'parentId'), str(p, 'name'), signal))?.isFolder;
    },
  });

  queue.register('drive.move', {
    breaker: 'drive',
    async run(p, { signal, attempt }) {
      const id = str(p, 'itemId');
      const target = str(p, 'targetParentId');
      const name = str(p, 'name');
      if (attempt > 1) {
        const cur = await drive().get(id, signal);
        if (cur && cur.parentId === target && cur.name === name) {
          await applyItems([cur]);
          return { outcome: 'noop', detail: 'already in place' };
        }
      }
      const item = await drive().move(id, target, name, signal);
      await applyItems([item]);
      return { outcome: 'applied' };
    },
    async probe(p, signal) {
      const cur = await drive().get(str(p, 'itemId'), signal);
      return !!cur && cur.parentId === p.targetParentId && cur.name === p.name;
    },
  });

  queue.register('drive.delete', {
    breaker: 'drive',
    async run(p, { signal }) {
      const id = str(p, 'itemId');
      if (!(await drive().get(id, signal))) {
        await markDeleted([id]);
        return { outcome: 'noop', detail: 'already gone' };
      }
      await drive().delete(id, signal);
      await markDeleted([id]);
      return { outcome: 'applied' };
    },
    async probe(p, signal) {
      return !(await drive().get(str(p, 'itemId'), signal));
    },
  });

  queue.register('drive.upload', {
    breaker: 'drive',
    async run(p, { signal }) {
      const parentId = str(p, 'parentId');
      const name = str(p, 'name');
      const bytes = Buffer.from(str(p, 'contentB64'), 'base64');
      const existing = await drive().childByName(parentId, name, signal);
      if (existing && existing.size === bytes.length) {
        await applyItems([existing]);
        await afterUpload(p, existing.id);
        return { outcome: 'noop', detail: 'already uploaded' };
      }
      const item = await drive().upload(parentId, name, bytes, signal);
      await applyItems([item]);
      await afterUpload(p, item.id);
      return { outcome: 'applied' };
    },
    async probe(p, signal) {
      return !!(await drive().childByName(str(p, 'parentId'), str(p, 'name'), signal));
    },
  });

  queue.register('drive.subscribe', {
    breaker: 'drive',
    async run(_p, { signal }) {
      const { expiresAt } = await drive().subscribe(signal);
      await q(`UPDATE sync_state SET subscription_expires_at = $1 WHERE name = 'drive'`, [expiresAt]);
      return { outcome: 'applied', detail: `subscription valid until ${expiresAt}` };
    },
  });

  queue.register('payment.send', {
    breaker: 'payments',
    async run(p, { signal }) {
      const pay = await q1<{ id: number; idempotency_key: string; method: 'pix' | 'transfer' | 'boleto'; payee: string; amount_cents: number; details: Record<string, string>; status: string; provider_ref: string | null }>(
        'SELECT * FROM payments WHERE id = $1', [p.paymentId]);
      if (!pay) throw new PermanentError('payment not found', 'itemNotFound');
      if (pay.provider_ref) return { outcome: 'noop', detail: `already sent as ${pay.provider_ref}` };
      const { ref } = await paymentProvider().send({
        idempotencyKey: pay.idempotency_key, method: pay.method, payee: pay.payee, amountCents: pay.amount_cents, details: pay.details,
      }, signal);
      await q(`UPDATE payments SET status = 'processing', provider_ref = $2, sent_at = now() WHERE id = $1`, [pay.id, ref]);
      return { outcome: 'applied', detail: ref };
    },
  });

  return queue;
}

async function afterFolderCreated(p: P, folderId: string) {
  if (p.inboxLabel) {
    await q(`INSERT INTO inbox_folders (folder_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [folderId, p.inboxLabel]);
  }
}

async function afterUpload(p: P, fileId: string) {
  if (!p.paymentId) return;
  await q('UPDATE payments SET receipt_file_id = $2 WHERE id = $1', [p.paymentId, fileId]);
  await q(`UPDATE bill_occurrences o SET status = 'paid', receipt_file_id = $2, match_kind = 'auto', match_score = 1, matched_at = now()
             FROM payments p WHERE p.id = $1 AND o.id = p.bill_occurrence_id AND o.status = 'open'`, [p.paymentId, fileId]);
}

export const hooks: QueueHooks = {
  async onSucceeded(op: Operation) {
    const p = op.payload as P;
    if (op.kind === 'drive.move' && p.intent === 'classify') {
      await q(`UPDATE receipts SET classified_at = now(), classified_by = $2, updated_at = now() WHERE file_id = $1`, [p.itemId, op.createdBy]);
      await logEvent({ source: 'audit', action: 'receipt.filed', message: `Filed ${p.name} in ${p.targetPath ?? 'folder'}`, subjectId: String(p.itemId), actorId: op.createdBy, traceId: op.traceId });
    }
    if (op.kind === 'drive.delete' && p.duplicateId) {
      await q(`UPDATE duplicate_candidates SET status = 'deleted', updated_at = now() WHERE id = $1`, [p.duplicateId]);
      await resolveDuplicateWarning(String(p.itemId));
      if (p.jobId) await q(`UPDATE jobs SET done = done + 1 WHERE id = $1`, [p.jobId]);
      await logEvent({ source: 'dedup', action: 'duplicate.deleted', message: `Deleted duplicate ${p.name} (byte-identical to ${p.originalName})`, subjectId: String(p.itemId), actorId: op.createdBy, traceId: op.traceId, data: { proof: p.proof } });
    }
  },
  async onDead(op: Operation) {
    const p = op.payload as P;
    if (op.kind === 'drive.delete' && p.duplicateId) {
      await q(`UPDATE duplicate_candidates SET status = 'proven', updated_at = now() WHERE id = $1`, [p.duplicateId]);
      if (p.jobId) await q(`UPDATE jobs SET failed = failed + 1 WHERE id = $1`, [p.jobId]);
    }
    if (op.kind === 'payment.send') {
      await q(`UPDATE payments SET status = 'failed', error = $2 WHERE id = $1`, [p.paymentId, op.lastError]);
      await logEvent({ source: 'payment', level: 'error', action: 'payment.failed', message: `Payment to ${p.payee} failed: ${op.lastError}`, traceId: op.traceId, actorId: op.createdBy, handled: true });
    }
    await notify({
      roles: ['admin'], pref: 'notify_dlq', kind: 'dlq',
      title: `An operation needs a decision: ${String(p.intent ?? op.kind)}`,
      body: `${String(p.name ?? p.payee ?? '')} - ${op.lastError ?? 'failed'}`,
      link: `/operations?state=open&trace=${op.traceId ?? ''}`,
    });
  },
};

export function workerQueue(opts: { backoffBaseMs?: number } = {}): OperationQueue {
  return registerHandlers(queueFor(hooks, opts));
}
