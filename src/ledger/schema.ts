import type { Store } from './sqlite';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  pause_revision INTEGER NOT NULL DEFAULT 0,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  discord_blocked_until INTEGER NOT NULL DEFAULT 0,
  next_cleanup_at INTEGER,
  sweep_cursor TEXT
);
CREATE TABLE members (
  user_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  role_revision INTEGER NOT NULL DEFAULT 0,
  desired_role TEXT CHECK (desired_role IN ('present', 'absent')),
  challenge_failures TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  entry_digest TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  block_reason TEXT,
  browser_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_member ON sessions (user_id, created_at);
CREATE INDEX sessions_expiry ON sessions (expires_at);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  browser_digest TEXT NOT NULL UNIQUE,
  state_digest TEXT UNIQUE,
  pkce_verifier TEXT,
  state_expires_at INTEGER,
  authorization_count INTEGER NOT NULL DEFAULT 0,
  oauth_claim_id TEXT,
  oauth_claim_expires_at INTEGER,
  oauth_outcome TEXT,
  identity_confirmed INTEGER NOT NULL DEFAULT 0,
  submission_claim_id TEXT,
  submission_claim_expires_at INTEGER,
  submission_token_digest TEXT,
  submission_idempotency_key TEXT,
  challenge_outcome TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX attempts_session ON attempts (session_id);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  user_id TEXT,
  joined_at INTEGER,
  generation INTEGER,
  role_revision INTEGER,
  actor_id TEXT,
  session_id TEXT,
  event_id TEXT,
  payload TEXT,
  deadline_at INTEGER,
  next_run_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  mutation_state TEXT NOT NULL DEFAULT 'none',
  erase_on_finish INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX jobs_member ON jobs (user_id, kind) WHERE user_id IS NOT NULL;
CREATE INDEX jobs_event ON jobs (event_id) WHERE event_id IS NOT NULL;
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  operation_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  actor_id TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  delivery_state TEXT NOT NULL,
  posted_at INTEGER,
  message_ids TEXT NOT NULL DEFAULT '[]',
  reconcile_cursor TEXT
);
CREATE INDEX audit_expiry ON audit_events (expires_at);
`;

export function ensureSchema(store: Store): void {
  const existing = store.sql
    .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = 'settings'`)
    .toArray();
  if (existing.length > 0) return;
  store.transactionSync(() => {
    store.sql.exec(SCHEMA);
    store.sql.exec('INSERT INTO settings (id, schema_version) VALUES (1, ?)', SCHEMA_VERSION);
  });
}
