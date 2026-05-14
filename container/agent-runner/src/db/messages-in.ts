import { getSessionDb } from './connection.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/** Fetch all pending messages that are due for processing. */
export function getPendingMessages(): MessageInRow[] {
  return getSessionDb()
    .prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR process_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageInRow[];
}

/** Mark messages as processing. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getSessionDb();
  const stmt = db.prepare("UPDATE messages_in SET status = 'processing', status_changed = datetime('now'), tries = tries + 1 WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getSessionDb();
  const stmt = db.prepare("UPDATE messages_in SET status = 'completed', status_changed = datetime('now') WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Update status_changed on processing messages (heartbeat for host idle detection). */
export function touchProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getSessionDb();
  const stmt = db.prepare("UPDATE messages_in SET status_changed = datetime('now') WHERE id = ? AND status = 'processing'");
  for (const id of ids) stmt.run(id);
}

/** Mark a single message as failed. */
export function markFailed(id: string): void {
  getSessionDb().prepare("UPDATE messages_in SET status = 'failed', status_changed = datetime('now') WHERE id = ?").run(id);
}

/** Get a message by ID. */
export function getMessageIn(id: string): MessageInRow | undefined {
  return getSessionDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
}

/** Find a pending response to a question (by questionId in content). */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  return getSessionDb()
    .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;
}
