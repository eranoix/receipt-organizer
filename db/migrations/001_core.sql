CREATE TABLE users (
  id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  password_hash  text NOT NULL,
  avatar_color   text NOT NULL DEFAULT '#0f766e',
  status_text    text NOT NULL DEFAULT '',
  theme          text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  notify_dlq        boolean NOT NULL DEFAULT true,
  notify_duplicates boolean NOT NULL DEFAULT true,
  notify_bills      boolean NOT NULL DEFAULT true,
  disabled       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE user_folder_scopes (
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id  text NOT NULL,
  PRIMARY KEY (user_id, folder_id)
);

CREATE TABLE notifications (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  int REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE worker_heartbeats (
  name        text PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  beat_at     timestamptz NOT NULL,
  info        jsonb NOT NULL DEFAULT '{}'
);
