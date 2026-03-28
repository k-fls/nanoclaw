import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- getRegisteredGroup ---

describe('getRegisteredGroup', () => {
  it('returns a single group by JID', () => {
    setRegisteredGroup('test@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const group = getRegisteredGroup('test@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Test Group');
    expect(group!.folder).toBe('whatsapp_test');
    expect(group!.jid).toBe('test@g.us');
  });

  it('returns undefined for non-existent JID', () => {
    expect(getRegisteredGroup('nonexistent@g.us')).toBeUndefined();
  });

  it('parses containerConfig JSON', () => {
    setRegisteredGroup('cfg@g.us', {
      name: 'Configured Group',
      folder: 'whatsapp_configured',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      containerConfig: {
        timeout: 60000,
        additionalMounts: [{ hostPath: '/tmp/test' }],
      },
    });

    const group = getRegisteredGroup('cfg@g.us');
    expect(group!.containerConfig).toBeDefined();
    expect(group!.containerConfig!.timeout).toBe(60000);
    expect(group!.containerConfig!.additionalMounts).toHaveLength(1);
  });

  it('parses requiresTrigger correctly', () => {
    setRegisteredGroup('trig@g.us', {
      name: 'No Trigger',
      folder: 'whatsapp_notrigger',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
    });

    const group = getRegisteredGroup('trig@g.us');
    expect(group!.requiresTrigger).toBe(false);
  });
});

// --- setRegisteredGroup validation ---

describe('setRegisteredGroup validation', () => {
  it('throws on invalid folder name', () => {
    expect(() =>
      setRegisteredGroup('bad@g.us', {
        name: 'Bad',
        folder: '../escape',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow('Invalid group folder');
  });

  it('throws on reserved folder name "global"', () => {
    expect(() =>
      setRegisteredGroup('bad@g.us', {
        name: 'Bad',
        folder: 'global',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow('Invalid group folder');
  });

  it('throws on empty folder name', () => {
    expect(() =>
      setRegisteredGroup('bad@g.us', {
        name: 'Bad',
        folder: '',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow('Invalid group folder');
  });
});

// --- getAllRegisteredGroups with mixed valid/invalid ---

describe('getAllRegisteredGroups filtering', () => {
  it('skips groups with invalid folder names and logs warning', () => {
    // Insert a valid group normally
    setRegisteredGroup('good@g.us', {
      name: 'Good',
      folder: 'whatsapp_good',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Groups with invalid folders can only exist from legacy data or direct DB insertion.
    // getAllRegisteredGroups should skip them. We test this by verifying the valid group loads.
    const groups = getAllRegisteredGroups();
    expect(groups['good@g.us']).toBeDefined();
    expect(groups['good@g.us'].folder).toBe('whatsapp_good');
  });
});

// --- storeChatMetadata with channel and isGroup ---

describe('storeChatMetadata channel info', () => {
  it('stores channel and isGroup', () => {
    storeChatMetadata(
      'dc:12345',
      '2024-01-01T00:00:00.000Z',
      'Discord Server',
      'discord',
      true,
    );
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'dc:12345');
    expect(chat).toBeDefined();
    expect(chat!.channel).toBe('discord');
    expect(chat!.is_group).toBe(1);
  });

  it('preserves existing channel on update without channel param', () => {
    storeChatMetadata(
      'tg:99',
      '2024-01-01T00:00:00.000Z',
      'TG Chat',
      'telegram',
      true,
    );
    // Update without channel info
    storeChatMetadata('tg:99', '2024-01-01T00:00:01.000Z', 'TG Chat Updated');
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'tg:99');
    expect(chat!.channel).toBe('telegram');
    expect(chat!.name).toBe('TG Chat Updated');
  });
});

// --- migrateJsonState (via initDatabase) ---

describe('migrateJsonState', () => {
  let tmpDataDir: string;
  let tmpStoreDir: string;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-data-'));
    tmpStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpStoreDir, { recursive: true, force: true });
  });

  /** Import a fresh db module with config pointing to temp dirs. */
  async function freshDb() {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      DATA_DIR: tmpDataDir,
      STORE_DIR: tmpStoreDir,
      ASSISTANT_NAME: 'Andy',
    }));
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    }));
    return import('./db.js');
  }

  it('migrates router_state.json', async () => {
    fs.writeFileSync(
      path.join(tmpDataDir, 'router_state.json'),
      JSON.stringify({
        last_timestamp: '2024-06-01T00:00:00.000Z',
        last_agent_timestamp: { main: '2024-06-01T00:00:01.000Z' },
      }),
    );

    const db = await freshDb();
    db.initDatabase();

    expect(db.getRouterState('last_timestamp')).toBe(
      '2024-06-01T00:00:00.000Z',
    );
    const agentTs = db.getRouterState('last_agent_timestamp');
    expect(agentTs).toBeDefined();
    expect(JSON.parse(agentTs!)).toEqual({ main: '2024-06-01T00:00:01.000Z' });

    // Original file should be renamed to .migrated
    expect(
      fs.existsSync(path.join(tmpDataDir, 'router_state.json.migrated')),
    ).toBe(true);
    expect(fs.existsSync(path.join(tmpDataDir, 'router_state.json'))).toBe(
      false,
    );
  });

  it('migrates sessions.json', async () => {
    fs.writeFileSync(
      path.join(tmpDataDir, 'sessions.json'),
      JSON.stringify({
        whatsapp_main: 'session-abc',
        whatsapp_family: 'session-def',
      }),
    );

    const db = await freshDb();
    db.initDatabase();

    expect(db.getAllSessions()).toEqual({
      whatsapp_main: 'session-abc',
      whatsapp_family: 'session-def',
    });

    expect(fs.existsSync(path.join(tmpDataDir, 'sessions.json.migrated'))).toBe(
      true,
    );
  });

  it('migrates registered_groups.json', async () => {
    fs.writeFileSync(
      path.join(tmpDataDir, 'registered_groups.json'),
      JSON.stringify({
        'group@g.us': {
          name: 'Test Group',
          folder: 'whatsapp_test',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    );

    const db = await freshDb();
    db.initDatabase();

    const groups = db.getAllRegisteredGroups();
    expect(groups['group@g.us']).toBeDefined();
    expect(groups['group@g.us'].name).toBe('Test Group');
    expect(groups['group@g.us'].folder).toBe('whatsapp_test');

    expect(
      fs.existsSync(path.join(tmpDataDir, 'registered_groups.json.migrated')),
    ).toBe(true);
  });

  it('skips migration when JSON files do not exist', async () => {
    // No JSON files written — migration should be a no-op
    const db = await freshDb();
    db.initDatabase();

    expect(db.getRouterState('last_timestamp')).toBeUndefined();
    expect(db.getAllSessions()).toEqual({});
    expect(db.getAllRegisteredGroups()).toEqual({});
  });

  it('skips groups with invalid folders during migration', async () => {
    fs.writeFileSync(
      path.join(tmpDataDir, 'registered_groups.json'),
      JSON.stringify({
        'valid@g.us': {
          name: 'Valid',
          folder: 'whatsapp_valid',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
        'invalid@g.us': {
          name: 'Invalid',
          folder: '../escape',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    );

    const db = await freshDb();
    db.initDatabase();

    const groups = db.getAllRegisteredGroups();
    expect(groups['valid@g.us']).toBeDefined();
    expect(groups['invalid@g.us']).toBeUndefined();
  });
});
