#!/usr/bin/env node

// PermissionRequest hook for Claude Code.
// Reads hook input from stdin, forwards to daemon, blocks until Telegram response.
// On error/timeout: exits 0 with no output → falls back to local dialog.

const http = require('http');
const { execSync } = require('child_process');

const DAEMON_PORT = 7483;
const DAEMON_HOST = '127.0.0.1';

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

function postToDaemon(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 1800000, // 30 minutes — daemon holds until Telegram answer
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
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
    const result = await postToDaemon('/api/permission', {
      session_id: hookInput.session_id,
      cwd: hookInput.cwd,
      tool_name: hookInput.tool_name,
      tool_input: hookInput.tool_input,
      permission_suggestions: hookInput.permission_suggestions,
      transcript_path: hookInput.transcript_path,
      tty_path: ttyPath,
    });

    if (!result || !result.decision) {
      // No decision — fall back to local dialog
      process.exit(0);
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: result.decision,
      },
      statusMessage: 'Waiting for Telegram approval...',
    };

    process.stdout.write(JSON.stringify(output));
  } catch {
    // Daemon unreachable or error — fall back to local dialog
    process.exit(0);
  }
}

main();
