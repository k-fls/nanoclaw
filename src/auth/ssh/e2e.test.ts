/**
 * Docker-based e2e test for the SSH credential isolation system.
 *
 * Proves the full loop:
 *   1. Store SSH credential on the host via the resolver
 *   2. Container calls proxy /ssh/connect → proxy spawns ControlMaster
 *   3. Socket appears at /ssh-sockets/<alias>.sock inside the container
 *   4. Container runs ssh command through the ControlMaster socket
 *   5. Container calls proxy /ssh/disconnect → socket removed
 *   6. /ssh/connections lists active connections
 *
 * Prerequisites:
 *   - Docker running
 *   - nanoclaw-agent image built (./container/build.sh)
 *   - sshd available on the host (apt install openssh-server) or we spin
 *     up a minimal sshd container
 *
 * Tests are auto-skipped if Docker or the image is unavailable.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OAuthE2EHarness,
  isDockerAvailable,
  isImageAvailable,
  detectProxyBind,
} from '../e2e-harness.js';
import { asCredentialScope, asGroupScope } from '../oauth-types.js';
import { sshToCredential } from './types.js';
import type { SSHCredentialMeta } from './types.js';
import { initSSHSystem, getSSHManager } from './index.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE = 'ssh-e2e-test';
const ALIAS = 'e2e-sshd';

function generateKeyPair(dir: string): { privateKey: string; publicKey: string } {
  const keyPath = path.join(dir, 'key');
  execSync(`ssh-keygen -t ed25519 -f ${keyPath} -N "" -C nanoclaw-e2e`, {
    stdio: 'pipe',
  });
  return {
    privateKey: fs.readFileSync(keyPath, 'utf-8'),
    publicKey: fs.readFileSync(keyPath + '.pub', 'utf-8').trim(),
  };
}

/** Start a minimal sshd Docker container and return connection details. */
function startSshdContainer(publicKey: string): {
  containerName: string;
  host: string;
  port: number;
  username: string;
  stop: () => void;
} {
  const containerName = `nanoclaw-e2e-sshd-${Date.now()}`;
  const proxyBind = detectProxyBind();

  // Use linuxserver/openssh-server for a simple sshd.
  // Alternatively, build a minimal one inline.
  // We'll use a direct approach: run an Alpine container with openssh-server.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshd-e2e-'));
  const authKeysDir = path.join(tmpDir, 'authorized_keys');
  fs.mkdirSync(authKeysDir, { recursive: true });
  fs.writeFileSync(path.join(authKeysDir, 'testuser'), publicKey + '\n', {
    mode: 0o600,
  });

  // Host key — generate so we know it
  const hostKeyPath = path.join(tmpDir, 'ssh_host_ed25519_key');
  execSync(`ssh-keygen -t ed25519 -f ${hostKeyPath} -N "" -C host`, {
    stdio: 'pipe',
  });

  // sshd_config
  const sshdConfig = path.join(tmpDir, 'sshd_config');
  fs.writeFileSync(
    sshdConfig,
    [
      'Port 22',
      'HostKey /etc/ssh/ssh_host_ed25519_key',
      'PermitRootLogin no',
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'AuthorizedKeysFile /home/testuser/.ssh/authorized_keys',
      'Subsystem sftp /usr/lib/ssh/sftp-server',
      'UsePAM no',
    ].join('\n') + '\n',
  );

  // Write the init script to a temp file and mount it into the container.
  // This avoids shell quoting issues with the public key and && chains.
  const initScript = path.join(tmpDir, 'init.sh');
  fs.writeFileSync(
    initScript,
    [
      '#!/bin/sh',
      'set -e',
      'apk add --no-cache openssh >/dev/null 2>&1',
      'adduser -D -s /bin/sh testuser',
      'passwd -u testuser',  // unlock account — locked accounts reject pubkey auth
      'mkdir -p /home/testuser/.ssh',
      `echo '${publicKey}' > /home/testuser/.ssh/authorized_keys`,
      'chmod 755 /home/testuser',
      'chmod 700 /home/testuser/.ssh',
      'chmod 600 /home/testuser/.ssh/authorized_keys',
      'chown -R testuser:testuser /home/testuser',
      'ssh-keygen -A >/dev/null 2>&1',
      'exec /usr/sbin/sshd -D -e',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  // Start the container
  execSync(
    [
      CONTAINER_RUNTIME_BIN,
      'run', '-d',
      '--name', containerName,
      '-p', `${proxyBind}:0:22`,
      '-v', `${sshdConfig}:/etc/ssh/sshd_config:ro`,
      '-v', `${hostKeyPath}:/etc/ssh/ssh_host_ed25519_key:ro`,
      '-v', `${hostKeyPath}.pub:/etc/ssh/ssh_host_ed25519_key.pub:ro`,
      '-v', `${initScript}:/init.sh:ro`,
      'alpine:latest',
      '/init.sh',
    ].join(' '),
    { stdio: 'pipe' },
  );

  // Wait for sshd to be ready
  let retries = 20;
  while (retries-- > 0) {
    try {
      execSync(
        `${CONTAINER_RUNTIME_BIN} exec ${containerName} sh -c "pgrep sshd"`,
        { stdio: 'pipe', timeout: 2000 },
      );
      break;
    } catch {
      execSync('sleep 0.5', { stdio: 'pipe' });
    }
  }

  // Get the mapped port
  const portOut = execSync(
    `${CONTAINER_RUNTIME_BIN} port ${containerName} 22`,
    { encoding: 'utf-8' },
  ).trim();
  // Format: 0.0.0.0:NNNNN or 172.x.x.x:NNNNN
  const port = parseInt(portOut.split(':').pop()!, 10);

  return {
    containerName,
    host: proxyBind,
    port,
    username: 'testuser',
    stop: () => {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${containerName}`, {
          stdio: 'pipe',
        });
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const canRun = isDockerAvailable() && isImageAvailable();

describe.skipIf(!canRun)('SSH e2e (Docker)', () => {
  let h: OAuthE2EHarness;
  let sshd: ReturnType<typeof startSshdContainer>;
  let keyPair: { privateKey: string; publicKey: string };
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-e2e-'));

    // 1. Generate client keypair
    keyPair = generateKeyPair(tmpDir);

    // 2. Start sshd container
    sshd = startSshdContainer(keyPair.publicKey);

    // 3. Start the e2e harness (proxy, Docker networking, etc.)
    h = new OAuthE2EHarness();
    await h.start();

    // 4. Initialize the SSH subsystem with the harness resolver
    initSSHSystem(
      h.resolver,
      () => undefined,
      () => true,
      h.proxy,
    );

    // 5. Store the SSH credential
    const meta: SSHCredentialMeta = {
      host: sshd.host,
      port: sshd.port,
      username: sshd.username,
      authType: 'key',
      publicKey: keyPair.publicKey,
      hostKey: '*', // accept-any for test (no TOFU delay)
    };
    h.resolver.store(
      'ssh',
      asCredentialScope(SCOPE),
      ALIAS,
      sshToCredential(keyPair.privateKey, meta),
    );
  }, 120_000);

  afterAll(async () => {
    // Disconnect all SSH connections
    try {
      const mgr = getSSHManager();
      await mgr.disconnectAll(asGroupScope(SCOPE));
    } catch {}

    sshd?.stop();
    await h?.stop();

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  it('full loop: connect → use socket → list → disconnect', async () => {
    const proxyHost = detectProxyBind();
    const proxyPort = h.proxyPort;

    // Step 1: Connect via proxy
    const connectResult = await h.runInContainer(
      `curl -sf -X POST -H "Content-Type: application/json" ` +
        `-d '{"alias":"${ALIAS}"}' ` +
        `http://${proxyHost}:${proxyPort}/ssh/connect`,
      { scope: SCOPE, timeoutMs: 30_000 },
    );

    expect(connectResult.exitCode).toBe(0);
    const connectBody = JSON.parse(connectResult.stdout.trim());
    expect(connectBody.status).toBe('ok');
    expect(connectBody.usage).toContain(ALIAS);

    // Step 2: Verify socket exists in container
    const lsResult = await h.runInContainer(
      `ls -la /ssh-sockets/`,
      { scope: SCOPE, timeoutMs: 10_000 },
    );
    expect(lsResult.stdout).toContain(`${ALIAS}.sock`);

    // Step 3: ssh — run a command through the ControlMaster socket
    const dest = `${sshd.username}@${sshd.host}`;
    const sshResult = await h.runInContainer(
      `ssh -o ControlPath=/ssh-sockets/${ALIAS}.sock _ whoami`,
      { scope: SCOPE, timeoutMs: 15_000 },
    );
    expect(sshResult.exitCode).toBe(0);
    expect(sshResult.stdout.trim()).toBe(sshd.username);

    // Step 4: scp — copy a file to the remote and verify it arrived
    const scpResult = await h.runInContainer(
      `echo "scp-test-content" > /tmp/scp-test.txt && ` +
        `scp -o ControlPath=/ssh-sockets/${ALIAS}.sock /tmp/scp-test.txt ${dest}:/tmp/ && ` +
        `ssh -o ControlPath=/ssh-sockets/${ALIAS}.sock _ cat /tmp/scp-test.txt`,
      { scope: SCOPE, timeoutMs: 15_000 },
    );
    expect(scpResult.exitCode).toBe(0);
    expect(scpResult.stdout.trim()).toBe('scp-test-content');

    // Step 5: List connections via proxy
    const listResult = await h.runInContainer(
      `curl -sf http://${proxyHost}:${proxyPort}/ssh/connections`,
      { scope: SCOPE, timeoutMs: 10_000 },
    );
    const listBody = JSON.parse(listResult.stdout.trim());
    expect(listBody.status).toBe('ok');
    expect(listBody.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: ALIAS }),
      ]),
    );

    // Step 6: Disconnect via proxy
    const disconnectResult = await h.runInContainer(
      `curl -sf -X POST -H "Content-Type: application/json" ` +
        `-d '{"alias":"${ALIAS}"}' ` +
        `http://${proxyHost}:${proxyPort}/ssh/disconnect`,
      { scope: SCOPE, timeoutMs: 10_000 },
    );
    const disconnectBody = JSON.parse(disconnectResult.stdout.trim());
    expect(disconnectBody.status).toBe('ok');

    // Step 7: Verify socket is gone
    const lsAfter = await h.runInContainer(
      `ls /ssh-sockets/ 2>&1 || echo EMPTY`,
      { scope: SCOPE, timeoutMs: 10_000 },
    );
    expect(lsAfter.stdout).not.toContain(`${ALIAS}.sock`);
  }, 90_000);

  it('request-credential returns existing credential', async () => {
    const proxyHost = detectProxyBind();
    const proxyPort = h.proxyPort;

    const result = await h.runInContainer(
      `curl -sf -X POST -H "Content-Type: application/json" ` +
        `-d '{"alias":"${ALIAS}","mode":"ask","connection_host":"${sshd.host}"}' ` +
        `http://${proxyHost}:${proxyPort}/ssh/request-credential`,
      { scope: SCOPE, timeoutMs: 15_000 },
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout.trim());
    expect(body.status).toBe('ok');
    expect(body.publicKey).toContain('ssh-ed25519');
  }, 30_000);
}, 300_000);
