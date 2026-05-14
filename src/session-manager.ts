/**
 * Session lifecycle management.
 * Creates session folders + DBs, writes messages, manages container status.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { createSession, findSession, getSession, updateSession } from './db/sessions.js';
import { log } from './log.js';
import { SESSION_SCHEMA } from './db/schema.js';
import type { Session } from './types-v2.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to a session's SQLite DB. */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'session.db');
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create a session for a messaging group + thread.
 * Returns the session and whether it was newly created.
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread',
): { session: Session; created: boolean } {
  // For shared mode, look for any active session with this messaging group (threadId ignored)
  // For per-thread mode, look for an active session with this specific thread
  const lookupThreadId = sessionMode === 'shared' ? null : threadId;
  const existing = findSession(messagingGroupId, lookupThreadId);

  if (existing) {
    return { session: existing, created: false };
  }

  // Create new session
  const id = generateId();
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId });

  return { session, created: true };
}

/** Create the session folder and initialize the session DB. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  const dbPath = sessionDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.exec(SESSION_SCHEMA);
    db.close();
    log.debug('Session DB created', { dbPath });
  }
}

/** Write a message to a session's messages_in table. */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
  },
): void {
  const dbPath = sessionDbPath(agentGroupId, sessionId);
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');

  try {
    const nextSeq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM (
             SELECT seq FROM messages_in WHERE seq IS NOT NULL
             UNION ALL
             SELECT seq FROM messages_out WHERE seq IS NOT NULL
           )`,
        )
        .get() as { next: number }
    ).next;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence)`,
    ).run({
      id: message.id,
      seq: nextSeq,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content: message.content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
    });
  } finally {
    db.close();
  }

  // Update last_active
  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/** Open a session DB for reading (e.g., polling messages_out). */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  const dbPath = sessionDbPath(agentGroupId, sessionId);
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  return db;
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
