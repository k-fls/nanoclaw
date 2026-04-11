/**
 * Per-group GPG key management — thin wrapper over src/crypto/gpg.
 *
 * Re-exports the scope-only convenience API after binding the base
 * directory to ~/.config/nanoclaw/credentials/. Callers that already
 * import from this file (ensureGpgKey, exportPublicKey, gpgDecrypt,
 * isPgpMessage, isGpgAvailable) keep working with the same signatures.
 *
 * Also provides {@link promptGpgEncrypt} — a reusable chat-based flow
 * that prints the public key, gives encryption instructions, receives
 * the encrypted reply, decrypts it, and properly hides/advances the
 * cursor so the message never leaks to the agent.
 */
import { initGpg, gpg, isGpgAvailable, isPgpMessage } from '../crypto/index.js';
import { CREDENTIALS_DIR } from './store.js';
import type { ChatIO } from './types.js';
import type { GroupScope } from './oauth-types.js';
import { logger } from '../logger.js';

export { isGpgAvailable, isPgpMessage, normalizeArmoredBlock } from '../crypto/index.js';
import { normalizeArmoredBlock } from '../crypto/index.js';

// Eagerly bind the default base dir so callers never need to pass it.
initGpg(CREDENTIALS_DIR);

/** Ensure a GPG keypair exists for the given group scope. Creates one if missing. */
export function ensureGpgKey(scope: GroupScope): void {
  gpg.ensure(scope);
}

/** Export the ASCII-armored public key for the given group scope. */
export function exportPublicKey(scope: GroupScope): string {
  return gpg.export(scope);
}

/** Decrypt a PGP-encrypted message. Returns the plaintext. */
export function gpgDecrypt(scope: GroupScope, ciphertext: string): string {
  return gpg.decrypt(scope, ciphertext);
}

// ---------------------------------------------------------------------------
// Format the public key block + encryption instructions for chat output
// ---------------------------------------------------------------------------

/**
 * Build the encryption-instructions message. Re-used by both interactive
 * prompts (which append "reply 0 to abort") and non-interactive error
 * replies (which just tell the user what to do).
 */
export function formatGpgInstructions(hint?: string): string {
  const what = hint ?? 'your secret';
  return (
    `Encrypt ${what} with the public key above.\n` +
    'Use your preferred PGP encryption tool, or follow these steps:\n\n' +
    '*Step 1.* Open https://k-fls.github.io/pgp-encrypt/\n' +
    '*Step 2.* Paste the public key and your secret, copy the encrypted output.\n' +
    '*Step 3.* Paste the encrypted output here.'
  );
}

// ---------------------------------------------------------------------------
// Interactive GPG prompt — send key, receive encrypted reply, decrypt
// ---------------------------------------------------------------------------

export interface GpgPromptOptions {
  /** Human-readable hint for what the user is encrypting (e.g. "your Todoist API key"). */
  hint?: string;
  /** Validate the decrypted plaintext. Return an error string to reject and retry, or null to accept. */
  validate?: (plaintext: string) => string | null;
}

/**
 * Full interactive GPG encrypt-via-chat flow with retry loop:
 *
 * 1. Checks GPG availability, ensures keypair for scope
 * 2. Sends raw public key block (copy-pasteable)
 * 3. Sends encryption instructions
 * 4. Loops: receives reply → hides it → validates → decrypts → validates plaintext
 *    On any error (not PGP, decrypt failure, validation), tells the user and
 *    waits for another attempt. User sends *0* to abort at any point.
 * 5. Returns decrypted plaintext on success, null on cancel/timeout/GPG error.
 *
 * All paths call hideMessage + advanceCursor so nothing leaks to the agent.
 */
export async function promptGpgEncrypt(
  scope: GroupScope,
  chat: ChatIO,
  timeoutMs: number,
  opts?: GpgPromptOptions,
): Promise<string | null> {
  if (!isGpgAvailable()) {
    await chat.send(
      'GPG is not installed. ' +
        'Install it (`apt install gnupg` or `brew install gnupg`) and try again.',
    );
    return null;
  }

  let pubKey: string;
  try {
    ensureGpgKey(scope);
    pubKey = exportPublicKey(scope);
  } catch (err) {
    logger.warn({ scope, err }, 'GPG key setup failed');
    await chat.send(
      'Failed to initialize GPG keypair: ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Send raw public key (copy-pasteable, no prefix)
  await chat.sendRaw(pubKey);

  // Send instructions + cancel hint
  const instructions = formatGpgInstructions(opts?.hint);
  await chat.send(instructions + '\n\nReply *0* to abort.');

  // Retry loop — user can keep trying until success or cancel
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const reply = await chat.receive(timeoutMs);

    // Always hide + advance so nothing leaks to the agent
    if (reply) {
      chat.hideMessage();
      chat.advanceCursor();
    }

    if (!reply || reply.trim() === '0') {
      await chat.send('Cancelled.');
      return null;
    }

    if (!isPgpMessage(reply)) {
      await chat.send(
        'Expected a GPG-encrypted message (-----BEGIN PGP MESSAGE-----).\n' +
          'Plaintext keys are not accepted for security reasons.\n\n' +
          'Paste the encrypted output, or reply *0* to abort.',
      );
      continue;
    }

    let plaintext: string;
    try {
      plaintext = gpgDecrypt(scope, normalizeArmoredBlock(reply)).trim();
    } catch (err) {
      logger.error({ scope, err }, 'GPG decrypt failed');
      await chat.send(
        'Failed to decrypt. Make sure you encrypted with the public key shown above.\n\n' +
          'Try again, or reply *0* to abort.',
      );
      continue;
    }

    // Optional caller validation (e.g. "must start with sk-ant-api")
    const validationError = opts?.validate?.(plaintext) ?? null;
    if (validationError) {
      await chat.send(validationError + '\n\nTry again, or reply *0* to abort.');
      continue;
    }

    return plaintext;
  }
}
