const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Telegraf, Markup } = require('telegraf');
const { loadConfig, LOG_PATH } = require('./config');
const fs = require('fs');

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

let bot;
let config;

// --- Utilities ---

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
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
 * More reliable than fs.statSync which succeeds even after terminal closes.
 */
function isTtyAlive(ttyPath) {
  if (!ttyPath) return false;
  try {
    const ttyName = ttyPath.replace('/dev/', '');
    const result = execSync(`ps -t ${ttyName} -o pid= 2>/dev/null`, { timeout: 2000, stdio: 'pipe' }).toString().trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Escape a string for use inside AppleScript double-quoted strings.
 */
function escapeAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Send text as input to a terminal session identified by its TTY path.
 * Uses osascript to type into the correct terminal tab/session.
 * Tries iTerm2 first, then Terminal.app.
 */
function sendInputToTerminal(ttyPath, text) {
  if (!ttyPath) {
    log('sendInput: no TTY path');
    return false;
  }

  const escaped = escapeAppleScript(text.trim());

  // Try iTerm2 — write text targets a specific session by TTY, no focus needed
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
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000, stdio: 'pipe' });
    log(`Sent via iTerm2 to ${ttyPath}: ${truncate(text, 80)}`);
    return true;
  } catch {}

  // Try Terminal.app — focus the tab, type text, press Enter
  try {
    const script = [
      'tell application "Terminal"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      `      if tty of t is "${ttyPath}" then`,
      '        set selected tab of w to t',
      '        set frontmost of w to true',
      '        delay 0.3',
      '        tell application "System Events"',
      '          tell process "Terminal"',
      `            keystroke "${escaped}"`,
      '            delay 0.2',
      '            keystroke return',
      '          end tell',
      '        end tell',
      '        return "ok"',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
    ].join('\n');

    fs.writeFileSync('/tmp/claude-tg-input.scpt', script);
    execSync('osascript /tmp/claude-tg-input.scpt', { timeout: 10000, stdio: 'pipe' });
    log(`Sent via Terminal.app to ${ttyPath}: ${truncate(text, 80)}`);
    return true;
  } catch (err) {
    log(`Terminal.app send error: ${err.message}`);
  }

  log(`sendInput failed: no terminal found for ${ttyPath}`);
  return false;
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

  let msg = `📋  #${sessionNum} ${label}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (context.userTask) {
    msg += `📝 Task: ${context.userTask}\n\n`;
  }
  if (context.recentContext) {
    msg += `💭 Doing: ${context.recentContext}\n\n`;
  }

  msg += `🔧 ${tool}`;
  if (details) msg += `\n${details}`;

  return msg;
}

function formatNotification(data, context) {
  const label = projectLabel(data.cwd);
  const sessionNum = getSessionLabel(data.session_id);
  const type = data.notification_type || data.type || 'notification';
  const session = sessions.get(data.session_id);
  const canReply = !!(session && session.ttyPath);

  let msg = '';

  if (type === 'idle_prompt') {
    msg += `⏳  #${sessionNum} ${label} — Claude is idle\n`;
  } else if (type === 'elicitation_dialog') {
    msg += `💬  #${sessionNum} ${label} — Claude has a question\n`;
  } else {
    msg += `🔔  #${sessionNum} ${label} — ${type}\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (context.userTask) {
    msg += `📝 Task: ${context.userTask}\n\n`;
  }

  if (context.recentContext) {
    msg += `💬 Claude said:\n${context.recentContext}\n`;
  }

  if (canReply) {
    msg += `\n↩️ Reply to this message to send input`;
  } else {
    msg += `\nOpen your terminal to respond.`;
  }

  return msg;
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
  const sent = await bot.telegram.sendMessage(config.chatId, msg, keyboard);
  elic.telegramMessageIds.push(sent.message_id);
  elic.currentMessageId = sent.message_id;
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

  const sent = await bot.telegram.sendMessage(config.chatId, msg, keyboard);
  elic.telegramMessageIds.push(sent.message_id);
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
    ctx.answerCbQuery('Expired or already answered.');
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

      setTimeout(() => {
        const ok = injectElicitationAnswers(elic.ttyPath, elic.questions, elic.answers);
        log(`Elicitation ${elicId}: ${ok ? 'keystrokes injected' : 'injection failed'}`);
        if (!ok) {
          bot.telegram.sendMessage(config.chatId, '⚠️ Could not inject answers into terminal').catch(() => {});
        }
      }, 2000);
    } else {
      // From notification flow — inject immediately
      const ok = injectElicitationAnswers(elic.ttyPath, elic.questions, elic.answers);
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
    ctx.answerCbQuery('Invalid question.');
    return;
  }

  // Custom answer
  if (optAction === 'custom') {
    try { await ctx.answerCbQuery('Type your answer...'); } catch {}
    try { await ctx.editMessageReplyMarkup(undefined); } catch {}
    try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✏️ Selected: Custom'); } catch {}

    const prompt = await bot.telegram.sendMessage(
      config.chatId,
      `✏️ Type your custom answer for: "${q.question}"\n\nReply to this message with your answer.`
    );

    elic.customWaitingMessageId = prompt.message_id;
    elic.customWaitingQIdx = qIdx;
    elic.telegramMessageIds.push(prompt.message_id);
    log(`Elicitation ${elicId}: waiting for custom answer to q${qIdx}`);
    return;
  }

  // MultiSelect "done" — save current toggles and advance
  if (optAction === 'done') {
    const toggles = elic.multiToggles || new Map();
    const selected = toggles.get(qIdx) || new Set();

    if (selected.size === 0) {
      ctx.answerCbQuery('Select at least one option.');
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
    ctx.answerCbQuery('Invalid option.');
    return;
  }

  // MultiSelect — toggle and update buttons
  if (q.multiSelect) {
    if (!elic.multiToggles) elic.multiToggles = new Map();
    if (!elic.multiToggles.has(qIdx)) elic.multiToggles.set(qIdx, new Set());
    const selected = elic.multiToggles.get(qIdx);

    if (selected.has(optIdx)) {
      selected.delete(optIdx);
      ctx.answerCbQuery(`Deselected: ${opt.label}`);
    } else {
      selected.add(optIdx);
      ctx.answerCbQuery(`Selected: ${opt.label}`);
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
function injectElicitationAnswers(ttyPath, questions, answers) {
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
      // Navigate to "Other" (last position, after all defined options)
      const otherPos = q.options.length;
      for (let i = 0; i < otherPos; i++) {
        events.push({ type: 'key_code', value: 125 }); // arrow down
      }
      events.push({ type: 'key_code', value: 36 }); // enter to select Other
      events.push({ type: 'delay', value: 0.3 });
      events.push({ type: 'keystroke', value: answer.customText }); // type custom text
    } else if (answer.multiSelections) {
      // MultiSelect: walk through all options, space on selected ones
      const selectedSet = new Set(answer.multiSelections.map((s) => s.optionIndex));
      for (let i = 0; i < q.options.length; i++) {
        if (selectedSet.has(i)) {
          events.push({ type: 'keystroke', value: ' ' }); // space to toggle
        }
        if (i < q.options.length - 1) {
          events.push({ type: 'key_code', value: 125 }); // arrow down
        }
      }
    } else {
      // Single select: navigate to selected option
      for (let i = 0; i < answer.optionIndex; i++) {
        events.push({ type: 'key_code', value: 125 }); // arrow down
      }
    }

    // Tab to next question, or nothing for the last one
    if (qIdx < questions.length - 1) {
      events.push({ type: 'key_code', value: 48 }); // tab
      events.push({ type: 'delay', value: 0.15 });
    }
  }

  // Submit the form
  events.push({ type: 'delay', value: 0.2 });
  events.push({ type: 'keystroke', value: 'return' });

  // Build key action lines for AppleScript
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

  // Try iTerm2 first (focus + System Events)
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

    fs.writeFileSync('/tmp/claude-tg-elicit.scpt', script);
    execSync('osascript /tmp/claude-tg-elicit.scpt', { timeout: 30000, stdio: 'pipe' });
    log(`Elicitation keystrokes sent via iTerm2 to ${ttyPath}`);
    return true;
  } catch {}

  // Try Terminal.app
  try {
    const script = [
      'tell application "Terminal"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      `      if tty of t is "${ttyPath}" then`,
      '        set selected tab of w to t',
      '        set frontmost of w to true',
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

    fs.writeFileSync('/tmp/claude-tg-elicit.scpt', script);
    execSync('osascript /tmp/claude-tg-elicit.scpt', { timeout: 30000, stdio: 'pipe' });
    log(`Elicitation keystrokes sent via Terminal.app to ${ttyPath}`);
    return true;
  } catch (err) {
    log(`Terminal.app elicitation error: ${err.message}`);
  }

  log(`injectElicitation failed: no terminal found for ${ttyPath}`);
  return false;
}

// --- Telegram bot ---

function startBot() {
  bot = new Telegraf(config.botToken);

  bot.command('start', (ctx) => {
    const chatId = ctx.chat.id.toString();
    ctx.reply(`Chat ID registered: ${chatId}\n\nThis chat will receive Claude Code permission requests.`);
    log(`/start from chat ${chatId}`);
  });

  bot.command('status', (ctx) => {
    const pendingCount = pendingQuestions.size;
    const activeSessions = [...sessions.entries()].filter(([, s]) => {
      if (s.ttyPath) return isTtyAlive(s.ttyPath);
      return Date.now() - s.lastActive < 60 * 60 * 1000;
    });

    let msg = '';
    if (activeSessions.length === 0 && pendingCount === 0) {
      ctx.reply('No active sessions or pending requests.');
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

    ctx.reply(msg);
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
      ctx.answerCbQuery('Request expired or already answered.');
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

          ctx.reply(`✅ Custom answer for "${q.question}": ${text}`);
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
          ctx.reply('⚠️ That was a permission request — use the buttons above.\nTo send text input, reply to a notification message.');
          return;
        }
        targetSessionId = mapping.sessionId;
      }
    }

    // If no reply-to, try auto-routing
    if (!targetSessionId) {
      // Find sessions that have notifications and are still alive (TTY exists)
      const recentNotifications = [...messageToSession.entries()]
        .filter(([, m]) => {
          if (m.type !== 'notification') return false;
          const s = sessions.get(m.sessionId);
          if (s?.ttyPath) return isTtyAlive(s.ttyPath);
          return Date.now() - m.createdAt < 60 * 60 * 1000;
        })
        .map(([, m]) => m.sessionId);

      const uniqueSessions = [...new Set(recentNotifications)];

      if (uniqueSessions.length === 1) {
        targetSessionId = uniqueSessions[0];
      } else if (uniqueSessions.length === 0) {
        ctx.reply('No idle Claude sessions to send input to.');
        return;
      } else {
        // Multiple sessions — ask user to be specific
        const labels = uniqueSessions.map((sid) => {
          const s = sessions.get(sid);
          const num = getSessionLabel(sid);
          return `  #${num} ${s?.label || 'unknown'}`;
        }).join('\n');
        ctx.reply(`Multiple sessions are waiting. Reply to a specific notification message to choose:\n\n${labels}`);
        return;
      }
    }

    // Send the text to the terminal
    const session = sessions.get(targetSessionId);
    if (!session || !session.ttyPath) {
      ctx.reply(`⚠️ No TTY for session #${getSessionLabel(targetSessionId)}. Open the terminal to respond.`);
      return;
    }

    const ok = sendInputToTerminal(session.ttyPath, text);
    if (ok) {
      const num = getSessionLabel(targetSessionId);
      ctx.reply(`➡️ Sent to #${num} ${session.label}`);
    } else {
      ctx.reply(`⚠️ Could not send to terminal. Session may have ended, or terminal app not recognized.`);
    }
  });

  bot.catch((err) => {
    log(`Bot error: ${err.message}`);
  });

  bot.launch({ dropPendingUpdates: true });
  log('Telegram bot started');
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

  const sent = await bot.telegram.sendMessage(config.chatId, msg, keyboard);

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
  trackSession(data);

  const notifType = data.notification_type || data.type;

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

  // Default notification flow
  const context = extractContext(data.transcript_path);
  const msg = formatNotification(data, context);
  const sent = await bot.telegram.sendMessage(config.chatId, msg);

  messageToSession.set(sent.message_id, {
    sessionId: data.session_id,
    type: 'notification',
    createdAt: Date.now(),
  });

  log(`Notification sent: ${notifType} (msg ${sent.message_id})`);
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
  setInterval(() => {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000; // 1 hour

    // Clean message mappings — keep if session's TTY is still alive
    for (const [msgId, m] of messageToSession) {
      const s = sessions.get(m.sessionId);
      if (s?.ttyPath && isTtyAlive(s.ttyPath)) continue;
      if (now - m.createdAt > staleThreshold) {
        messageToSession.delete(msgId);
      }
    }

    // Clean stale sessions — only if terminal is gone
    for (const [sid, s] of sessions) {
      if (s.ttyPath) {
        if (!isTtyAlive(s.ttyPath)) {
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
    console.error('Missing botToken or chatId. Run: claude-tg setup');
    process.exit(1);
  }

  log('Daemon starting...');
  startBot();
  startServer();
  startCleanup();

  process.on('unhandledRejection', (err) => {
    log(`Unhandled rejection: ${err?.message || err}`);
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
