const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { loadConfig, saveConfig } = require('./config');

const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');
const HOOKS_DIR = path.resolve(__dirname, 'hooks');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function telegramApiCall(token, method) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${token}/${method}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getHooksConfig(port) {
  const envPrefix = port !== 7483 ? `CLAUDE_TG_PORT=${port} ` : '';
  // Use absolute path to the node binary that ran setup — ensures hooks work
  // even if node isn't in PATH for non-interactive shells (nvm, fnm, etc.)
  const nodeBin = process.execPath;
  return {
    PermissionRequest: [
      {
        hooks: [
          {
            type: 'command',
            command: `${envPrefix}${nodeBin} ${path.join(HOOKS_DIR, 'permission-request.js')}`,
            timeout: 1800,
            statusMessage: 'Waiting for Telegram approval...',
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: `${envPrefix}${nodeBin} ${path.join(HOOKS_DIR, 'stop.js')}`,
          },
        ],
      },
    ],
  };
}

function installHooks(port) {
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const newHooks = getHooksConfig(port);

  // First: remove ALL our hooks from ALL events (clean slate)
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter((entry) => {
      const hooks = entry.hooks || [];
      return !hooks.some((h) => h.command && (
        h.command.includes('claude-telegram-bridge') || h.command.includes('teleclaude') || h.command.includes('claude-tg')
      ));
    });
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // Then: add our new hooks
  for (const [event, hookConfigs] of Object.entries(newHooks)) {
    const existing = settings.hooks[event] || [];
    settings.hooks[event] = [...existing, ...hookConfigs];
  }

  // Ensure directory exists
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function uninstallHooks() {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    return;
  }

  if (!settings.hooks) return;

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter((entry) => {
      const hooks = entry.hooks || [];
      return !hooks.some((h) => h.command && (
        h.command.includes('claude-telegram-bridge') || h.command.includes('teleclaude') || h.command.includes('claude-tg')
      ));
    });
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

async function run() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const config = loadConfig();

  console.log('\nClaude Telegram Bridge Setup\n');

  // Bot token
  const token = await ask(rl, `Telegram Bot Token${config.botToken ? ' [keep existing]' : ''}: `);
  if (token.trim()) {
    config.botToken = token.trim();
  }
  if (!config.botToken) {
    console.error('Bot token is required. Create one via @BotFather on Telegram.');
    rl.close();
    process.exit(1);
  }

  // Validate token
  console.log('Validating bot token...');
  try {
    const me = await telegramApiCall(config.botToken, 'getMe');
    if (!me.ok) throw new Error(me.description);
    console.log(`Bot: @${me.result.username}`);
  } catch (err) {
    console.error(`Invalid bot token: ${err.message}`);
    rl.close();
    process.exit(1);
  }

  // Chat ID
  if (!config.chatId) {
    console.log('\nSend /start to your bot in Telegram, then press Enter here...');
    await ask(rl, 'Press Enter after sending /start to the bot: ');

    const updates = await telegramApiCall(config.botToken, 'getUpdates?offset=-1');
    if (updates.ok && updates.result.length > 0) {
      const lastUpdate = updates.result[updates.result.length - 1];
      const chat = lastUpdate.message?.chat;
      if (chat) {
        config.chatId = chat.id.toString();
        console.log(`Chat ID captured: ${config.chatId}`);
      }
    }

    if (!config.chatId) {
      const manual = await ask(rl, 'Could not auto-detect. Enter Chat ID manually: ');
      config.chatId = manual.trim();
    }
  } else {
    console.log(`Using existing Chat ID: ${config.chatId}`);
    const change = await ask(rl, 'Change Chat ID? [y/N]: ');
    if (change.toLowerCase() === 'y') {
      console.log('Send /start to your bot in Telegram, then press Enter here...');
      await ask(rl, 'Press Enter after sending /start to the bot: ');
      const updates = await telegramApiCall(config.botToken, 'getUpdates?offset=-1');
      if (updates.ok && updates.result.length > 0) {
        const lastUpdate = updates.result[updates.result.length - 1];
        const chat = lastUpdate.message?.chat;
        if (chat) {
          config.chatId = chat.id.toString();
          console.log(`Chat ID updated: ${config.chatId}`);
        }
      }
    }
  }

  if (!config.chatId) {
    console.error('Chat ID is required.');
    rl.close();
    process.exit(1);
  }

  // Port
  const portStr = await ask(rl, `Daemon port [${config.port}]: `);
  if (portStr.trim()) {
    config.port = parseInt(portStr.trim(), 10);
  }

  // Save config
  saveConfig(config);
  console.log('\nConfig saved.');

  // Install hooks
  installHooks(config.port);
  console.log('Hooks installed into ~/.claude/settings.json');

  // Send test message
  console.log('Sending test message...');
  try {
    const { Telegraf } = require('telegraf');
    const testBot = new Telegraf(config.botToken);
    await testBot.telegram.sendMessage(config.chatId, '✅ Claude Telegram Bridge configured successfully!\n\nRun `teleclaude daemon start` to begin.');
    console.log('Test message sent to Telegram.');
  } catch (err) {
    console.error(`Could not send test message: ${err.message}`);
  }

  console.log('\nSetup complete! Next steps:');
  console.log('  teleclaude daemon start   — Start the daemon');
  console.log('  claude                   — Use Claude as normal\n');

  rl.close();
}

module.exports = { run, installHooks, uninstallHooks };
