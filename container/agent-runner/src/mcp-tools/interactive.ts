/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { getSessionDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Button labels for the user to choose from',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['question', 'options'],
    },
  },
  async handler(args) {
    const question = args.question as string;
    const options = args.options as string[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!question || !options?.length) return err('question and options are required');

    const questionId = generateId();
    const r = routing();

    // Write question card to messages_out
    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in messages_in
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = getSessionDb()
        .prepare("SELECT content FROM messages_in WHERE kind = 'system' AND content LIKE ? AND status = 'pending' LIMIT 1")
        .get(`%"questionId":"${questionId}"%`) as { content: string } | undefined;

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed so the poll loop doesn't pick it up
        getSessionDb()
          .prepare("UPDATE messages_in SET status = 'completed', status_changed = datetime('now') WHERE kind = 'system' AND content LIKE ?")
          .run(`%"questionId":"${questionId}"%`);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Card structure with title, description, and optional children/actions',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

export const interactiveTools: McpToolDefinition[] = [askUserQuestion, sendCard];
