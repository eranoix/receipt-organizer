CREATE TABLE operations (
  id                int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind              text NOT NULL,
  idempotency_key   text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'dead', 'discarded')),
  attempts          int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 6,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  deadline_at       timestamptz,
  lease_expires_at  timestamptz,
  last_error        text,
  last_error_code   text,
  dead_reason       text CHECK (dead_reason IN ('permanent', 'exhausted', 'deadline')),
  outcome           text CHECK (outcome IN ('applied', 'noop', 'converged')),
  trace_id          text,
  subject_id        text,
  created_by        int REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (kind, idempotency_key)
);
CREATE INDEX operations_due_idx ON operations (next_attempt_at) WHERE status = 'pending';
CREATE INDEX operations_status_idx ON operations (status);
CREATE INDEX operations_subject_idx ON operations (subject_id) WHERE status IN ('pending', 'running');
CREATE INDEX operations_trace_idx ON operations (trace_id);

CREATE TABLE operation_attempts (
  id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id    int NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  attempt_number  int NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('applied', 'noop', 'retryable', 'permanent')),
  error           text,
  error_code      text,
  breaker         text,
  duration_ms     int NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL
);
CREATE INDEX operation_attempts_op_idx ON operation_attempts (operation_id);
CREATE INDEX operation_attempts_breaker_idx ON operation_attempts (breaker, started_at DESC);

CREATE TABLE breakers (
  name                  text PRIMARY KEY,
  state                 text NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures  int NOT NULL DEFAULT 0,
  opened_at             timestamptz,
  trial_started_at      timestamptz,
  version               int NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
