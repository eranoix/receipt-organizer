CREATE TABLE jobs (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('dedup_delete', 'bulk_reprocess', 'bulk_remediate')),
  status       text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  total        int NOT NULL DEFAULT 0,
  done         int NOT NULL DEFAULT 0,
  failed       int NOT NULL DEFAULT 0,
  payload      jsonb NOT NULL DEFAULT '{}',
  result       jsonb NOT NULL DEFAULT '{}',
  trace_id     text,
  created_by   int REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE TABLE duplicate_candidates (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id      text NOT NULL UNIQUE,
  original_id  text NOT NULL,
  sha256       text NOT NULL,
  status       text NOT NULL CHECK (status IN ('suspected', 'proven', 'not_identical', 'deleting', 'deleted', 'kept')),
  proof        jsonb,
  proven_at    timestamptz,
  job_id       int REFERENCES jobs(id) ON DELETE SET NULL,
  decided_by   int REFERENCES users(id) ON DELETE SET NULL,
  trace_id     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX duplicate_candidates_status_idx ON duplicate_candidates (status);
