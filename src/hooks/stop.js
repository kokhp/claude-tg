#!/usr/bin/env node

// Stop hook for Claude Code.
// Fires every time Claude finishes a response turn.
// Sends to daemon which debounces per-TTY to avoid subagent spam.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DAEMON_PORT = parseInt(process.env.CLAUDE_TG_PORT || '7483', 10);
const DAEMON_HOST = '127.0.0.1';
const HOOK_LOG = path.join(process.env.HOME, '.claude-telegram-bridge', 'hooks.log');

function hookLog(msg) {
  try {
    const dir = path.dirname(HOOK_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] [stop] ${msg}\n`);
  } catch {}
}

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

    hookLog(`session=${hookInput.session_id} tty=${ttyPath}`);

    await postToDaemon({
      session_id: hookInput.session_id,
      cwd: hookInput.cwd,
      notification_type: 'stop',
      message: hookInput.last_assistant_message || '',
      transcript_path: hookInput.transcript_path,
      tty_path: ttyPath,
    });

    hookLog('Sent to daemon OK');
  } catch (err) {
    hookLog(`ERROR: ${err.message || err}`);
  }
  process.exit(0);
}

main();
