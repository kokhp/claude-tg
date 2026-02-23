#!/usr/bin/env node

const { Command } = require('commander');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig, PID_PATH, LOG_PATH, CONFIG_DIR } = require('../src/config');

const program = new Command();

program
  .name('claude-tg')
  .description('Claude Code ↔ Telegram Bridge')
  .version('1.0.0');

program
  .command('setup')
  .description('Interactive setup: bot token, chat ID, hook installation')
  .action(async () => {
    const { run } = require('../src/setup');
    await run();
  });

const daemon = program.command('daemon').description('Manage the background daemon');

daemon
  .command('start')
  .description('Start the daemon as a background process')
  .action(() => {
    const config = loadConfig();
    if (!config.botToken || !config.chatId) {
      console.error('Not configured. Run: claude-tg setup');
      process.exit(1);
    }

    // Check if already running
    if (fs.existsSync(PID_PATH)) {
      const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Daemon already running (PID ${pid})`);
        return;
      } catch {
        // PID file stale, remove it
        fs.unlinkSync(PID_PATH);
      }
    }

    // Ensure config dir exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const logFd = fs.openSync(LOG_PATH, 'a');
    const daemonPath = path.resolve(__dirname, '..', 'src', 'daemon.js');

    const child = spawn('node', [daemonPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });

    fs.writeFileSync(PID_PATH, child.pid.toString());
    child.unref();
    fs.closeSync(logFd);

    console.log(`Daemon started (PID ${child.pid})`);
    console.log(`Logs: ${LOG_PATH}`);
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    if (!fs.existsSync(PID_PATH)) {
      console.log('Daemon is not running.');
      return;
    }
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_PATH);
      console.log(`Daemon stopped (PID ${pid})`);
    } catch (err) {
      if (err.code === 'ESRCH') {
        fs.unlinkSync(PID_PATH);
        console.log('Daemon was not running (stale PID file removed).');
      } else {
        console.error(`Failed to stop daemon: ${err.message}`);
      }
    }
  });

daemon
  .command('status')
  .description('Check if daemon is running')
  .action(() => {
    if (!fs.existsSync(PID_PATH)) {
      console.log('Daemon is not running.');
      return;
    }
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`Daemon is running (PID ${pid})`);

      // Try health check
      const http = require('http');
      const config = loadConfig();
      const req = http.get(`http://127.0.0.1:${config.port}/api/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const health = JSON.parse(data);
            console.log(`Pending requests: ${health.pending}`);
          } catch {}
        });
      });
      req.on('error', () => {});
      req.setTimeout(2000, () => req.destroy());
    } catch {
      fs.unlinkSync(PID_PATH);
      console.log('Daemon is not running (stale PID file removed).');
    }
  });

daemon
  .command('logs')
  .description('Tail daemon log file')
  .action(() => {
    if (!fs.existsSync(LOG_PATH)) {
      console.log('No log file found.');
      return;
    }
    try {
      execSync(`tail -f ${LOG_PATH}`, { stdio: 'inherit' });
    } catch {
      // User pressed Ctrl+C
    }
  });

// --- Send commands (stateless, no daemon needed) ---

function createTelegramClient() {
  const config = loadConfig();
  if (!config.botToken || !config.chatId) {
    console.error('Not configured. Run: claude-tg setup');
    process.exit(1);
  }
  const { Telegram } = require('telegraf');
  return { client: new Telegram(config.botToken), chatId: config.chatId };
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

program
  .command('send')
  .argument('<text>', 'Text to send, or "-" to read from stdin')
  .description('Send a text message to Telegram')
  .action(async (text) => {
    try {
      if (text === '-') {
        text = await readAllStdin();
      }

      if (!text.trim()) {
        console.error('No text to send.');
        process.exit(1);
      }

      const { client, chatId } = createTelegramClient();

      if (text.length <= 4096) {
        await client.sendMessage(chatId, text);
        console.log('Message sent.');
      } else {
        // Long text — send as a document
        const tmpFile = path.join(require('os').tmpdir(), `claude-tg-${Date.now()}.md`);
        fs.writeFileSync(tmpFile, text);
        const { Input } = require('telegraf');
        await client.sendDocument(chatId, Input.fromLocalFile(tmpFile, 'message.md'), {
          caption: `Message from Claude (${text.length} chars)`,
        });
        fs.unlinkSync(tmpFile);
        console.log('Message sent as document.');
      }
    } catch (err) {
      console.error(`Send failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('send-file')
  .argument('<filepath>', 'Path to file')
  .argument('[caption]', 'Optional caption')
  .description('Send a file to Telegram')
  .action(async (filepath, caption) => {
    try {
      const resolved = path.resolve(filepath);
      if (!fs.existsSync(resolved)) {
        console.error(`File not found: ${resolved}`);
        process.exit(1);
      }

      const stat = fs.statSync(resolved);
      if (stat.size > 50 * 1024 * 1024) {
        console.error('File exceeds 50MB Telegram limit.');
        process.exit(1);
      }

      const { client, chatId } = createTelegramClient();
      const { Input } = require('telegraf');
      const filename = path.basename(resolved);
      const extra = caption ? { caption } : {};
      const ext = path.extname(resolved).toLowerCase();

      const photoExts = ['.jpg', '.jpeg', '.png', '.webp'];
      const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
      const gifExts = ['.gif'];
      const audioExts = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac'];

      const source = Input.fromLocalFile(resolved, filename);

      if (photoExts.includes(ext)) {
        await client.sendPhoto(chatId, source, extra);
      } else if (videoExts.includes(ext)) {
        await client.sendVideo(chatId, source, extra);
      } else if (gifExts.includes(ext)) {
        await client.sendAnimation(chatId, source, extra);
      } else if (audioExts.includes(ext)) {
        await client.sendAudio(chatId, source, extra);
      } else {
        await client.sendDocument(chatId, source, extra);
      }
      console.log(`File sent: ${filename}`);
    } catch (err) {
      console.error(`Send failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Test the full chain: config, daemon, hooks, Telegram')
  .action(async () => {
    const http = require('http');
    let ok = true;

    // 1. Config
    console.log('\n--- Config ---');
    const config = loadConfig();
    if (config.botToken && config.chatId) {
      console.log(`  Bot token: ${config.botToken.slice(0, 8)}...`);
      console.log(`  Chat ID: ${config.chatId}`);
      console.log(`  Port: ${config.port}`);
    } else {
      console.log('  NOT CONFIGURED. Run: claude-tg setup');
      ok = false;
    }

    // 2. Hooks
    console.log('\n--- Hooks ---');
    const settingsPath = path.join(process.env.HOME, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const hooks = settings.hooks || {};

        const permHooks = hooks.PermissionRequest || [];
        const permCmd = permHooks[0]?.hooks?.[0]?.command || 'NOT FOUND';
        console.log(`  PermissionRequest: ${permCmd}`);
        if (permCmd !== 'NOT FOUND') {
          const scriptPath = permCmd.replace(/^node\s+/, '');
          if (fs.existsSync(scriptPath)) {
            console.log('    File exists: YES');
          } else {
            console.log(`    File exists: NO — ${scriptPath}`);
            ok = false;
          }
        }

        const notifHooks = hooks.Notification || [];
        const notifCmd = notifHooks[0]?.hooks?.[0]?.command || 'NOT FOUND';
        console.log(`  Notification: ${notifCmd}`);
        if (notifCmd !== 'NOT FOUND') {
          const scriptPath = notifCmd.replace(/^node\s+/, '');
          if (fs.existsSync(scriptPath)) {
            console.log('    File exists: YES');
          } else {
            console.log(`    File exists: NO — ${scriptPath}`);
            ok = false;
          }
        }
      } catch (e) {
        console.log(`  Error reading settings: ${e.message}`);
        ok = false;
      }
    } else {
      console.log('  ~/.claude/settings.json not found. Run: claude-tg setup');
      ok = false;
    }

    // 3. Daemon
    console.log('\n--- Daemon ---');
    try {
      const health = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${config.port}/api/health`, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { reject(new Error('bad response')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      console.log(`  Running: YES (${health.sessions} sessions, ${health.pending} pending)`);
    } catch {
      console.log('  Running: NO — start with: claude-tg daemon start');
      ok = false;
    }

    // 4. Telegram
    console.log('\n--- Telegram ---');
    if (config.botToken && config.chatId) {
      try {
        const { Telegram } = require('telegraf');
        const tg = new Telegram(config.botToken);
        await tg.sendMessage(config.chatId, '🧪 claude-tg test — everything is working!');
        console.log('  Test message sent: YES');
      } catch (err) {
        console.log(`  Test message FAILED: ${err.message}`);
        ok = false;
      }
    } else {
      console.log('  Skipped (no config)');
    }

    // 5. Send test notification to daemon
    if (ok) {
      console.log('\n--- Hook simulation ---');
      try {
        const result = await new Promise((resolve, reject) => {
          const payload = JSON.stringify({
            session_id: 'test-' + Date.now(),
            cwd: process.cwd(),
            notification_type: 'idle_prompt',
            message: 'Test notification from claude-tg test',
            transcript_path: null,
            tty_path: null,
          });
          const req = http.request({
            hostname: '127.0.0.1', port: config.port,
            path: '/api/notify', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 5000,
          }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.write(payload);
          req.end();
        });
        console.log('  Notification sent to daemon: YES');
        console.log('  Check Telegram — you should see a test idle notification');
      } catch (err) {
        console.log(`  Notification FAILED: ${err.message}`);
      }
    }

    console.log(`\n${ok ? 'All checks passed.' : 'Some checks FAILED — fix the issues above.'}\n`);
  });

program
  .command('uninstall')
  .description('Remove hooks from ~/.claude/settings.json')
  .action(() => {
    const { uninstallHooks } = require('../src/setup');
    uninstallHooks();
    console.log('Hooks removed from ~/.claude/settings.json');
  });

program.parse();
