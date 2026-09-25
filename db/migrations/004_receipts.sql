-- What we read from each receipt, and every reading attempt.

CREATE TABLE receipts (
  file_id                 text PRIMARY KEY REFERENCES drive_items(id) ON DELETE CASCADE,
  ocr_state               text NOT NULL DEFAULT 'queued'
                          CHECK (ocr_state IN ('queued', 'running', 'done', 'failed', 'held_duplicate')),
  ocr_attempts            int NOT NULL DEFAULT 0,
  ocr_next_at             timestamptz,
  ocr_error               text,
  ocr_job_id              int,
  reprocess               boolean NOT NULL DEFAULT false,
  proposal_run_id         int,
  payee                   text,
  payee_tax_id            text,
  amount_cents            int,
  payment_date            date,
  method                  text CHECK (method IN ('pix', 'boleto', 'card', 'transfer', 'cash')),
  reference               text,
  confidence              real,
  edited_fields           text[] NOT NULL DEFAULT '{}',
  suggestion_folder_id    text,
  suggestion_confidence   real,
  suggestion_reasons      jsonb NOT NULL DEFAULT '[]',
  suggestion_alternatives jsonb NOT NULL DEFAULT '[]',
  classified_at           timestamptz,
  classified_by           int REFERENCES users(id) ON DELETE SET NULL,
  trace_id                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_ocr_idx ON receipts (ocr_next_at) WHERE ocr_state = 'queued';
CREATE INDEX receipts_job_idx ON receipts (ocr_job_id);

CREATE TABLE extraction_runs (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id       text NOT NULL,
  provider      text NOT NULL,
  trigger       text NOT NULL CHECK (trigger IN ('intake', 'reprocess', 'bulk', 'backfill')),
  status        text NOT NULL CHECK (status IN ('ok', 'failed', 'rate_limited', 'proposed', 'accepted', 'rejected')),
  fields        jsonb,
  raw_text      text,
  confidence    real,
  error         text,
  duration_ms   int NOT NULL DEFAULT 0,
  trace_id      text,
  handled_at    timestamptz,
  decided_by    int REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extraction_runs_file_idx ON extraction_runs (file_id, id DESC);

-- Hand-written hints for the classifier ("anything mentioning 'fiber' goes to
-- Internet"). History of confirmed filings carries more weight than these.
CREATE TABLE folder_rules (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pattern     text NOT NULL,
  folder_id   text NOT NULL,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
