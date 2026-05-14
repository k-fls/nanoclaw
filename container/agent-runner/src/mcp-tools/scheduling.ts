/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * Tasks are messages_in rows with process_after timestamps and optional recurrence.
 * The host sweep detects due tasks and wakes the container.
 */
import { getSessionDb } from '../db/connection.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return {
    platform_id: process.env.NANOCLAW_PLATFORM_ID || null,
    channel_type: process.env.NANOCLAW_CHANNEL_TYPE || null,
    thread_id: process.env.NANOCLAW_THREAD_ID || null,
  };
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      'Schedule a one-shot or recurring task. The task will be processed at the specified time. Use cron expressions for recurring tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: { type: 'string', description: 'ISO timestamp for first run (e.g., 2024-01-15T09:00:00Z)' },
        recurrence: { type: 'string', description: 'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" for weekdays at 9am)' },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfter = args.processAfter as string;
    if (!prompt || !processAfter) return err('prompt and processAfter are required');

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;

    const content = JSON.stringify({ prompt, script });

    getSessionDb()
      .prepare(
        `INSERT INTO messages_in (id, timestamp, status, status_changed, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content)
         VALUES (@id, datetime('now'), 'pending', datetime('now'), 0, @process_after, @recurrence, 'task', @platform_id, @channel_type, @thread_id, @content)`,
      )
      .run({
        id,
        process_after: processAfter,
        recurrence,
        platform_id: r.platform_id,
        channel_type: r.channel_type,
        thread_id: r.thread_id,
        content,
      });

    log(`schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}`);
    return ok(`Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''})`);
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description: 'List scheduled and pending tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, processing, completed, paused (default: all non-completed)' },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    let rows;
    if (status) {
      rows = getSessionDb()
        .prepare("SELECT id, status, process_after, recurrence, content FROM messages_in WHERE kind = 'task' AND status = ? ORDER BY process_after ASC")
        .all(status);
    } else {
      rows = getSessionDb()
        .prepare("SELECT id, status, process_after, recurrence, content FROM messages_in WHERE kind = 'task' AND status NOT IN ('completed') ORDER BY process_after ASC")
        .all();
    }

    if ((rows as unknown[]).length === 0) return ok('No tasks found.');

    const lines = (rows as Array<{ id: string; status: string; process_after: string | null; recurrence: string | null; content: string }>).map((r) => {
      const content = JSON.parse(r.content);
      const prompt = (content.prompt as string || '').slice(0, 80);
      return `- ${r.id} [${r.status}] at=${r.process_after || 'now'} ${r.recurrence ? `recur=${r.recurrence} ` : ''}→ ${prompt}`;
    });

    return ok(lines.join('\n'));
  },
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const result = getSessionDb()
      .prepare("UPDATE messages_in SET status = 'completed', status_changed = datetime('now') WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')")
      .run(taskId);

    if (result.changes === 0) return err(`Task not found or not cancellable: ${taskId}`);

    log(`cancel_task: ${taskId}`);
    return ok(`Task cancelled: ${taskId}`);
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const result = getSessionDb()
      .prepare("UPDATE messages_in SET status = 'paused', status_changed = datetime('now') WHERE id = ? AND kind = 'task' AND status = 'pending'")
      .run(taskId);

    if (result.changes === 0) return err(`Task not found or not pausable: ${taskId}`);

    log(`pause_task: ${taskId}`);
    return ok(`Task paused: ${taskId}`);
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const result = getSessionDb()
      .prepare("UPDATE messages_in SET status = 'pending', status_changed = datetime('now') WHERE id = ? AND kind = 'task' AND status = 'paused'")
      .run(taskId);

    if (result.changes === 0) return err(`Task not found or not paused: ${taskId}`);

    log(`resume_task: ${taskId}`);
    return ok(`Task resumed: ${taskId}`);
  },
};

export const schedulingTools: McpToolDefinition[] = [scheduleTask, listTasks, cancelTask, pauseTask, resumeTask];
