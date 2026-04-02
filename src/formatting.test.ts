import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  getTriggerPattern,
  TRIGGER_PATTERN,
} from './config.js';
import {
  decodeMessages,
  escapeXml,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import type { Channel, NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function stubChannel(decodeInbound?: (text: string) => string): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    decodeInbound,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('<context timezone="America/New_York" />');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check group.trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, undefined, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only the default trigger is present for a custom-trigger group', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});

// --- decodeMessages ---

describe('decodeMessages', () => {
  it('returns same array when non-slack channel has no decodeInbound', () => {
    const ch = stubChannel();
    ch.name = 'whatsapp';
    const messages = [
      makeMsg({ content: 'hello <@U123>' }),
      makeMsg({ content: '&amp; test' }),
    ];
    const result = decodeMessages(messages, ch);
    expect(result).toBe(messages);
  });

  it('applies decodeInbound to message content', () => {
    const decode = (text: string) => text.replace(/&amp;/g, '&');
    const messages = [
      makeMsg({ content: 'a &amp; b' }),
      makeMsg({ content: 'c &amp; d' }),
    ];
    const result = decodeMessages(messages, stubChannel(decode));
    expect(result[0].content).toBe('a & b');
    expect(result[1].content).toBe('c & d');
  });

  it('preserves all non-content fields', () => {
    const decode = (text: string) => text.toUpperCase();
    const original = makeMsg({
      id: 'msg-42',
      chat_jid: 'slack:C999',
      sender: 'UABC',
      sender_name: 'Alice',
      timestamp: '2025-06-15T12:00:00.000Z',
      is_from_me: false,
      is_bot_message: true,
    });
    const [result] = decodeMessages([original], stubChannel(decode));
    expect(result.content).toBe('HELLO');
    expect(result.id).toBe('msg-42');
    expect(result.chat_jid).toBe('slack:C999');
    expect(result.sender).toBe('UABC');
    expect(result.sender_name).toBe('Alice');
    expect(result.timestamp).toBe('2025-06-15T12:00:00.000Z');
    expect(result.is_from_me).toBe(false);
    expect(result.is_bot_message).toBe(true);
  });

  it('does not mutate original messages', () => {
    const decode = (text: string) => text.replace(/x/g, 'y');
    const original = makeMsg({ content: 'x marks the spot' });
    decodeMessages([original], stubChannel(decode));
    expect(original.content).toBe('x marks the spot');
  });

  it('handles empty message array', () => {
    const result = decodeMessages(
      [],
      stubChannel((t) => t.toUpperCase()),
    );
    expect(result).toEqual([]);
  });
});

// --- Slack fallback decode (compatibility) ---

describe('decodeMessages fallback for slack channel without decodeInbound', () => {
  function slackChannelWithoutDecode(): Channel {
    const ch = stubChannel(); // no decodeInbound
    ch.name = 'slack';
    return ch;
  }

  it('activates fallback when channel.name is slack and no decodeInbound', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages([makeMsg({ content: 'a &amp; b' })], ch);
    expect(decoded.content).toBe('a & b');
  });

  it('decodes all three HTML entities', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: '1 &lt; 2 &amp;&amp; 2 &gt; 1' })],
      ch,
    );
    expect(decoded.content).toBe('1 < 2 && 2 > 1');
  });

  it('unwraps bare URLs', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<https://example.com>' })],
      ch,
    );
    expect(decoded.content).toBe('https://example.com');
  });

  it('unwraps labelled URLs', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<https://example.com|click here>' })],
      ch,
    );
    expect(decoded.content).toBe('click here');
  });

  it('strips duplicate mention after @trigger (old slack.ts compat)', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: `@${ASSISTANT_NAME} <@U0AKKG67T7X> /auth` })],
      ch,
    );
    expect(decoded.content).toBe(`@${ASSISTANT_NAME} /auth`);
  });

  it('strips duplicate but decodes remaining standalone mentions', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [
        makeMsg({
          content: `@${ASSISTANT_NAME} <@U0AKKG67T7X> <@U0AKKG67T7X>`,
        }),
      ],
      ch,
    );
    expect(decoded.content).toBe(`@${ASSISTANT_NAME} @U0AKKG67T7X`);
  });

  it('decodes standalone mention when no preceding @mention', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<@U0AKKG67T7X> hello' })],
      ch,
    );
    expect(decoded.content).toBe('@U0AKKG67T7X hello');
  });

  it('decodes channel mentions', () => {
    const ch = slackChannelWithoutDecode();
    const [decoded] = decodeMessages(
      [makeMsg({ content: 'see <#C01ABC|general>' })],
      ch,
    );
    expect(decoded.content).toBe('see #general');
  });

  it('prefers channel decodeInbound over fallback', () => {
    const ch = stubChannel((t) => t.replace(/x/g, 'X'));
    ch.name = 'slack';
    const [decoded] = decodeMessages([makeMsg({ content: 'x &amp; x' })], ch);
    // Custom decode runs, not fallback — &amp; stays
    expect(decoded.content).toBe('X &amp; X');
  });

  it('does not activate fallback for non-slack channels', () => {
    const ch = stubChannel(); // no decodeInbound
    ch.name = 'telegram';
    const messages = [makeMsg({ content: '&amp; test' })];
    const result = decodeMessages(messages, ch);
    expect(result).toBe(messages); // same reference, no decode
  });
});

// --- Slack decode pattern ---
// Exercises the decode pattern that SlackChannel.decodeInbound will implement.

describe('Slack decode pattern', () => {
  const BOT_USER_ID = 'U0AKKG67T7X';

  function slackDecode(text: string): string {
    return text
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<@(U[A-Z0-9]+)>/g, (_, id) =>
        id === BOT_USER_ID ? `@${ASSISTANT_NAME}` : `@${id}`,
      )
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  const slackChannel = stubChannel(slackDecode);

  it('decodes bot mention to trigger text', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<@U0AKKG67T7X> /auth' })],
      slackChannel,
    );
    expect(decoded.content).toBe(`@${ASSISTANT_NAME} /auth`);
  });

  it('trigger pattern matches decoded bot mention', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<@U0AKKG67T7X> hello' })],
      slackChannel,
    );
    expect(TRIGGER_PATTERN.test(decoded.content.trim())).toBe(true);
  });

  it('decodes HTML entities in URLs', () => {
    const [decoded] = decodeMessages(
      [
        makeMsg({
          content: '<http://localhost:9999/callback?code=abc&amp;state=xyz>',
        }),
      ],
      slackChannel,
    );
    expect(decoded.content).toBe(
      'http://localhost:9999/callback?code=abc&state=xyz',
    );
  });

  it('decodes user mentions with same pattern as bot mentions', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: '<@U0AKKG67T7X> asked <@UOTHER123> something' })],
      slackChannel,
    );
    expect(decoded.content).toBe(
      `@${ASSISTANT_NAME} asked @UOTHER123 something`,
    );
  });

  it('unwraps labelled URLs', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: 'see <https://example.com|this link>' })],
      slackChannel,
    );
    expect(decoded.content).toBe('see this link');
  });

  it('unwraps bare URLs', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: 'visit <https://example.com>' })],
      slackChannel,
    );
    expect(decoded.content).toBe('visit https://example.com');
  });

  it('decodes channel mentions', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: 'posted in <#C01ABC|general>' })],
      slackChannel,
    );
    expect(decoded.content).toBe('posted in #general');
  });

  it('decodes all three HTML entities', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: '1 &lt; 2 &amp;&amp; 2 &gt; 1' })],
      slackChannel,
    );
    expect(decoded.content).toBe('1 < 2 && 2 > 1');
  });

  it('passes plain text through unchanged', () => {
    const [decoded] = decodeMessages(
      [makeMsg({ content: 'just a normal message' })],
      slackChannel,
    );
    expect(decoded.content).toBe('just a normal message');
  });
});
