/**
 * Reusable chat-based prompts for interactive auth flows.
 */
import type { ChatIO } from './types.js';

export const IDLE_TIMEOUT = 120_000;
export const AUTH_PREFIX = '🔑';
const VALID_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** Check whether a string is a valid credential identifier. */
export function isIdentifier(s: string): boolean {
  return VALID_ID_RE.test(s);
}

/**
 * Interactive menu: pick a numbered choice or type an arbitrary identifier.
 *
 * Assumes `chat` is already branded (via `brandChat`) — all `send()` calls
 * go through without manual prefix prepending.
 *
 * @param choices — numbered options as `Map<number, label>`, sorted by key
 *   before display.  May be empty.
 * @param customPrompt — extra hint (e.g. "or type a name").  When both
 *   `choices` is empty and `customPrompt` is omitted, defaults to
 *   "Input value, or *0* to abort."
 *
 * Returns:
 * - `number` — the key from `choices` the user selected
 * - `string` — custom identifier typed by the user
 * - `null`   — cancelled (`0`), timed out, or session aborted
 */
export async function chooseOption(
  chat: ChatIO,
  heading: string,
  choices: Map<number, string>,
  customPrompt?: string,
): Promise<string | number | null> {
  // Separate non-zero entries (the real options) from a possible custom 0 label
  const sorted = [...choices.entries()]
    .filter(([n]) => n !== 0)
    .sort(([a], [b]) => a - b);
  const validKeys = new Set(sorted.map(([n]) => n));
  validKeys.add(0); // 0 is always valid (cancel)

  // Build menu: numbered options, then 0 at the bottom
  const menuLines = sorted.map(([n, label]) => `${n}. ${label}`);
  menuLines.push(`0. ${choices.get(0) ?? 'Cancel'}`);
  const menu = menuLines.join('\n');

  let tail: string;
  if (sorted.length > 0 && customPrompt) {
    tail = `Reply with a number to select ${customPrompt}.`;
  } else if (sorted.length > 0) {
    tail = `Reply with a number to select.`;
  } else if (customPrompt) {
    tail = `${customPrompt}.`;
  } else {
    tail = `Input value.`;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await chat.send(`${heading}\n\n${menu}\n\n${tail}`);
    const reply = await chat.receive(IDLE_TIMEOUT);
    if (!reply) return null; // timeout or session aborted
    chat.hideMessage();
    chat.advanceCursor();

    const trimmed = reply.trim();
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) return trimmed;
    if (num === 0) return null;
    if (validKeys.has(num)) return num;

    await chat.send('Invalid option number.');
  }
}

/**
 * Like {@link chooseOption} but always resolves to a name string.
 * Number selections are mapped back to the corresponding choice label.
 *
 * When `allowCustom` is true, the user may type an arbitrary identifier.
 * When false, only numbered selections are accepted.
 */
export async function chooseName(
  chat: ChatIO,
  heading: string,
  choices: string[],
  allowCustom?: boolean,
): Promise<string | null> {
  const prompt = allowCustom
    ? 'or type a name to create a new credential'
    : undefined;
  const map = new Map(choices.map((label, i) => [i + 1, label]));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await chooseOption(chat, heading, map, prompt);
    if (result === null) return null;
    if (typeof result === 'number') return map.get(result)!;

    if (!allowCustom) {
      await chat.send('Please pick a number from the list.');
    } else if (isIdentifier(result)) {
      return result;
    } else {
      await chat.send(
        'Invalid identifier. Use letters, digits, underscores, or hyphens.',
      );
    }
  }
}
