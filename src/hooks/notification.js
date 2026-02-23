#!/usr/bin/env node

// Notification hook for Claude Code.
// Detects parent TTY, reads hook input from stdin, fires POST to daemon, exits.

const http = require('http');
const { execSync } = require('child_process');

const DAEMON_PORT = 7483;
const DAEMON_HOST = '127.0.0.1';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Walk up the process tree to find the TTY of the Claude process.
 * Hook process itself has tty=??, but the Claude parent has a real TTY.
 */
function findTty() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 10; i++) {
      const tty = execSync(`ps -o tty= -p ${pid} 2>/dev/null`).toString().trim();
      if (tty && tty !== '??' && tty !== '') {
        return `/dev/${tty}`;
      }
      const ppid = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`).toString().trim();
      if (!ppid || ppid === '0' || ppid === '1') break;
      pid = parseInt(ppid);
    }
  } catch {}
  return null;
}

function postToDaemon(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path: '/api/notify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    const input = await readStdin();
    const hookInput = input.hookInput || input;
    const ttyPath = findTty();

    await postToDaemon({
      session_id: hookInput.session_id,
      cwd: hookInput.cwd,
      notification_type: hookInput.notification_type || hookInput.type,
      message: hookInput.message,
      transcript_path: hookInput.transcript_path,
      tty_path: ttyPath,
    });
  } catch {
    // Daemon unreachable — silently ignore
  }
  process.exit(0);
}

main();
