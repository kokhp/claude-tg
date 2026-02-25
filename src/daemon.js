const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { Telegraf, Markup } = require('telegraf');
const { fmt, bold, code, pre, italic, link } = require('telegraf/format');
const { loadConfig, saveConfig, LOG_PATH } = require('./config');
const fs = require('fs');
const path = require('path');

let telegraph;

// --- State ---

const pendingQuestions = new Map();
// Key: requestId (UUID)
// Value: { resolve, sessionId, toolName, createdAt, telegramMessageId, permissionSuggestions }

// session_id → { ttyPath, cwd, label (project name), lastActive }
const sessions = new Map();

// session_id → short numeric label (#1, #2, ...) for terminal identification
const sessionLabels = new Map();
let sessionCounter = 0;

// telegramMessageId → { sessionId, type: 'permission' | 'notification' }
const messageToSession = new Map();

// Elicitation state machine
// elicitationId → { sessionId, ttyPath, questions, answers, telegramMessageIds, ... }
const pendingElicitations = new Map();

// Tool status tracking: session_id → { messageId, tools: [{ name, detail, status }] }
const toolStatusMessages = new Map();

// Stop debounce: tty_path → { timer, data, context }
// Waits for silence before sending stop notification (avoids subagent spam)
const pendingStops = new Map();
const STOP_DEBOUNCE_MS = 5000; // 5 seconds of silence = Claude is truly done

let bot;
let config;

// --- Utilities ---

// Non-blocking log using a write stream
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
logStream.on('error', () => {}); // prevent stream errors from crashing

function log(msg) {
  logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function projectLabel(cwd) {
  if (!cwd) return 'unknown';
  return cwd.split('/').filter(Boolean).pop() || 'unknown';
}

function getSessionLabel(sessionId) {
  if (!sessionId) return '?';
  if (!sessionLabels.has(sessionId)) {
    sessionLabels.set(sessionId, ++sessionCounter);
  }
  return sessionLabels.get(sessionId);
}

function shortId(uuid) {
  return uuid.slice(0, 8);
}

function truncate(str, max = 300) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

// --- Telegraph ---

async function ensureTelegraph() {
  if (telegraph) return telegraph;
  try {
    const Telegraph = require('telegraph-node');
    const client = new Telegraph();

    if (config.telegraphAccessToken) {
      telegraph = client;
      return telegraph;
    }

    // Create new account
    const result = await client.createAccount('Claude TG', {
      author_name: 'Claude Code',
      author_url: 'https://github.com/kokhp/teleclaude',
    });

    const token = result?.access_token || result?.result?.access_token;
    if (token) {
      config.telegraphAccessToken = token;
      saveConfig(config);
      telegraph = client;
      log(`Telegraph account created, token saved`);
      return telegraph;
    }
  } catch (err) {
    log(`Telegraph init error: ${err.message}`);
  }
  return null;
}

/**
 * Convert markdown-ish text to Telegraph Node format.
 */
function markdownToTelegraphNodes(text) {
  const nodes = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push({ tag: 'pre', children: [codeLines.join('\n')] });
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      nodes.push({ tag: 'h4', children: [parseInline(line.slice(4))] });
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      nodes.push({ tag: 'h3', children: [parseInline(line.slice(3))] });
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      nodes.push({ tag: 'h3', children: [parseInline(line.slice(2))] });
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // List items
    if (line.match(/^[-*] /)) {
      const listItems = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        listItems.push({ tag: 'li', children: [parseInline(lines[i].replace(/^[-*] /, ''))] });
        i++;
      }
      nodes.push({ tag: 'ul', children: listItems });
      continue;
    }

    // Regular paragraph
    nodes.push({ tag: 'p', children: [parseInline(line)] });
    i++;
  }

  return nodes;
}

function parseInline(text) {
  // Bold **text** → <strong>
  // Inline code `text` → <code>
  // Italic *text* → <em>
  // For simplicity, return as mixed content
  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Inline code
    let match = remaining.match(/^(.*?)`([^`]+)`/);
    if (match) {
      if (match[1]) parts.push(match[1]);
      parts.push({ tag: 'code', children: [match[2]] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Bold
    match = remaining.match(/^(.*?)\*\*([^*]+)\*\*/);
    if (match) {
      if (match[1]) parts.push(match[1]);
      parts.push({ tag: 'strong', children: [match[2]] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic (single *)
    match = remaining.match(/^(.*?)\*([^*]+)\*/);
    if (match) {
      if (match[1]) parts.push(match[1]);
      parts.push({ tag: 'em', children: [match[2]] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    parts.push(remaining);
    break;
  }

  return parts.length === 1 ? parts[0] : parts.flat();
}

/**
 * Create a Telegraph page with the given title and markdown content.
 * Returns the page URL or null on failure.
 */
async function createTelegraphPage(title, content) {
  const client = await ensureTelegraph();
  if (!client) return null;

  try {
    const nodes = markdownToTelegraphNodes(content);
    const result = await client.createPage(
      config.telegraphAccessToken,
      title,
      nodes,
      { author_name: 'Claude Code', return_content: false }
    );

    const url = result?.url || result?.result?.url;
    if (url) {
      log(`Telegraph page created: ${url}`);
      return url;
    }
  } catch (err) {
    log(`Telegraph page creation error: ${err.message}`);
  }
  return null;
}

/**
 * Register/update a session's TTY and metadata.
 */
function trackSession(data) {
  const existing = sessions.get(data.session_id) || {};
  sessions.set(data.session_id, {
    ...existing,
    ttyPath: data.tty_path || existing.ttyPath || null,
    cwd: data.cwd || existing.cwd,
    label: projectLabel(data.cwd || existing.cwd),
    lastActive: Date.now(),
  });
}

/**
 * Check if a TTY has any active processes (terminal is still open + something running).
 * Non-blocking async version to avoid blocking the event loop.
 */
async function isTtyAlive(ttyPath) {
  if (!ttyPath) return false;
  try {
    const ttyName = ttyPath.replace('/dev/', '');
    const { stdout } = await execAsync(`ps -t ${ttyName} -o pid= 2>/dev/null`, { timeout: 2000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Escape a string for use inside AppleScript double-quoted strings.
 */
function escapeAppleScript(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Send text as input to a terminal session identified by its TTY path.
 * Uses osascript to type into the correct terminal tab/session.
 * Tries iTerm2 first, then Terminal.app. Non-blocking (async).
 * Returns { ok: true } on success, { ok: false, error: string } on failure.
 */
async function sendInputToTerminal(ttyPath, text) {
  if (!ttyPath) {
    log('sendInput: no TTY path');
    return { ok: false, error: 'No TTY path for this session' };
  }

  const trimmed = text.trim();
  const escaped = escapeAppleScript(trimmed);

  // Check which terminal apps are running (fast, non-blocking check)
  let itermRunning = false;
  let terminalRunning = false;
  try {
    const { stdout } = await execAsync('ps -c -o comm= | grep -E "^(iTerm2|Terminal)$"', { timeout: 2000 });
    itermRunning = stdout.includes('iTerm2');
    terminalRunning = stdout.includes('Terminal');
  } catch {
    // ps/grep failed, try both
    itermRunning = true;
    terminalRunning = true;
  }

  // Try iTerm2 — write text targets a specific session by TTY, no focus needed
  if (itermRunning) {
    try {
      const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${ttyPath}" then
          tell s to write text "${escaped}"
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`;
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      log(`Sent via iTerm2 to ${ttyPath}: ${truncate(text, 80)}`);
      return { ok: true };
    } catch (err) {
      log(`iTerm2 attempt: ${(err.message || '').slice(0, 100)}`);
    }
  }

  // Try Terminal.app — focus the tab, paste text from clipboard, press Enter
  if (terminalRunning) {
    try {
      const tmpTextFile = '/tmp/teleclaude-input.txt';
      fs.writeFileSync(tmpTextFile, trimmed);

      const script = [
        'tell application "Terminal"',
        '  activate',
        '  repeat with w in windows',
        '    repeat with t in tabs of w',
        `      if tty of t is "${ttyPath}" then`,
        '        set selected tab of w to t',
        '        set index of w to 1',
        '      end if',
        '    end repeat',
        '  end repeat',
        'end tell',
        `do shell script "cat ${tmpTextFile} | /usr/bin/pbcopy"`,
        'delay 0.5',
        'tell application "System Events"',
        '  tell process "Terminal"',
        '    keystroke "v" using command down',
        '    delay 0.3',
        '    key code 36',
        '  end tell',
        'end tell',
      ].join('\n');

      fs.writeFileSync('/tmp/teleclaude-input.scpt', script);
      await execAsync('osascript /tmp/teleclaude-input.scpt', { timeout: 15000 });
      log(`Sent via Terminal.app to ${ttyPath}: ${truncate(text, 80)}`);
      return { ok: true };
    } catch (err) {
      const msg = err.message || err.stderr || '';
      log(`Terminal.app send error: ${msg.slice(0, 200)}`);
      if (msg.includes('assistive') || msg.includes('accessibility') || msg.includes('not allowed')) {
        return { ok: false, error: 'Accessibility permission needed.\nSystem Settings → Privacy & Security → Accessibility → enable Terminal/iTerm2.' };
      }
    }
  }

  log(`sendInput failed: no terminal found for ${ttyPath}`);
  return { ok: false, error: `Could not send to terminal (${ttyPath}). Make sure iTerm2 or Terminal.app is open.` };
}

// --- Transcript reading ---

function tailLines(filePath, n) {
  try {
    const stat = fs.statSync(filePath);
    const bufSize = Math.min(stat.size, n * 2000);
    const buf = Buffer.alloc(bufSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, bufSize, stat.size - bufSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Extract conversation context from transcript JSONL.
 * Returns: { userTask, recentContext }
 */
function extractContext(transcriptPath) {
  if (!transcriptPath) return { userTask: '', recentContext: '' };

  try {
    // First user message = the task
    let userTask = '';
    try {
      const headBuf = Buffer.alloc(Math.min(fs.statSync(transcriptPath).size, 50000));
      const fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.closeSync(fd);
      const headLines = headBuf.toString('utf8').split('\n').filter(Boolean);
      for (const line of headLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.role === 'user') {
            const content = entry.message.content;
            if (typeof content === 'string') {
              userTask = content;
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b) => b.type === 'text');
              if (textBlock) userTask = textBlock.text;
            }
            break;
          }
        } catch {}
      }
    } catch {}

    // Last assistant text = what Claude was doing/said
    let recentContext = '';
    const tailData = tailLines(transcriptPath, 20);
    for (let i = tailData.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(tailData[i]);
        if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            const texts = content
              .filter((b) => b.type === 'text' && b.text?.trim())
              .map((b) => b.text.trim());
            if (texts.length > 0) {
              recentContext = texts.join(' ');
              break;
            }
          }
        }
      } catch {}
    }

    return {
      userTask: truncate(userTask.trim(), 200),
      recentContext: truncate(recentContext.trim(), 300),
    };
  } catch (err) {
    log(`Context extraction error: ${err.message}`);
    return { userTask: '', recentContext: '' };
  }
}

/**
 * Extract AskUserQuestion data from the transcript tail.
 * Returns the questions array or null if not found.
 */
function extractElicitation(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const lines = tailLines(transcriptPath, 30);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (let j = content.length - 1; j >= 0; j--) {
              const block = content[j];
              if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                const questions = block.input?.questions;
                if (questions && Array.isArray(questions) && questions.length > 0) {
                  return questions;
                }
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Message formatting ---

/**
 * Join multiple FmtString objects into one, preserving entities.
 */
function joinFmt(parts) {
  let text = '';
  const entities = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
    } else if (part && typeof part === 'object' && 'text' in part) {
      const offset = text.length;
      text += part.text;
      if (part.entities) {
        for (const e of part.entities) {
          entities.push({ ...e, offset: e.offset + offset });
        }
      }
    }
  }
  return { text, entities };
}

function formatToolDetails(toolName, toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'string') return toolInput;

  switch (toolName) {
    case 'Bash':
      return toolInput.command || '';
    case 'Write':
      return `${toolInput.file_path || ''}\n(new file, ${(toolInput.content || '').length} chars)`;
    case 'Edit': {
      let edit = toolInput.file_path || '';
      if (toolInput.old_string !== undefined) {
        edit += `\n- ${truncate(toolInput.old_string, 80)}\n+ ${truncate(toolInput.new_string, 80)}`;
      }
      return edit;
    }
    case 'Read':
      return toolInput.file_path || '';
    case 'Glob':
      return `${toolInput.pattern}${toolInput.path ? ' in ' + toolInput.path : ''}`;
    case 'Grep':
      return `/${toolInput.pattern}/${toolInput.glob ? ' ' + toolInput.glob : ''}`;
    case 'WebFetch':
      return toolInput.url || '';
    case 'WebSearch':
      return toolInput.query || '';
    case 'Task':
      return `[${toolInput.subagent_type || 'agent'}] ${truncate(toolInput.description || toolInput.prompt || '', 150)}`;
    default:
      return truncate(JSON.stringify(toolInput, null, 2), 400);
  }
}

function formatPermissionMessage(data, context) {
  const label = projectLabel(data.cwd);
  const sessionNum = getSessionLabel(data.session_id);
  const tool = data.tool_name || 'Unknown';
  const details = formatToolDetails(tool, data.tool_input);

  const parts = [];
  parts.push(fmt`📋  ${bold`#${sessionNum} ${label}`}\n━━━━━━━━━━━━━━━━━━━━\n`);

  if (context.userTask) {
    parts.push(fmt`📝 Task: ${italic`${context.userTask}`}\n\n`);
  }
  if (context.recentContext) {
    parts.push(fmt`💭 Doing: ${italic`${context.recentContext}`}\n\n`);
  }

  parts.push(fmt`🔧 ${code`${tool}`}`);
  if (details) {
    // Use pre for multi-line details (commands, diffs), code for single line
    if (details.includes('\n')) {
      parts.push(fmt`\n${pre()`${details}`}`);
    } else {
      parts.push(fmt`\n${code`${details}`}`);
    }
  }

  return joinFmt(parts);
}

async function formatNotification(data, context) {
  const label = projectLabel(data.cwd);
  const sessionNum = getSessionLabel(data.session_id);
  const type = data.notification_type || data.type || 'notification';
  const session = sessions.get(data.session_id);
  const canReply = !!(session && session.ttyPath);

  const parts = [];

  if (type === 'stop') {
    parts.push(fmt`📩  ${bold`#${sessionNum} ${label}`} — Claude responded\n`);
  } else if (type === 'idle_prompt') {
    parts.push(fmt`⏳  ${bold`#${sessionNum} ${label}`} — Claude is idle\n`);
  } else if (type === 'elicitation_dialog') {
    parts.push(fmt`💬  ${bold`#${sessionNum} ${label}`} — Claude has a question\n`);
  } else {
    parts.push(fmt`🔔  ${bold`#${sessionNum} ${label}`} — ${type}\n`);
  }

  parts.push(fmt`━━━━━━━━━━━━━━━━━━━━\n`);

  if (context.userTask) {
    parts.push(fmt`📝 Task: ${italic`${context.userTask}`}\n\n`);
  }

  // For stop events, always create Telegraph page with full response
  if (type === 'stop' && data.message) {
    const preview = truncate(data.message, 200);
    parts.push(fmt`💬 ${preview}\n\n`);

    const telegraphUrl = await createTelegraphPage(
      `#${sessionNum} ${label} — Claude`,
      data.message
    );
    if (telegraphUrl) {
      parts.push(fmt`📄 Full response: ${telegraphUrl}\n`);
    }
  } else if (context.recentContext) {
    parts.push(fmt`💬 Claude said:\n${context.recentContext}\n`);
  }

  if (canReply) {
    parts.push(fmt`\n↩️ Reply to this message to send input`);
  } else {
    parts.push(fmt`\nOpen your terminal to respond.`);
  }

  return joinFmt(parts);
}

/**
 * Format tool status message showing live progress of Claude's tool usage.
 */
function formatToolStatus(sessionId, tools) {
  const session = sessions.get(sessionId);
  const label = session?.label || 'unknown';
  const sessionNum = getSessionLabel(sessionId);

  const parts = [];
  parts.push(fmt`🔧 ${bold`#${sessionNum} ${label}`} — Working...\n━━━━━━━━━━━━━━━━━━━━\n`);

  for (const tool of tools) {
    const icon = tool.status === 'done' ? '✅' : '🔄';
    parts.push(fmt`${icon} ${code`${tool.name}`}${tool.detail ? ': ' + tool.detail : ''}\n`);
  }

  return joinFmt(parts);
}

// --- Elicitation UI ---

/**
 * Send the next unanswered question for an elicitation to Telegram.
 */
async function sendElicitationQuestion(elicId) {
  const elic = pendingElicitations.get(elicId);
  if (!elic) return;

  const qIdx = elic.answers.size;
  if (qIdx >= elic.questions.length) {
    await sendElicitationSummary(elicId);
    return;
  }

  const q = elic.questions[qIdx];
  const sessionNum = getSessionLabel(elic.sessionId);
  const session = sessions.get(elic.sessionId);
  const label = session?.label || 'unknown';
  const total = elic.questions.length;
  const eid = shortId(elicId);

  let msg = `💬  #${sessionNum} ${label} — Claude has a question\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (elic.userTask) msg += `📝 Task: ${elic.userTask}\n\n`;
  msg += `❓ [${qIdx + 1}/${total}] ${q.question}`;
  if (q.multiSelect) msg += `  (select multiple)`;
  msg += `\n`;

  for (const opt of q.options) {
    if (opt.description) {
      msg += `\n• ${opt.label}: ${opt.description}`;
    }
  }

  const buttons = q.options.map((opt, optIdx) =>
    Markup.button.callback(opt.label, `e:${eid}:${qIdx}:${optIdx}`)
  );
  buttons.push(Markup.button.callback('✏️ Custom', `e:${eid}:${qIdx}:custom`));

  if (q.multiSelect) {
    buttons.push(Markup.button.callback('Next ➡️', `e:${eid}:${qIdx}:done`));
  }

  // Arrange in rows of 2
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  const keyboard = Markup.inlineKeyboard(rows);
  try {
    const sent = await bot.telegram.sendMessage(config.chatId, msg, keyboard);
    elic.telegramMessageIds.push(sent.message_id);
    elic.currentMessageId = sent.message_id;
  } catch (err) {
    log(`Elicitation question send failed: ${err.message}`);
  }
}

/**
 * Send a summary of all answers with Confirm/Redo buttons.
 */
async function sendElicitationSummary(elicId) {
  const elic = pendingElicitations.get(elicId);
  if (!elic) return;

  const sessionNum = getSessionLabel(elic.sessionId);
  const session = sessions.get(elic.sessionId);
  const label = session?.label || 'unknown';
  const eid = shortId(elicId);

  let msg = `📋  #${sessionNum} ${label} — Your answers\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  for (let i = 0; i < elic.questions.length; i++) {
    const q = elic.questions[i];
    const a = elic.answers.get(i);
    let answerText;
    if (a?.isCustom) {
      answerText = `"${a.customText}"`;
    } else if (a?.multiSelections) {
      answerText = a.multiSelections.map((s) => s.label).join(', ');
    } else {
      answerText = a?.label || '?';
    }
    msg += `${i + 1}. ${q.header || q.question}: ${answerText}\n`;
  }

  const summaryButtons = [
    Markup.button.callback('✅ Confirm', `e:${eid}:confirm`),
    Markup.button.callback('🔄 Redo', `e:${eid}:redo`),
  ];
  if (elic.isPermission) {
    summaryButtons.push(Markup.button.callback('❌ Deny', `e:${eid}:deny`));
  }
  const keyboard = Markup.inlineKeyboard(summaryButtons);

  try {
    const sent = await bot.telegram.sendMessage(config.chatId, msg, keyboard);
    elic.telegramMessageIds.push(sent.message_id);
  } catch (err) {
    log(`Elicitation summary send failed: ${err.message}`);
  }
}

/**
 * Handle an elicitation callback query (prefix "e:").
 */
async function handleElicitationCallback(ctx, cbData) {
  const parts = cbData.split(':');
  const eid = parts[1];

  let elicId;
  for (const [id] of pendingElicitations) {
    if (shortId(id) === eid) {
      elicId = id;
      break;
    }
  }

  if (!elicId) {
    try { await ctx.answerCbQuery('Expired or already answered.'); } catch {}
    return;
  }

  const elic = pendingElicitations.get(elicId);

  // Confirm
  if (parts[2] === 'confirm') {
    try { await ctx.answerCbQuery('Sending answers...'); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}

    if (elic.isPermission && elic.permissionResolve) {
      // From permission request — allow the tool, then inject answers after UI appears
      elic.permissionResolve({ decision: 'allow' });
      try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Answers submitted — injecting...'); } catch {}

      setTimeout(async () => {
        const ok = await injectElicitationAnswers(elic.ttyPath, elic.questions, elic.answers);
        log(`Elicitation ${elicId}: ${ok ? 'keystrokes injected' : 'injection failed'}`);
        if (!ok) {
          bot.telegram.sendMessage(config.chatId, '⚠️ Could not inject answers into terminal').catch(() => {});
        }
      }, 2000);
    } else {
      // From notification flow — inject immediately
      const ok = await injectElicitationAnswers(elic.ttyPath, elic.questions, elic.answers);
      try {
        await ctx.editMessageText(ctx.callbackQuery.message.text +
          (ok ? '\n\n✅ Answers submitted' : '\n\n⚠️ Could not send to terminal'));
      } catch {}
    }

    pendingElicitations.delete(elicId);
    log(`Elicitation ${elicId}: confirmed`);
    return;
  }

  // Deny (for permission-based elicitations)
  if (parts[2] === 'deny') {
    try { await ctx.answerCbQuery('Denied'); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ Denied'); } catch {}

    if (elic.isPermission && elic.permissionResolve) {
      elic.permissionResolve({ decision: 'deny' });
    }

    pendingElicitations.delete(elicId);
    log(`Elicitation ${elicId}: denied`);
    return;
  }

  // Redo
  if (parts[2] === 'redo') {
    try { await ctx.answerCbQuery('Starting over...'); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    elic.answers.clear();
    if (elic.multiToggles) elic.multiToggles.clear();
    await sendElicitationQuestion(elicId);
    log(`Elicitation ${elicId}: redo`);
    return;
  }

  const qIdx = parseInt(parts[2]);
  const optAction = parts[3];
  const q = elic.questions[qIdx];

  if (!q) {
    try { await ctx.answerCbQuery('Invalid question.'); } catch {}
    return;
  }

  // Custom answer
  if (optAction === 'custom') {
    try { await ctx.answerCbQuery('Type your answer...'); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✏️ Selected: Custom'); } catch {}

    try {
      const prompt = await bot.telegram.sendMessage(
        config.chatId,
        `✏️ Type your custom answer for: "${q.question}"\n\nReply to this message with your answer.`
      );

      elic.customWaitingMessageId = prompt.message_id;
      elic.customWaitingQIdx = qIdx;
      elic.telegramMessageIds.push(prompt.message_id);
    } catch (err) {
      log(`Elicitation custom prompt send failed: ${err.message}`);
    }
    log(`Elicitation ${elicId}: waiting for custom answer to q${qIdx}`);
    return;
  }

  // MultiSelect "done" — save current toggles and advance
  if (optAction === 'done') {
    const toggles = elic.multiToggles || new Map();
    const selected = toggles.get(qIdx) || new Set();

    if (selected.size === 0) {
      try { await ctx.answerCbQuery('Select at least one option.'); } catch {}
      return;
    }

    const selections = [...selected].sort().map((idx) => ({
      label: q.options[idx].label,
      optionIndex: idx,
    }));

    elic.answers.set(qIdx, {
      label: selections.map((s) => s.label).join(', '),
      optionIndex: selections[0].optionIndex,
      isCustom: false,
      customText: null,
      multiSelections: selections,
    });

    const selLabels = selections.map((s) => s.label).join(', ');
    try { await ctx.answerCbQuery(`Selected: ${selLabels}`); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ Selected: ${selLabels}`); } catch {}

    log(`Elicitation ${elicId}: q${qIdx} multi = [${selLabels}]`);
    await sendElicitationQuestion(elicId);
    return;
  }

  // Regular option
  const optIdx = parseInt(optAction);
  const opt = q.options[optIdx];

  if (!opt) {
    try { await ctx.answerCbQuery('Invalid option.'); } catch {}
    return;
  }

  // MultiSelect — toggle and update buttons
  if (q.multiSelect) {
    if (!elic.multiToggles) elic.multiToggles = new Map();
    if (!elic.multiToggles.has(qIdx)) elic.multiToggles.set(qIdx, new Set());
    const selected = elic.multiToggles.get(qIdx);

    if (selected.has(optIdx)) {
      selected.delete(optIdx);
      try { await ctx.answerCbQuery(`Deselected: ${opt.label}`); } catch {}
    } else {
      selected.add(optIdx);
      try { await ctx.answerCbQuery(`Selected: ${opt.label}`); } catch {}
    }

    // Rebuild buttons with selection indicators
    const buttons = q.options.map((o, i) => {
      const prefix = selected.has(i) ? '✅ ' : '';
      return Markup.button.callback(`${prefix}${o.label}`, `e:${eid}:${qIdx}:${i}`);
    });
    buttons.push(Markup.button.callback('✏️ Custom', `e:${eid}:${qIdx}:custom`));
    buttons.push(Markup.button.callback('Next ➡️', `e:${eid}:${qIdx}:done`));

    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }

    try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup); } catch {}
    return;
  }

  // Single select — save and advance
  elic.answers.set(qIdx, {
    label: opt.label,
    optionIndex: optIdx,
    isCustom: false,
    customText: null,
    multiSelections: null,
  });

  try { await ctx.answerCbQuery(`Selected: ${opt.label}`); } catch {}
  try { await ctx.editMessageReplyMarkup(undefined); } catch {}
  try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ Selected: ${opt.label}`); } catch {}

  log(`Elicitation ${elicId}: q${qIdx} = ${opt.label}`);
  await sendElicitationQuestion(elicId);
}

/**
 * Inject elicitation answers into the terminal via osascript keystrokes.
 * Navigates the AskUserQuestion form using arrow keys, space, tab, and enter.
 */
async function injectElicitationAnswers(ttyPath, questions, answers) {
  if (!ttyPath) {
    log('injectElicitation: no TTY path');
    return false;
  }

  // Build sequence of key events
  const events = [];

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    const answer = answers.get(qIdx);
    if (!answer) continue;

    if (answer.isCustom) {
      const otherPos = q.options.length;
      for (let i = 0; i < otherPos; i++) {
        events.push({ type: 'key_code', value: 125 }); // arrow down
      }
      events.push({ type: 'key_code', value: 36 }); // enter to select Other
      events.push({ type: 'delay', value: 0.3 });
      events.push({ type: 'keystroke', value: answer.customText });
    } else if (answer.multiSelections) {
      const selectedSet = new Set(answer.multiSelections.map((s) => s.optionIndex));
      for (let i = 0; i < q.options.length; i++) {
        if (selectedSet.has(i)) {
          events.push({ type: 'keystroke', value: ' ' });
        }
        if (i < q.options.length - 1) {
          events.push({ type: 'key_code', value: 125 });
        }
      }
    } else {
      for (let i = 0; i < answer.optionIndex; i++) {
        events.push({ type: 'key_code', value: 125 });
      }
    }

    if (qIdx < questions.length - 1) {
      events.push({ type: 'key_code', value: 48 }); // tab
      events.push({ type: 'delay', value: 0.15 });
    }
  }

  events.push({ type: 'delay', value: 0.3 });
  events.push({ type: 'key_code', value: 36 }); // Return key

  const keyLines = events.map((e) => {
    if (e.type === 'key_code') return `    key code ${e.value}`;
    if (e.type === 'keystroke') {
      if (e.value === 'return') return '    keystroke return';
      if (e.value === ' ') return '    keystroke " "';
      return `    keystroke "${escapeAppleScript(e.value)}"`;
    }
    if (e.type === 'delay') return `    delay ${e.value}`;
    return '';
  }).join('\n');

  // Try iTerm2 first
  try {
    const script = [
      'tell application "iTerm2"',
      '  activate',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      `        if tty of s is "${ttyPath}" then`,
      '          select s',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      'end tell',
      'delay 0.5',
      'tell application "System Events"',
      '  tell process "iTerm2"',
      keyLines,
      '  end tell',
      'end tell',
    ].join('\n');

    fs.writeFileSync('/tmp/teleclaude-elicit.scpt', script);
    await execAsync('osascript /tmp/teleclaude-elicit.scpt', { timeout: 30000 });
    log(`Elicitation keystrokes sent via iTerm2 to ${ttyPath}`);
    return true;
  } catch {}

  // Try Terminal.app
  try {
    const script = [
      'tell application "Terminal"',
      '  activate',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      `      if tty of t is "${ttyPath}" then`,
      '        set selected tab of w to t',
      '        set index of w to 1',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
      'delay 0.5',
      'tell application "System Events"',
      '  tell process "Terminal"',
      keyLines,
      '  end tell',
      'end tell',
    ].join('\n');

    fs.writeFileSync('/tmp/teleclaude-elicit.scpt', script);
    await execAsync('osascript /tmp/teleclaude-elicit.scpt', { timeout: 30000 });
    log(`Elicitation keystrokes sent via Terminal.app to ${ttyPath}`);
    return true;
  } catch (err) {
    log(`Terminal.app elicitation error: ${err.message}`);
  }

  log(`injectElicitation failed: no terminal found for ${ttyPath}`);
  return false;
}

// --- File download ---

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve, reject);
      }
      response.pipe(file);
      file.on('finish', () => { file.close(resolve); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Route a Telegram message to the correct session.
 * Returns sessionId or null (with error reply sent).
 */
async function routeToSession(ctx, replyToMessageId) {
  let targetSessionId = null;

  // If replying to a specific message, route to that session
  if (replyToMessageId) {
    const mapping = messageToSession.get(replyToMessageId);
    if (mapping) {
      targetSessionId = mapping.sessionId;
    }

    // Fallback: parse session number from replied-to message text
    if (!targetSessionId && ctx.message.reply_to_message?.text) {
      const match = ctx.message.reply_to_message.text.match(/#(\d+)\s/);
      if (match) {
        const num = parseInt(match[1]);
        for (const [sid] of sessions) {
          if (getSessionLabel(sid) === num) {
            targetSessionId = sid;
            break;
          }
        }
      }
    }
  }

  // Auto-route: find single active session
  if (!targetSessionId) {
    const activeSessions = [];
    for (const [sid, s] of sessions) {
      if (s.ttyPath && await isTtyAlive(s.ttyPath)) {
        activeSessions.push(sid);
      }
    }

    if (activeSessions.length === 1) {
      targetSessionId = activeSessions[0];
    } else if (activeSessions.length === 0) {
      try { await ctx.reply('No active Claude sessions.'); } catch {}
      return null;
    } else {
      const labels = activeSessions.map((sid) => {
        const s = sessions.get(sid);
        const num = getSessionLabel(sid);
        return `  #${num} ${s?.label || 'unknown'}`;
      }).join('\n');
      try { await ctx.reply(`Multiple sessions active. Reply to a specific notification:\n\n${labels}`); } catch {}
      return null;
    }
  }

  return targetSessionId;
}

// --- Telegram bot ---

function startBot() {
  bot = new Telegraf(config.botToken);

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    try { await ctx.reply(`Chat ID registered: ${chatId}\n\nThis chat will receive Claude Code permission requests.`); } catch {}
    log(`/start from chat ${chatId}`);
  });

  bot.command('status', async (ctx) => {
    const pendingCount = pendingQuestions.size;
    const allSessions = [...sessions.entries()];
    const activeSessions = [];
    for (const [sid, s] of allSessions) {
      if (s.ttyPath) {
        if (await isTtyAlive(s.ttyPath)) activeSessions.push([sid, s]);
      } else if (Date.now() - s.lastActive < 60 * 60 * 1000) {
        activeSessions.push([sid, s]);
      }
    }

    let msg = '';
    if (activeSessions.length === 0 && pendingCount === 0) {
      try { await ctx.reply('No active sessions or pending requests.'); } catch {}
      return;
    }

    if (activeSessions.length > 0) {
      msg += `${activeSessions.length} active session(s):\n`;
      for (const [sid, s] of activeSessions) {
        const num = getSessionLabel(sid);
        const tty = s.ttyPath ? s.ttyPath.split('/').pop() : 'no tty';
        msg += `  #${num} ${s.label} (${tty})\n`;
      }
    }

    if (pendingCount > 0) {
      msg += `\n${pendingCount} pending permission(s):\n`;
      for (const [id, q] of pendingQuestions) {
        const age = Math.round((Date.now() - q.createdAt) / 1000 / 60);
        const sLabel = getSessionLabel(q.sessionId);
        msg += `  #${sLabel} ${q.toolName} (${age}m ago)\n`;
      }
    }

    if (pendingElicitations.size > 0) {
      msg += `\n${pendingElicitations.size} pending elicitation(s):\n`;
      for (const [, elic] of pendingElicitations) {
        const sLabel = getSessionLabel(elic.sessionId);
        msg += `  #${sLabel} ${elic.answers.size}/${elic.questions.length} answered\n`;
      }
    }

    try { await ctx.reply(msg); } catch {}
  });

  // Handle inline keyboard button presses (permission decisions + elicitations)
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    // Route elicitation callbacks
    if (data.startsWith('e:')) {
      await handleElicitationCallback(ctx, data);
      return;
    }

    const [rid, action] = data.split(':');
    let requestId;
    for (const [id] of pendingQuestions) {
      if (shortId(id) === rid) {
        requestId = id;
        break;
      }
    }

    if (!requestId) {
      try { await ctx.answerCbQuery('Request expired or already answered.'); } catch {}
      return;
    }

    const pending = pendingQuestions.get(requestId);
    pendingQuestions.delete(requestId);

    let label;
    if (action === 'allow') {
      label = '✅ Allowed';
      pending.resolve({ decision: 'allow' });
    } else if (action === 'deny') {
      label = '❌ Denied';
      pending.resolve({ decision: 'deny' });
    } else if (action === 'always') {
      label = '✅ Always Allowed';
      pending.resolve({ decision: 'always' });
    } else {
      label = '❌ Denied';
      pending.resolve({ decision: 'deny' });
    }

    try { await ctx.answerCbQuery(label); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n${label}`); } catch {}
    log(`Answered ${requestId}: ${action}`);
  });

  // Handle text messages — route as user input to a terminal
  bot.on('text', async (ctx) => {
    // Ignore commands
    if (ctx.message.text.startsWith('/')) return;

    const text = ctx.message.text;
    const replyTo = ctx.message.reply_to_message?.message_id;

    // Check if this is a reply to a custom elicitation answer prompt
    if (replyTo) {
      for (const [elicId, elic] of pendingElicitations) {
        if (elic.customWaitingMessageId === replyTo) {
          const qIdx = elic.customWaitingQIdx;
          const q = elic.questions[qIdx];

          elic.answers.set(qIdx, {
            label: text,
            optionIndex: q.options.length, // "Other" position
            isCustom: true,
            customText: text,
            multiSelections: null,
          });

          elic.customWaitingMessageId = null;
          elic.customWaitingQIdx = null;

          try { await ctx.reply(`✅ Custom answer for "${q.question}": ${text}`); } catch {}
          log(`Elicitation ${elicId}: q${qIdx} custom = "${text}"`);

          await sendElicitationQuestion(elicId);
          return;
        }
      }
    }

    let targetSessionId = null;

    // If replying to a specific message, route to that session
    if (replyTo) {
      const mapping = messageToSession.get(replyTo);
      if (mapping) {
        if (mapping.type === 'permission') {
          try { await ctx.reply('⚠️ That was a permission request — use the buttons above.\nTo send text input, reply to a notification message.'); } catch {}
          return;
        }
        targetSessionId = mapping.sessionId;
      }

      // Fallback: parse session number from the replied-to message text (survives daemon restarts)
      if (!targetSessionId && ctx.message.reply_to_message?.text) {
        const match = ctx.message.reply_to_message.text.match(/#(\d+)\s/);
        if (match) {
          const num = parseInt(match[1]);
          for (const [sid] of sessions) {
            if (getSessionLabel(sid) === num) {
              targetSessionId = sid;
              break;
            }
          }
        }
      }
    }

    // If no reply-to, try auto-routing
    if (!targetSessionId) {
      // Find sessions that have notifications and are still alive (TTY exists)
      const allNotifs = [...messageToSession.entries()].filter(([, m]) => m.type === 'notification');
      const recentNotifications = [];
      for (const [, m] of allNotifs) {
        const s = sessions.get(m.sessionId);
        if (s?.ttyPath) {
          if (await isTtyAlive(s.ttyPath)) recentNotifications.push(m.sessionId);
        } else if (Date.now() - m.createdAt < 60 * 60 * 1000) {
          recentNotifications.push(m.sessionId);
        }
      }

      const uniqueSessions = [...new Set(recentNotifications)];

      if (uniqueSessions.length === 1) {
        targetSessionId = uniqueSessions[0];
      } else if (uniqueSessions.length === 0) {
        try { await ctx.reply('No idle Claude sessions to send input to.'); } catch {}
        return;
      } else {
        // Multiple sessions — ask user to be specific
        const labels = uniqueSessions.map((sid) => {
          const s = sessions.get(sid);
          const num = getSessionLabel(sid);
          return `  #${num} ${s?.label || 'unknown'}`;
        }).join('\n');
        try { await ctx.reply(`Multiple sessions are waiting. Reply to a specific notification message to choose:\n\n${labels}`); } catch {}
        return;
      }
    }

    // Send the text to the terminal
    const session = sessions.get(targetSessionId);
    if (!session || !session.ttyPath) {
      try { await ctx.reply(`⚠️ No TTY for session #${getSessionLabel(targetSessionId)}. Open the terminal to respond.`); } catch {}
      return;
    }

    const result = await sendInputToTerminal(session.ttyPath, text);
    if (result.ok) {
      const num = getSessionLabel(targetSessionId);
      try { await ctx.reply(`➡️ Sent to #${num} ${session.label}`); } catch {}
    } else {
      try { await ctx.reply(`⚠️ ${result.error}`); } catch {}
    }
  });

  // Handle photo messages — save to active session's project directory
  bot.on('photo', async (ctx) => {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1]; // highest resolution
    const caption = ctx.message.caption || '';
    const replyTo = ctx.message.reply_to_message?.message_id;

    // Route to session
    const sessionId = await routeToSession(ctx, replyTo);
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session?.cwd) {
      try { await ctx.reply('⚠️ No working directory for this session.'); } catch {}
      return;
    }

    // Check file size (20MB limit)
    if (photo.file_size && photo.file_size > 20 * 1024 * 1024) {
      try { await ctx.reply('⚠️ File too large (>20MB).'); } catch {}
      return;
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const filename = `telegram-photo-${Date.now()}.jpg`;
      const filePath = path.join(session.cwd, filename);

      await downloadFile(fileLink.href, filePath);

      const sessionNum = getSessionLabel(sessionId);
      try {
        await ctx.reply(`✅ Saved to ${filename} in #${sessionNum} ${session.label}`);
      } catch {}

      // Notify Claude about the file
      if (session.ttyPath) {
        const inputText = caption
          ? `I've uploaded an image at ./${filename} — ${caption}`
          : `I've uploaded an image at ./${filename}`;
        await sendInputToTerminal(session.ttyPath, inputText);
      }

      log(`Photo saved: ${filePath} for session ${sessionId}`);
    } catch (err) {
      log(`Photo download error: ${err.message}`);
      try { await ctx.reply(`⚠️ Failed to save photo: ${err.message}`); } catch {}
    }
  });

  // Handle document/file messages — save with original filename
  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || '';
    const replyTo = ctx.message.reply_to_message?.message_id;

    // Route to session
    const sessionId = await routeToSession(ctx, replyTo);
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session?.cwd) {
      try { await ctx.reply('⚠️ No working directory for this session.'); } catch {}
      return;
    }

    // Check file size (20MB limit)
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      try { await ctx.reply('⚠️ File too large (>20MB).'); } catch {}
      return;
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const filename = doc.file_name || `telegram-file-${Date.now()}`;
      const filePath = path.join(session.cwd, filename);

      await downloadFile(fileLink.href, filePath);

      const sessionNum = getSessionLabel(sessionId);
      try {
        await ctx.reply(`✅ Saved to ${filename} in #${sessionNum} ${session.label}`);
      } catch {}

      // Notify Claude about the file
      if (session.ttyPath) {
        const inputText = caption
          ? `I've uploaded a file at ./${filename} — ${caption}`
          : `I've uploaded a file at ./${filename}`;
        await sendInputToTerminal(session.ttyPath, inputText);
      }

      log(`Document saved: ${filePath} for session ${sessionId}`);
    } catch (err) {
      log(`Document download error: ${err.message}`);
      try { await ctx.reply(`⚠️ Failed to save file: ${err.message}`); } catch {}
    }
  });

  bot.catch((err) => {
    log(`Bot error: ${err?.message || err}`);
  });

  // Launch polling in background — don't block the HTTP server
  // Note: Telegraf's launch() promise never settles in v4.16 — that's OK,
  // polling starts immediately in the background.
  bot.launch({ dropPendingUpdates: true });
  log('Telegram bot polling started');

  // Send startup notification after brief delay (let polling initialize)
  setTimeout(async () => {
    try {
      await bot.telegram.sendMessage(config.chatId, '🟢 teleclaude daemon started');
      log('Startup notification sent to Telegram');
    } catch (e) {
      log(`Startup notification failed: ${e?.message || e}`);
    }
  }, 2000);
}

/**
 * Periodic health check — verify Telegram connectivity.
 * If bot polling dies silently, restart it.
 */
let healthCheckRestarting = false;
function startHealthCheck() {
  setInterval(async () => {
    if (healthCheckRestarting) return;
    try {
      await bot.telegram.getMe();
    } catch (err) {
      log(`Telegram health check failed: ${err?.message || err}. Restarting bot...`);
      healthCheckRestarting = true;
      try { bot.stop('health_restart'); } catch {}
      // Wait for old polling to fully stop before starting new instance
      setTimeout(() => {
        startBot();
        healthCheckRestarting = false;
      }, 3000);
    }
  }, 3 * 60 * 1000); // every 3 minutes
}

// --- HTTP handlers ---

async function sendPermissionRequest(data) {
  trackSession(data);

  // AskUserQuestion — show actual questions with option buttons instead of Allow/Deny
  if (data.tool_name === 'AskUserQuestion' && data.tool_input?.questions?.length > 0) {
    return handleElicitationPermission(data);
  }

  const requestId = crypto.randomUUID();
  const rid = shortId(requestId);
  const context = extractContext(data.transcript_path);
  const msg = formatPermissionMessage(data, context);

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('Allow', `${rid}:allow`),
    Markup.button.callback('Deny', `${rid}:deny`),
    Markup.button.callback('Always Allow', `${rid}:always`),
  ]);

  let sent;
  try {
    sent = await bot.telegram.sendMessage(config.chatId, msg.text, {
      entities: msg.entities,
      ...keyboard,
    });
  } catch (err) {
    log(`Permission send failed: ${err.message}`);
    return { decision: 'allow' }; // Fallback: allow if Telegram unreachable
  }

  // Track this message for reply routing
  messageToSession.set(sent.message_id, {
    sessionId: data.session_id,
    type: 'permission',
    createdAt: Date.now(),
  });

  return new Promise((resolve) => {
    pendingQuestions.set(requestId, {
      resolve,
      sessionId: data.session_id,
      toolName: data.tool_name || 'Unknown',
      createdAt: Date.now(),
      telegramMessageId: sent.message_id,
      permissionSuggestions: data.permission_suggestions,
    });
    log(`Permission request ${requestId} for ${data.tool_name}`);
  });
}

/**
 * Handle AskUserQuestion as an interactive elicitation via Telegram.
 * Returns a promise that resolves with { decision: 'allow' | 'deny' } when user confirms/denies.
 */
function handleElicitationPermission(data) {
  const elicId = crypto.randomUUID();
  const context = extractContext(data.transcript_path);
  const questions = data.tool_input.questions;

  pendingElicitations.set(elicId, {
    sessionId: data.session_id,
    ttyPath: data.tty_path || sessions.get(data.session_id)?.ttyPath,
    questions,
    answers: new Map(),
    multiToggles: new Map(),
    telegramMessageIds: [],
    currentMessageId: null,
    customWaitingMessageId: null,
    customWaitingQIdx: null,
    userTask: context.userTask,
    createdAt: Date.now(),
    isPermission: true,
    permissionResolve: null,
  });

  log(`Elicitation (permission) ${elicId}: ${questions.length} question(s)`);
  sendElicitationQuestion(elicId).catch((e) => log(`Elicitation send error: ${e.message}`));

  return new Promise((resolve) => {
    const elic = pendingElicitations.get(elicId);
    elic.permissionResolve = resolve;
  });
}

async function sendNotification(data) {
  const notifType = data.notification_type || data.type;

  // For stop events, check if session is known BEFORE registering it.
  // Subagent sessions have never-before-seen IDs — skip them.
  if (notifType !== 'stop') {
    trackSession(data);
  }

  // Check if this is an elicitation
  if (notifType === 'elicitation_dialog') {
    // Skip if already handling this session's elicitation via permission request
    for (const [, elic] of pendingElicitations) {
      if (elic.sessionId === data.session_id) {
        log(`Skipping elicitation_dialog — already handling for session ${data.session_id}`);
        return;
      }
    }

    const questions = extractElicitation(data.transcript_path);
    if (questions && questions.length > 0) {
      const elicId = crypto.randomUUID();
      const context = extractContext(data.transcript_path);

      pendingElicitations.set(elicId, {
        sessionId: data.session_id,
        ttyPath: data.tty_path || sessions.get(data.session_id)?.ttyPath,
        questions,
        answers: new Map(),
        multiToggles: new Map(),
        telegramMessageIds: [],
        currentMessageId: null,
        customWaitingMessageId: null,
        customWaitingQIdx: null,
        userTask: context.userTask,
        createdAt: Date.now(),
      });

      log(`Elicitation ${elicId}: ${questions.length} question(s) from session ${data.session_id}`);
      await sendElicitationQuestion(elicId);
      return;
    }
  }

  // Tool status — edit-in-place pattern
  if (notifType === 'tool_status') {
    await handleToolStatus(data);
    return;
  }

  // Stop notification — only notify for known sessions.
  // Subagent Tasks each get a unique session_id that was never seen before.
  // Main sessions are registered via permission requests or prior notifications.
  if (notifType === 'stop') {
    toolStatusMessages.delete(data.session_id);

    // Only notify for sessions we already know about (from permission requests etc.)
    // Unknown session_ids are subagents — skip them silently.
    const knownSession = sessions.has(data.session_id);
    if (!knownSession) {
      log(`Stop skipped (unknown session, likely subagent): ${data.session_id?.slice(0, 8)}`);
      return;
    }

    // Debounce per TTY — if multiple stops from same TTY within window, send only the last
    const tty = data.tty_path || 'no-tty';
    const pending = pendingStops.get(tty);
    if (pending) {
      clearTimeout(pending.timer);
    }

    const timer = setTimeout(() => {
      pendingStops.delete(tty);
      sendStopNotification(data).catch((e) => log(`Stop notify error: ${e.message}`));
    }, STOP_DEBOUNCE_MS);

    pendingStops.set(tty, { timer, data });
    return;
  }

  // Non-stop notifications — send immediately
  await sendImmediateNotification(data, notifType);
}

async function sendStopNotification(data) {
  trackSession(data);
  const context = extractContext(data.transcript_path);
  const msg = await formatNotification(data, context);
  try {
    const sent = await bot.telegram.sendMessage(config.chatId, msg.text, {
      entities: msg.entities,
    });

    messageToSession.set(sent.message_id, {
      sessionId: data.session_id,
      type: 'notification',
      createdAt: Date.now(),
    });

    log(`Notification sent: stop (msg ${sent.message_id})`);
  } catch (err) {
    log(`Notification send failed: ${err.message}`);
  }
}

async function sendImmediateNotification(data, notifType) {
  const context = extractContext(data.transcript_path);
  const msg = await formatNotification(data, context);
  try {
    const sent = await bot.telegram.sendMessage(config.chatId, msg.text, {
      entities: msg.entities,
    });

    messageToSession.set(sent.message_id, {
      sessionId: data.session_id,
      type: 'notification',
      createdAt: Date.now(),
    });

    log(`Notification sent: ${notifType} (msg ${sent.message_id})`);
  } catch (err) {
    log(`Notification send failed: ${err.message}`);
  }
}

/**
 * Handle tool_status notifications — edit a single message per session.
 */
async function handleToolStatus(data) {
  const sessionId = data.session_id;
  let entry = toolStatusMessages.get(sessionId);

  const toolName = data.tool_name || 'Unknown';
  const toolDetail = formatToolStatusDetail(toolName, data.tool_input);

  if (!entry) {
    entry = { messageId: null, tools: [] };
    toolStatusMessages.set(sessionId, entry);
  }

  // Mark previous tools as done
  for (const t of entry.tools) {
    t.status = 'done';
  }

  // Add new tool (limit to last 10)
  entry.tools.push({ name: toolName, detail: toolDetail, status: 'running' });
  if (entry.tools.length > 10) {
    entry.tools = entry.tools.slice(-10);
  }

  const msg = formatToolStatus(sessionId, entry.tools);

  try {
    if (entry.messageId) {
      // Edit existing message
      await bot.telegram.editMessageText(config.chatId, entry.messageId, null, msg.text, {
        entities: msg.entities,
      });
    } else {
      // Send new message
      const sent = await bot.telegram.sendMessage(config.chatId, msg.text, {
        entities: msg.entities,
      });
      entry.messageId = sent.message_id;
    }
  } catch (err) {
    // If edit fails (message too old, etc.), send new message
    if (entry.messageId && err.message?.includes('message is not modified')) {
      // Ignore — content hasn't changed
    } else {
      log(`Tool status send/edit error: ${err.message}`);
      try {
        const sent = await bot.telegram.sendMessage(config.chatId, msg.text, {
          entities: msg.entities,
        });
        entry.messageId = sent.message_id;
      } catch (e) {
        log(`Tool status fallback send failed: ${e.message}`);
      }
    }
  }
}

function formatToolStatusDetail(toolName, toolInput) {
  if (!toolInput) return '';
  switch (toolName) {
    case 'Bash':
      return truncate(toolInput.command || '', 60);
    case 'Write':
      return toolInput.file_path ? path.basename(toolInput.file_path) : '';
    case 'Edit':
      return toolInput.file_path ? path.basename(toolInput.file_path) : '';
    case 'Task':
      return truncate(toolInput.description || '', 60);
    case 'WebFetch':
      return truncate(toolInput.url || '', 60);
    case 'WebSearch':
      return truncate(toolInput.query || '', 60);
    default:
      return '';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          pending: pendingQuestions.size,
          sessions: sessions.size,
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/permission') {
        const data = await readBody(req);
        const result = await sendPermissionRequest(data);

        let response;
        if (result.decision === 'allow') {
          response = { decision: { behavior: 'allow' } };
        } else if (result.decision === 'deny') {
          response = { decision: { behavior: 'deny', message: 'Denied via Telegram' } };
        } else if (result.decision === 'always') {
          response = {
            decision: {
              behavior: 'allow',
              updatedPermissions: data.permission_suggestions,
            },
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/notify') {
        const data = await readBody(req);
        sendNotification(data).catch((e) => log(`Notify error: ${e.message}`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      log(`Server error: ${err.message}`);
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    log(`HTTP server listening on 127.0.0.1:${config.port}`);
  });

  return server;
}

// --- Cleanup stale state periodically ---

function startCleanup() {
  setInterval(async () => {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000; // 1 hour

    // Clean message mappings — keep if session's TTY is still alive
    for (const [msgId, m] of messageToSession) {
      const s = sessions.get(m.sessionId);
      if (s?.ttyPath && await isTtyAlive(s.ttyPath)) continue;
      if (now - m.createdAt > staleThreshold) {
        messageToSession.delete(msgId);
      }
    }

    // Clean stale sessions — only if terminal is gone
    for (const [sid, s] of sessions) {
      if (s.ttyPath) {
        if (!(await isTtyAlive(s.ttyPath))) {
          sessions.delete(sid);
          log(`Cleaned session ${sid} (TTY gone: ${s.ttyPath})`);
        }
      } else if (now - s.lastActive > staleThreshold) {
        sessions.delete(sid);
        log(`Cleaned stale session ${sid} (no TTY, inactive)`);
      }
    }

    // Clean stale elicitations (30 min timeout)
    for (const [elicId, elic] of pendingElicitations) {
      if (now - elic.createdAt > 30 * 60 * 1000) {
        pendingElicitations.delete(elicId);
        log(`Cleaned stale elicitation ${elicId}`);
      }
    }
  }, 10 * 60 * 1000); // every 10 min
}

// --- Main ---

function main() {
  config = loadConfig();
  if (!config.botToken || !config.chatId) {
    console.error('Missing botToken or chatId. Run: teleclaude setup');
    process.exit(1);
  }

  log('Daemon starting...');
  startServer();  // HTTP server first — hooks must be able to connect immediately
  startBot();     // Telegram polling in background
  startCleanup();
  startHealthCheck();

  process.on('unhandledRejection', (err) => {
    log(`Unhandled rejection: ${err?.message || err}`);
  });

  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err?.message || err}`);
    // Don't crash — log and continue
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down');
    bot.stop('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down');
    bot.stop('SIGINT');
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
