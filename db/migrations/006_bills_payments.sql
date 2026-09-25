CREATE TABLE bills (
  id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL,
  payee           text NOT NULL,
  amount_cents    int NOT NULL CHECK (amount_cents > 0),
  tolerance_pct   int NOT NULL DEFAULT 0 CHECK (tolerance_pct BETWEEN 0 AND 100),
  due_day         int NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  method          text NOT NULL CHECK (method IN ('pix', 'boleto', 'card', 'transfer')),
  folder_id       text,
  active          boolean NOT NULL DEFAULT true,
  starts_on       date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bill_occurrences (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_id          int NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  due_date         date NOT NULL,
  expected_cents   int NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'skipped')),
  receipt_file_id  text,
  match_score      real,
  match_kind       text CHECK (match_kind IN ('auto', 'manual')),
  matched_at       timestamptz,
  UNIQUE (bill_id, due_date)
);
CREATE INDEX bill_occurrences_open_idx ON bill_occurrences (due_date) WHERE status = 'open';

CREATE TABLE payments (
  id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key     text NOT NULL UNIQUE,
  method              text NOT NULL CHECK (method IN ('pix', 'transfer', 'boleto')),
  payee               text NOT NULL,
  amount_cents        int NOT NULL CHECK (amount_cents > 0),
  details             jsonb NOT NULL DEFAULT '{}',
  bill_occurrence_id  int REFERENCES bill_occurrences(id) ON DELETE SET NULL,
  status              text NOT NULL CHECK (status IN ('submitted', 'processing', 'paid', 'failed')),
  provider_ref        text,
  receipt_file_id     text,
  receipt_name        text,
  error               text,
  trace_id            text,
  created_by          int REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  settled_at          timestamptz
);
