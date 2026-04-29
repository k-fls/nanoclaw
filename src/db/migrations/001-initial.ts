import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial-v2-schema',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_groups (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        folder           TEXT NOT NULL UNIQUE,
        is_admin         INTEGER DEFAULT 0,
        agent_provider   TEXT,
        container_config TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE messaging_groups (
        id               TEXT PRIMARY KEY,
        channel_type     TEXT NOT NULL,
        platform_id      TEXT NOT NULL,
        name             TEXT,
        is_group         INTEGER DEFAULT 0,
        admin_user_id    TEXT,
        created_at       TEXT NOT NULL,
        UNIQUE(channel_type, platform_id)
      );

      CREATE TABLE messaging_group_agents (
        id                 TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        trigger_rules      TEXT,
        response_scope     TEXT DEFAULT 'all',
        session_mode       TEXT DEFAULT 'shared',
        priority           INTEGER DEFAULT 0,
        created_at         TEXT NOT NULL,
        UNIQUE(messaging_group_id, agent_group_id)
      );

      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        messaging_group_id TEXT REFERENCES messaging_groups(id),
        thread_id          TEXT,
        agent_provider     TEXT,
        status             TEXT DEFAULT 'active',
        container_status   TEXT DEFAULT 'stopped',
        last_active        TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
      CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

      CREATE TABLE pending_questions (
        question_id    TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        message_out_id TEXT NOT NULL,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        created_at     TEXT NOT NULL
      );
    `);
  },
};
