/**
 * Integration tests for the v2 host core.
 * Tests routing, session creation, message writing, and delivery
 * without spawning actual containers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  initSessionFolder,
  sessionDir,
  sessionDbPath,
  sessionsBaseDir,
} from './session-manager.js';
import { getSession, findSession } from './db/sessions.js';
import type { InboundEvent } from './router-v2.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner-v2.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  resetContainerIdleTimer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-host';

beforeEach(() => {
  // Clean test directory
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('session manager', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      admin_user_id: null,
      created_at: now(),
    });
  });

  it('should create session folder and DB', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'outbox'))).toBe(true);

    const dbPath = sessionDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify session DB has the right tables
    const db = new Database(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('messages_in');
    expect(tableNames).toContain('messages_out');
    db.close();
  });

  it('should resolve to existing session (shared mode)', () => {
    const { session: s1, created: c1 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c1).toBe(true);

    const { session: s2, created: c2 } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(c2).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should create separate sessions per thread (per-thread mode)', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2 } = resolveSession('ag-1', 'mg-1', 'thread-2', 'per-thread');
    expect(s1.id).not.toBe(s2.id);
  });

  it('should reuse session for same thread', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2, created } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    expect(created).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should write message to session DB', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'chan-123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ sender: 'User', text: 'Hello' }),
    });

    // Read from the session DB
    const dbPath = sessionDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{
      id: string;
      kind: string;
      status: string;
      content: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('msg-1');
    expect(rows[0].status).toBe('pending');
    expect(JSON.parse(rows[0].content).text).toBe('Hello');
  });

  it('should update last_active on message write', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(getSession(session.id)!.last_active).toBeNull();

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi' }),
    });

    expect(getSession(session.id)!.last_active).not.toBeNull();
  });
});

describe('router', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      admin_user_id: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      trigger_rules: null,
      response_scope: 'all',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('should route a message end-to-end', async () => {
    const { routeInbound } = await import('./router-v2.js');
    const { wakeContainer } = await import('./container-runner-v2.js');

    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello agent!' }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    // Verify session was created
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    // Verify message was written to session DB
    const dbPath = sessionDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello agent!');

    // Verify container was woken
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('should auto-create messaging group for unknown platform', async () => {
    const { routeInbound } = await import('./router-v2.js');

    // This platform ID isn't registered — but since there's no agent configured for it,
    // it should create the messaging group but not route (no agents configured)
    const event: InboundEvent = {
      channelType: 'slack',
      platformId: 'C-NEW-CHANNEL',
      threadId: null,
      message: {
        id: 'msg-2',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    // Messaging group should be created
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');
    const mg = getMessagingGroupByPlatform('slack', 'C-NEW-CHANNEL');
    expect(mg).toBeDefined();
  });

  it('should route multiple messages to the same session', async () => {
    const { routeInbound } = await import('./router-v2.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-a', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'First' }), timestamp: now() },
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-b',
        kind: 'chat',
        content: JSON.stringify({ sender: 'B', text: 'Second' }),
        timestamp: now(),
      },
    });

    // Both should be in the same session
    const session = findSession('mg-1', null);
    const dbPath = sessionDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in ORDER BY timestamp').all();
    db.close();

    expect(rows).toHaveLength(2);
  });
});

describe('delivery', () => {
  it('should detect undelivered messages in session DB', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      is_admin: 0,
      agent_provider: null,
      container_config: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'discord',
      platform_id: 'chan-test',
      name: 'Test',
      is_group: 0,
      admin_user_id: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-test', null, 'shared');

    // Write a response to the session DB (simulating what the agent-runner does)
    const dbPath = sessionDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, delivered, kind, platform_id, channel_type, content)
       VALUES ('out-1', datetime('now'), 0, 'chat', 'chan-123', 'discord', ?)`,
    ).run(JSON.stringify({ text: 'Agent response' }));

    const undelivered = db.prepare('SELECT * FROM messages_out WHERE delivered = 0').all() as Array<{
      id: string;
      content: string;
    }>;
    db.close();

    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0].content).text).toBe('Agent response');
  });
});
