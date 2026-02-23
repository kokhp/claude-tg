const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME, '.claude-telegram-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');

const DEFAULT_CONFIG = {
  botToken: '',
  chatId: '',
  port: 7483,
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { loadConfig, saveConfig, CONFIG_DIR, CONFIG_PATH, PID_PATH, LOG_PATH };
