-- One append-only event log for audit, sync, OCR, duplicates and payments.
CREATE TABLE events (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('audit', 'sync', 'ocr', 'dedup', 'queue', 'payment', 'system')),
  level       text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  action      text NOT NULL,
  message     text NOT NULL,
  subject_id  text,
  actor_id    int REFERENCES users(id) ON DELETE SET NULL,
  trace_id    text,
  data        jsonb NOT NULL DEFAULT '{}',
  handled_at  timestamptz,
  handled_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_created_idx ON events (created_at DESC);
CREATE INDEX events_trace_idx ON events (trace_id);

-- Where a receipt stands, computed in exactly one place. Screens, filters and
-- dashboard cards all read this instead of keeping their own copy of the rule.
CREATE VIEW receipt_view AS
SELECT
  d.id AS file_id, d.name, d.parent_id, d.path, d.size, d.mime, d.sha256, d.first_seen_at,
  (ib.folder_id IS NOT NULL) AS in_inbox,
  r.ocr_state, r.ocr_error, r.payee, r.payee_tax_id, r.amount_cents, r.payment_date, r.method,
  r.reference, r.confidence, r.edited_fields, r.suggestion_folder_id, r.suggestion_confidence,
  r.suggestion_reasons, r.suggestion_alternatives, r.classified_at, r.proposal_run_id, r.trace_id,
  CASE
    WHEN dc.status IN ('suspected', 'proven', 'deleting') THEN 'duplicate'
    WHEN ib.folder_id IS NULL THEN 'filed'
    WHEN r.file_id IS NULL OR r.ocr_state IN ('queued', 'running') THEN 'reading'
    WHEN r.ocr_state = 'failed' THEN 'unreadable'
    WHEN r.suggestion_confidence >= 0.8 THEN 'suggested'
    ELSE 'needs_decision'
  END AS stage
FROM drive_items d
LEFT JOIN inbox_folders ib ON ib.folder_id = d.parent_id
LEFT JOIN receipts r ON r.file_id = d.id
LEFT JOIN duplicate_candidates dc ON dc.file_id = d.id
WHERE d.deleted_at IS NULL AND NOT d.is_folder;

-- The operations center reads one view, so filtering, search and paging all
-- happen in SQL over every source at once.
--   state: 'open'    a problem nobody has dealt with yet
--          'handled' a problem that was resolved (retried, discarded, marked)
--          'info'    not a problem at all
CREATE VIEW ops_log AS
SELECT
  'ev-' || e.id AS uid, e.source, e.level, e.action, e.message, e.subject_id, e.trace_id, e.created_at,
  CASE WHEN e.level = 'info' THEN 'info' WHEN e.handled_at IS NULL THEN 'open' ELSE 'handled' END AS state,
  e.data AS detail, u.name AS actor
FROM events e
LEFT JOIN users u ON u.id = e.actor_id
UNION ALL
SELECT
  'op-' || o.id, 'queue',
  CASE WHEN o.status = 'dead' THEN 'error'
       WHEN o.attempts > 0 AND o.status IN ('pending', 'running') THEN 'warn'
       ELSE 'info' END,
  o.kind,
  CASE WHEN o.status = 'dead' THEN coalesce(o.last_error, 'failed')
       WHEN o.status = 'succeeded' THEN o.kind || ' done (' || o.outcome || ') after ' || o.attempts || ' attempt(s)'
       ELSE o.kind || ' ' || o.status || coalesce(': ' || o.last_error, '') END,
  o.subject_id, o.trace_id, o.created_at,
  CASE WHEN o.status = 'dead' THEN 'open'
       WHEN o.status IN ('pending', 'running') AND o.attempts > 0 THEN 'open'
       WHEN o.status = 'discarded' OR (o.status = 'succeeded' AND o.attempts > 1) THEN 'handled'
       ELSE 'info' END,
  jsonb_build_object('operationId', o.id, 'status', o.status, 'attempts', o.attempts,
                     'maxAttempts', o.max_attempts, 'deadReason', o.dead_reason,
                     'errorCode', o.last_error_code, 'payload', o.payload),
  u.name
FROM operations o
LEFT JOIN users u ON u.id = o.created_by
UNION ALL
SELECT
  'ocr-' || x.id, 'ocr',
  CASE x.status WHEN 'failed' THEN 'error' WHEN 'rate_limited' THEN 'warn' ELSE 'info' END,
  'extract.' || x.status,
  CASE x.status
    WHEN 'failed' THEN coalesce(x.error, 'extraction failed')
    WHEN 'rate_limited' THEN 'Extractor rate limit hit; retry scheduled'
    WHEN 'proposed' THEN 'Reprocess produced a proposal waiting for review'
    ELSE 'Read ' || coalesce(x.fields ->> 'payee', 'unknown payee') || ' (' || x.provider || ')' END,
  x.file_id, x.trace_id, x.created_at,
  CASE WHEN x.status NOT IN ('failed', 'rate_limited') THEN 'info'
       WHEN x.handled_at IS NOT NULL THEN 'handled'
       WHEN EXISTS (SELECT 1 FROM extraction_runs y
                     WHERE y.file_id = x.file_id AND y.id > x.id
                       AND y.status IN ('ok', 'proposed', 'accepted')) THEN 'handled'
       ELSE 'open' END,
  jsonb_build_object('runId', x.id, 'trigger', x.trigger, 'provider', x.provider,
                     'durationMs', x.duration_ms, 'fields', x.fields),
  NULL
FROM extraction_runs x;
