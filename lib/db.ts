// Neon: EV run registry + per-item audit log. Tables are created on first use.
import { neon } from "@neondatabase/serverless";
import { config } from "./config";

let _sql: ReturnType<typeof neon> | null = null;
let ready: Promise<void> | null = null;

function sql() {
  if (!_sql) _sql = neon(config.databaseUrl());
  return _sql;
}

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  return (await sql().query(text, params)) as T[];
}

async function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const s = sql();
      await s.query(`
        CREATE TABLE IF NOT EXISTS ev_runs (
          id              text PRIMARY KEY,
          status          text NOT NULL,
          action          text NOT NULL,          -- set | undo
          target_ev       numeric,
          filters         jsonb NOT NULL,
          post_filters    jsonb NOT NULL,
          queries         jsonb,
          requested_by    text NOT NULL,
          preview         jsonb,
          preview_count   int NOT NULL,
          staged_by       text,
          staged_at       timestamptz,
          staged_count    int,
          approved_by     text,
          live_at         timestamptz,
          finished_at     timestamptz,
          dry_run         boolean,
          result          jsonb,
          undo_of         text,
          note            text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          expires_at      timestamptz NOT NULL
        )`);
      await s.query(`
        CREATE TABLE IF NOT EXISTS ev_run_items (
          run_id        text NOT NULL REFERENCES ev_runs(id),
          item_id       text NOT NULL,
          warehouse_ev  numeric,
          previous_ev   numeric,
          prev_source   text,                   -- admin (read live) | warehouse
          new_ev        numeric,
          label         text,
          status        text NOT NULL DEFAULT 'pending',
          http_status   int,
          returned_ev   numeric,
          error         text,
          updated_at    timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, item_id)
        )`);
      await s.query(`ALTER TABLE ev_runs ADD COLUMN IF NOT EXISTS last_comp numeric`);
      await s.query(`ALTER TABLE ev_runs ADD COLUMN IF NOT EXISTS comp_url text`);
      await s.query(`ALTER TABLE ev_run_items ADD COLUMN IF NOT EXISTS prev_fields jsonb`);
      await s.query(`ALTER TABLE ev_run_items ADD COLUMN IF NOT EXISTS estimate_id text`);
      for (const col of ["img text", "last_comp numeric", "comp_url text", "note text", "source_run text", "submitted_by text", "submitted_at timestamptz", "approved_by text", "approved_at timestamptz", "submit_record jsonb"]) {
        await s.query(`ALTER TABLE ev_run_items ADD COLUMN IF NOT EXISTS ${col}`);
      }
      await s.query(`CREATE INDEX IF NOT EXISTS ev_run_items_status ON ev_run_items (status, item_id)`);
      await s.query(`ALTER TABLE ev_run_items ADD COLUMN IF NOT EXISTS approve_http int`);
      await s.query(`ALTER TABLE ev_run_items ADD COLUMN IF NOT EXISTS approve_error text`);
      await s.query(`
        CREATE TABLE IF NOT EXISTS ev_users (
          id                text PRIMARY KEY,
          email             text NOT NULL UNIQUE,
          name              text NOT NULL,
          role              text NOT NULL,      -- viewer | editor | approver | admin
          admin_user_id     text,               -- their own Arena admin account (SuperTokens user id)
          pw_hash           text,
          invite_hash       text,
          invite_expires_at timestamptz,
          mcp_key_hash      text,
          active            boolean NOT NULL DEFAULT true,
          created_by        text,
          created_at        timestamptz NOT NULL DEFAULT now(),
          last_login_at     timestamptz
        )`);
      await s.query(`ALTER TABLE ev_runs ADD COLUMN IF NOT EXISTS requested_by_id text`);
      await s.query(`ALTER TABLE ev_runs ADD COLUMN IF NOT EXISTS admin_as text`);
      await s.query(`ALTER TABLE ev_runs ADD COLUMN IF NOT EXISTS approved_in_bot boolean`);
      await s.query(`
        CREATE TABLE IF NOT EXISTS ev_saved_prompts (
          id          text PRIMARY KEY,
          name        text NOT NULL,
          text        text NOT NULL,
          created_by  text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
