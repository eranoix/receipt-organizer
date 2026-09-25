-- The mirror of the cloud drive. The drive is the source of truth; this is a
-- copy we can query, join and page through without calling the provider.

CREATE TABLE drive_items (
  id                  text PRIMARY KEY,           -- the drive's own item id
  parent_id           text,                       -- null only for the root
  name                text NOT NULL,
  is_folder           boolean NOT NULL,
  size                integer NOT NULL DEFAULT 0,
  mime                text,
  etag                text,
  sha256              text,
  path                text NOT NULL DEFAULT '/',
  remote_modified_at  timestamptz,
  deleted_at          timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drive_items_parent_idx ON drive_items (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX drive_items_sha_idx ON drive_items (sha256) WHERE deleted_at IS NULL AND NOT is_folder;
CREATE INDEX drive_items_path_idx ON drive_items (path text_pattern_ops);

-- More than one inbox is allowed: a scanner folder, a phone folder, and so on.
CREATE TABLE inbox_folders (
  folder_id   text PRIMARY KEY,
  label       text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per sync stream. The lock columns implement a lease: a holder that
-- stops heartbeating loses the lock after a timeout instead of wedging sync
-- forever.
CREATE TABLE sync_state (
  name                     text PRIMARY KEY,
  cursor                   text,
  last_delta_at            timestamptz,
  last_full_at             timestamptz,
  full_requested_at        timestamptz,
  lock_owner               text,
  lock_heartbeat_at        timestamptz,
  subscription_expires_at  timestamptz,
  last_error               text,
  last_error_at            timestamptz
);
