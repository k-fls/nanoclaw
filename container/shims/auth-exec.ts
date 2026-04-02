/**
 * Auth container shim — compiled by entrypoint.sh in place of agent-runner.
 *
 * Mount this at /app/src/index.ts so the standard entrypoint compiles and
 * runs it. Reads the real command from AUTH_EXEC_CMD (JSON array) and
 * spawns it with inherited stdio, preserving the PTY for interactive
 * OAuth flows.
 */
import { spawn } from 'child_process';

const raw = process.env.AUTH_EXEC_CMD;
if (!raw) {
  process.stderr.write('auth-exec: AUTH_EXEC_CMD not set\n');
  process.exit(1);
}

let cmd: string[];
try {
  cmd = JSON.parse(raw);
} catch {
  process.stderr.write(`auth-exec: invalid AUTH_EXEC_CMD: ${raw}\n`);
  process.exit(1);
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  process.stderr.write(`auth-exec: ${err.message}\n`);
  process.exit(1);
});
