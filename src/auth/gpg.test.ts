import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asGroupScope } from './oauth-types.js';

// Keep path short to stay under Unix socket limit (107 chars for S.gpg-agent.browser)
const tmpDir = path.join(os.tmpdir(), `nc-gpg-${process.pid}`);
vi.stubEnv('HOME', tmpDir);

const SCOPE_A = asGroupScope('scope-a');
const SCOPE_B = asGroupScope('scope-b');

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  buildPgpEncryptUrl,
  gpgDecrypt,
  isPgpMessage,
  formatGpgInstructions,
  promptGpgEncrypt,
} = await import('./gpg.js');

// Helper: create a mock ChatIO for promptGpgEncrypt tests
function createChat(replies: Array<string | null>) {
  let replyIndex = 0;
  const sent: string[] = [];
  const sentRaw: string[] = [];
  return {
    sent,
    sentRaw,
    send: vi.fn(async (text: string) => { sent.push(text); }),
    sendRaw: vi.fn(async (text: string) => { sentRaw.push(text); }),
    receive: vi.fn(async () => {
      const reply = replyIndex < replies.length ? replies[replyIndex] : null;
      replyIndex++;
      return reply;
    }),
    hideMessage: vi.fn(),
    advanceCursor: vi.fn(),
  };
}

describe('isPgpMessage', () => {
  it('detects PGP message header', () => {
    expect(
      isPgpMessage(
        '-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----',
      ),
    ).toBe(true);
  });

  it('detects PGP header with surrounding text', () => {
    expect(
      isPgpMessage(
        'here is the encrypted key:\n-----BEGIN PGP MESSAGE-----\nabc',
      ),
    ).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isPgpMessage('sk-ant-api03-test')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPgpMessage('')).toBe(false);
  });

  it('returns false for other PGP blocks', () => {
    expect(isPgpMessage('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(false);
  });
});

// GPG integration tests — only run if gpg is available
const gpgAvailable = isGpgAvailable();

describe.skipIf(!gpgAvailable)('GPG integration', () => {
  it('isGpgAvailable returns true', () => {
    expect(isGpgAvailable()).toBe(true);
  });

  it('ensureGpgKey creates a keypair', () => {
    ensureGpgKey(SCOPE_A);

    const gnupgDir = path.join(
      tmpDir,
      '.config',
      'nanoclaw',
      'credentials',
      'scope-a',
      '.gnupg',
    );
    expect(fs.existsSync(gnupgDir)).toBe(true);
  });

  it('ensureGpgKey is idempotent', () => {
    ensureGpgKey(SCOPE_A);
    ensureGpgKey(SCOPE_A);
    // No error on second call
  });

  it('exportPublicKey returns ASCII-armored key', () => {
    ensureGpgKey(SCOPE_A);
    const pubKey = exportPublicKey(SCOPE_A);
    expect(pubKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(pubKey).toContain('-----END PGP PUBLIC KEY BLOCK-----');
  });

  it('buildPgpEncryptUrl produces a valid binary key that GPG can import', () => {
    ensureGpgKey(SCOPE_A);
    const url = buildPgpEncryptUrl(SCOPE_A);

    // Extract key param from the URL
    const parsed = new URL(url);
    const keyParam = parsed.searchParams.get('key')!;
    const hashParam = parsed.searchParams.get('hash')!;
    expect(keyParam).toBeTruthy();
    expect(hashParam).toBeTruthy();

    // Decode the binary key
    const binaryKey = Buffer.from(keyParam, 'base64url');
    expect(binaryKey.length).toBeGreaterThan(0);

    // Verify SHA-256 hash matches
    const expectedHash = crypto.createHash('sha256').update(binaryKey).digest('hex');
    expect(hashParam).toBe(expectedHash);

    // Import the binary key into a fresh GPG homedir — proves it's a real PGP key
    const verifyHome = path.join(tmpDir, 'verify-binary');
    fs.mkdirSync(verifyHome, { mode: 0o700, recursive: true });
    execFileSync('gpg', ['--homedir', verifyHome, '--batch', '--import'], {
      input: binaryKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Re-export as armor and compare to the original
    const reExported = execFileSync(
      'gpg',
      ['--homedir', verifyHome, '--armor', '--export', 'nanoclaw'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8').trim();
    const original = exportPublicKey(SCOPE_A);
    expect(reExported).toBe(original);
  });

  it('encrypt and decrypt round-trip', () => {
    ensureGpgKey(SCOPE_A);
    const pubKey = exportPublicKey(SCOPE_A);

    // Import the public key into a separate temp gpg homedir to simulate user side
    const userGpgHome = path.join(tmpDir, 'user-gpg');
    fs.mkdirSync(userGpgHome, { mode: 0o700, recursive: true });

    execFileSync('gpg', ['--homedir', userGpgHome, '--batch', '--import'], {
      input: pubKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Encrypt as the user would
    const plaintext = 'sk-ant-api03-my-secret-key';
    const encrypted = execFileSync(
      'gpg',
      [
        '--homedir',
        userGpgHome,
        '--batch',
        '--trust-model',
        'always',
        '--encrypt',
        '--armor',
        '--recipient',
        'nanoclaw',
      ],
      { input: plaintext, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8');

    expect(encrypted).toContain('-----BEGIN PGP MESSAGE-----');

    // Decrypt on the server side
    const decrypted = gpgDecrypt(SCOPE_A, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('gpgDecrypt throws on invalid ciphertext', () => {
    ensureGpgKey(SCOPE_A);

    expect(() =>
      gpgDecrypt(
        SCOPE_A,
        '-----BEGIN PGP MESSAGE-----\ninvalid\n-----END PGP MESSAGE-----',
      ),
    ).toThrow();
  });

  it('different scopes have independent keys', () => {
    ensureGpgKey(SCOPE_A);
    ensureGpgKey(SCOPE_B);

    const keyA = exportPublicKey(SCOPE_A);
    const keyB = exportPublicKey(SCOPE_B);

    // Keys should be different (different keypairs)
    expect(keyA).not.toBe(keyB);
  });
});

// ---------------------------------------------------------------------------
// formatGpgInstructions
// ---------------------------------------------------------------------------

describe('formatGpgInstructions', () => {
  const fakeUrl = 'https://k-fls.github.io/pgp-encrypt/?key=abc&hash=def';

  it('includes the pgp-encrypt URL', () => {
    const result = formatGpgInstructions(fakeUrl, 'my key');
    expect(result).toContain(fakeUrl);
  });

  it('uses hint in the message', () => {
    const result = formatGpgInstructions(fakeUrl, 'my Todoist API key');
    expect(result).toContain('Encrypt my Todoist API key');
  });

  it('defaults to "your secret" when no hint', () => {
    const result = formatGpgInstructions(fakeUrl);
    expect(result).toContain('Encrypt your secret');
  });

  it('mentions /auth-gpg as alternative', () => {
    const result = formatGpgInstructions(fakeUrl);
    expect(result).toContain('/auth-gpg');
  });
});

// ---------------------------------------------------------------------------
// promptGpgEncrypt (integration — requires GPG)
// ---------------------------------------------------------------------------

describe.skipIf(!gpgAvailable)('promptGpgEncrypt', () => {
  /** Encrypt plaintext with the scope's public key (simulates user side). */
  function encryptForScope(scope: import('./oauth-types.js').GroupScope, plaintext: string): string {
    ensureGpgKey(scope);
    const pubKey = exportPublicKey(scope);
    const userGpgHome = path.join(tmpDir, `user-gpg-${Date.now()}`);
    fs.mkdirSync(userGpgHome, { mode: 0o700, recursive: true });
    execFileSync('gpg', ['--homedir', userGpgHome, '--batch', '--import'], {
      input: pubKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return execFileSync(
      'gpg',
      ['--homedir', userGpgHome, '--batch', '--trust-model', 'always',
       '--encrypt', '--armor', '--recipient', 'nanoclaw'],
      { input: plaintext, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf-8');
  }

  it('returns decrypted plaintext on valid PGP input', async () => {
    const encrypted = encryptForScope(SCOPE_A, 'my-secret');
    const chat = createChat([encrypted]);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(result).toBe('my-secret');
    expect(chat.hideMessage).toHaveBeenCalled();
    expect(chat.advanceCursor).toHaveBeenCalled();
  });

  it('sends pgp-encrypt URL with embedded key', async () => {
    const encrypted = encryptForScope(SCOPE_A, 'key');
    const chat = createChat([encrypted]);

    await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(chat.sent.some((m) => m.includes('https://k-fls.github.io/pgp-encrypt/?key='))).toBe(true);
  });

  it('sends instructions with abort hint', async () => {
    const encrypted = encryptForScope(SCOPE_A, 'key');
    const chat = createChat([encrypted]);

    await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(chat.sent.some((m) => m.includes('Reply *0* to abort'))).toBe(true);
  });

  it('returns null on cancel (0)', async () => {
    const chat = createChat(['0']);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(result).toBeNull();
    expect(chat.sent.some((m) => m.includes('Cancelled'))).toBe(true);
    expect(chat.hideMessage).toHaveBeenCalled();
    expect(chat.advanceCursor).toHaveBeenCalled();
  });

  it('returns null on timeout', async () => {
    const chat = createChat([null]);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(result).toBeNull();
    expect(chat.sent.some((m) => m.includes('Cancelled'))).toBe(true);
  });

  it('retries on non-PGP input then accepts valid input', async () => {
    const encrypted = encryptForScope(SCOPE_A, 'secret');
    const chat = createChat(['plain-text', encrypted]);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(result).toBe('secret');
    expect(chat.sent.some((m) => m.includes('Expected a GPG-encrypted message'))).toBe(true);
    // hideMessage called for both attempts
    expect(chat.hideMessage).toHaveBeenCalledTimes(2);
  });

  it('retries on validation failure then accepts valid input', async () => {
    const bad = encryptForScope(SCOPE_A, 'wrong-format');
    const good = encryptForScope(SCOPE_A, 'sk-ant-api03-valid');
    const chat = createChat([bad, good]);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000, {
      validate: (pt) => pt.startsWith('sk-ant-api') ? null : 'Must start with sk-ant-api',
    });
    expect(result).toBe('sk-ant-api03-valid');
    expect(chat.sent.some((m) => m.includes('Must start with sk-ant-api'))).toBe(true);
  });

  it('retries on decrypt failure then accepts cancel', async () => {
    const chat = createChat([
      '-----BEGIN PGP MESSAGE-----\ncorrupt\n-----END PGP MESSAGE-----',
      '0',
    ]);

    const result = await promptGpgEncrypt(SCOPE_A, chat, 5000);
    expect(result).toBeNull();
    expect(chat.sent.some((m) => m.includes('Failed to decrypt'))).toBe(true);
    expect(chat.sent.some((m) => m.includes('Cancelled'))).toBe(true);
  });

  it('uses hint in instructions', async () => {
    const chat = createChat(['0']);

    await promptGpgEncrypt(SCOPE_A, chat, 5000, { hint: 'your API token' });
    expect(chat.sent.some((m) => m.includes('Encrypt your API token'))).toBe(true);
  });
});
