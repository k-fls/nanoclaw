import Database from 'better-sqlite3';

const SESSION_DB_PATH = '/workspace/session.db';

let _db: Database.Database | null = null;

export function getSessionDb(): Database.Database {
  if (!_db) {
    _db = new Database(process.env.SESSION_DB_PATH || SESSION_DB_PATH);
    _db.pragma('journal_mode = DELETE');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

/** For tests — opens an in-memory DB with session schema. */
export function initTestSessionDb(): Database.Database {
  _db = new Database(':memory:');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      status_changed TEXT,
      process_after  TEXT,
      recurrence     TEXT,
      tries          INTEGER DEFAULT 0,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      delivered      INTEGER DEFAULT 0,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
  `);
  return _db;
}

export function closeSessionDb(): void {
  _db?.close();
  _db = null;
}
