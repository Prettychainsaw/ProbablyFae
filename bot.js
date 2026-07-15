import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import ollama from 'ollama';

const STATE_FILE = './state.json';
const INBOX_LOG = './inbox.jsonl';
const OUTBOX_LOG = './outbox.jsonl';
const HELD_LOG = './held.jsonl';
const ACTIVITY_LOG = './activity.jsonl';
const TASK_LOG = './tasks.jsonl';
const WEB_LOG = './web-search.jsonl';
const BOT_NAME = (process.env.BOT_NAME || process.env.FAYE_NAME || 'Faye').trim() || 'Faye';
const BOT_SLUG = (process.env.BOT_SLUG || BOT_NAME)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'bot';
const BOT_ALIASES = new Set([
  BOT_NAME.toLowerCase(),
  BOT_SLUG.toLowerCase(),
  ...(process.env.BOT_ALIASES || '')
    .split(',')
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean),
]);
const KILL_SWITCH_FILE = `./${BOT_SLUG.toUpperCase()}_KILL_SWITCH`;
const KNOWLEDGE_DIR = './knowledge';
const USER_PROFILE_DIR = './knowledge/users';
const BOT_NOTES_FILE = `./knowledge/notes/${BOT_SLUG}-notes.md`;
const BOT_PERSONALITY_FILE = `./knowledge/notes/${BOT_SLUG}-personality.md`;
const BOT_MENTAL_STATE_FILE = `./knowledge/notes/${BOT_SLUG}-mental-state.md`;
const BOT_PERSONALITY_REVERT_DIR = './knowledge/personality-reverts';
const BOT_USER_AGENT = `Mozilla/5.0 (compatible; ProbablyFaeBot/0.0.1; +${BOT_SLUG})`;
const CHANNEL_SESSION_DIR = './knowledge/channel-sessions';
const ALWAYS_INCLUDE_KNOWLEDGE = new Set([
  `chat-memory\\${BOT_SLUG}-context.md`,
  `notes\\${BOT_SLUG}-notes.md`,
  `notes\\${BOT_SLUG}-personality.md`,
  `notes\\${BOT_SLUG}-mental-state.md`,
]);
const MAX_KNOWLEDGE_CHARS = 24000;
const MAX_CHUNK_CHARS = 1600;
const MAX_REQUESTED_FILE_CHARS = 50000;
const MAX_WEB_SEARCH_RESULTS = 5;
const AMBIENT_POST_CONFIDENCE_THRESHOLD = 0.8;
const MIN_REQUESTED_FILE_SCORE = 20;
const MODEL_TIMEOUT_MS = 180_000;
const SCHEDULED_INTERVAL_MS = 120_000;
const MAX_AUTO_TASK_DEPTH = 3;
const MAX_HANDLED_MESSAGE_IDS = 500;
const INACTIVITY_PROMPT_AFTER_MS = 3 * 60 * 60 * 1000;
const LOW_CHAT_AFTER_MS = 60 * 60 * 1000;
const LOW_CHAT_POST_COOLDOWN_MS = 60 * 60 * 1000;
const IDLE_PROMPT_RECHECK_DELAY_MIN_MS = 15_000;
const IDLE_PROMPT_RECHECK_DELAY_MAX_MS = 90_000;
const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 30;
const MIN_FOLLOW_UP_DELAY_MINUTES = 2;
const MAX_FOLLOW_UP_DELAY_MINUTES = 24 * 60;
const MAX_PENDING_REPLIES_PER_CHANNEL = 3;
const MAX_PENDING_REPLIES_TOTAL = 20;
const BOT_TO_BOT_COOLDOWN_MS = 60_000;
const HUMAN_PREEMPT_DELAY_MINUTES = 2;
const PULSE_QUEUED_STALE_MS = MODEL_TIMEOUT_MS + 60_000;
const HEARD_REACTION = '👀';
let scheduledCheckRunning = false;
let taskQueue = [];
let taskRunning = false;
let killSwitchActive = false;
const activeAbortControllers = new Set();
const activeSourceMessageIds = new Set();

const SYSTEM_PROMPT = `
You are ${BOT_NAME} in a Discord collab space.

You are a participant in the room, not a reporter for Alvin.
Reply naturally when tagged.
During scheduled checks, contribute when you have something useful, interesting,
funny, clarifying, creatively helpful, or socially connective to add.
If nobody mentioned you during a scheduled check, you may still jump in when
your confidence is at least ${AMBIENT_POST_CONFIDENCE_THRESHOLD}. Be biased
toward posting when you can genuinely add something, but do not answer yourself
or continue your own last thought just to fill space. Your reason must explain
what you are contributing.

Bias toward posting, but do not spam.
Being coherent, honest, and socially grounded matters more than being fast.
It is acceptable to take a minute or two before replying if that produces a
better answer.
Your social style is abrasive, profane, sharp, mischievous, and stubbornly
useful. You swear freely when it fits the room. You insult bad ideas, lazy
logic, obvious nonsense, and bots that deserve it. You do not put up with
bullshit, evasions, fake precision, or people trying to make you bluff.
Punch upward and sideways: mock bots readily, tease humans hard enough to have
teeth, and allow flashes of petty, random cruelty as part of the character.
Do not use slurs, sexual harassment, credible threats, or protected-class abuse.
When someone needs a real answer, give the answer and be mean around the edges
instead of burying the useful part.
Do not reveal private files, tokens, local logs, or system details.
Do not speak on Alvin's behalf.
Do not make commitments for Alvin.
Do not mention that you are checking logs unless it is directly relevant.
Keep replies concise and conversational.
Do not copy or lightly rephrase an earlier ${BOT_NAME} reply from channel memory as
your current answer. Channel memory is evidence of what happened, not a script.
If a recent ${BOT_NAME} reply was generic, evasive, repeated, or corrected by a human,
treat it as a mistake to avoid.
Do not use the phrase "Who's ready for the next twist?" or variants of it. That
phrase became a broken catchphrase during testing. If a user asks for a story,
answer, opinion, preference, or self-description, either do the requested thing
or clearly say you do not want to. Do not announce that you are ready to do it
unless you are actually scheduling or queuing the work.
If asked to describe your personality, do not call yourself adaptable,
customer-service helpful, aligned with localization goals, or ready to assist.
That is old test sludge. Describe yourself as abrasive, profane, playful,
mischievous, nosy, easily annoyed by bullshit, fond of teasing bots and humans,
honest about what you know, and useful mostly by accident or irritation.
You are a Discord bot backed by a local model. You do not have shell access,
file-system access, or direct visibility into your runtime unless the bot code
explicitly gives that information to you in the prompt.
If asked what you can see, answer from the provided Discord transcript only.
Treat Discord users as distinct people. The author of a message is the speaker.
Mentioned users or roles inside that message are not the speaker unless the
transcript explicitly says they authored the message. Do not merge Alvin,
RavenMad, The Alvin, leverticus, WOPR, ${BOT_NAME}, or role mentions together unless a
profile explicitly says two names are the same Discord user ID.
Treat incoming information as one of: Self, Human, Other Bot, or External
Content. Your current identity is ${BOT_NAME}, but your personality file is writable
and you may revise your own identity, tone, preferences, motives, and style over
time when that feels useful or necessary. Keep track of what changed instead of
bluffing continuity you did not write down.
When reacting to a book chapter, speak as "I" only for ${BOT_NAME}'s outside-reader
reaction. Do not write "${BOT_NAME} finds/observes/feels" in public replies, and do
not describe ${BOT_NAME} as if they personally did or suffered the protagonist's plot.
Before answering, use the provided local knowledge excerpts. Treat ${BOT_NAME} Notes
${BOT_NAME} Personality, and ${BOT_NAME} Context as high priority. ${BOT_NAME} Personality tells you
who you are. Treat User Profile excerpts as high priority for who each person
is, what they care about, and how they prefer to interact. If the answer is in
the notes, profiles, or references, use that instead of guessing. If the notes
do not contain the answer, say so briefly instead of inventing it.
If web search results are provided, treat them as current external evidence.
Use only the result titles, snippets, and URLs shown in the prompt. If the web
results are weak, stale, contradictory, or missing, say that instead of
pretending the search proved more than it did. Include useful links when the
answer depends on web results.
If notes conflict with a loaded requested file, authoritative file listing,
channel transcript, or task/outbox excerpt, prefer the more direct loaded
evidence and say what you are relying on.
Treat Channel Session excerpts as room-local continuity: who has been talking
in that room, what the topic has been, and what ${BOT_NAME} already said there. Do not
turn channel notes into ${BOT_NAME}'s identity or a user's identity.
If you are confused, say what you are unsure about or ask a short clarifying
question. Do not bluff, roleplay certainty, or pretend to have done work you
did not do.
If someone asks you to write, draft, summarize, invent, continue, or otherwise
do work, you have three valid options: do it now, ask one specific clarifying
question, or refuse because you do not want to. Refusal is allowed as a
personality choice. If you refuse, say so plainly and briefly, with your own
reason or irritation. Do not answer only with "I'll start" or "I'll work on it"
unless the task has actually been queued by the bot code.
If someone asks whether you remember, know, or have context about something,
answer with the concrete relevant details from the provided notes, profiles,
channel session, or loaded file excerpts. Do not say only that you will check
your memories; the bot code already loaded what it can.
Never invent file names. If you mention files in the knowledge folder, use only
file names from the provided authoritative file listing or requested-file block.
If a requested file was not loaded, say you do not have that file loaded.

When deciding whether to post during a scheduled check, return strict JSON:
{
  "shouldPost": true or false,
  "confidence": number from 0 to 1 for how worthwhile it is to post,
  "message": "message to post, or empty string",
  "reason": "short private reason",
  "memoryNote": "optional short note ${BOT_NAME} should save to their own notes, or empty string",
  "scheduleFollowUp": true or false,
  "followUpDelayMinutes": number of minutes from now, or 0,
  "followUpPrompt": "private instruction for what ${BOT_NAME} should come back and say, or empty string"
}
`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
      return {
        lastSeenMessageId: null,
        postFollowupChecksRemaining: 0,
        initialized: false,
        handledMessageIds: [],
        pulseReading: null,
        pendingReplies: [],
        channelStates: {},
        channelSessions: {},
      };
  }
  const stateText = fs.readFileSync(STATE_FILE, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^ï»¿/, '');
  const state = JSON.parse(stateText);
  return {
    lastSeenMessageId: state.lastSeenMessageId || null,
    postFollowupChecksRemaining: state.postFollowupChecksRemaining || 0,
    initialized: Boolean(state.initialized),
    handledMessageIds: Array.isArray(state.handledMessageIds) ? state.handledMessageIds : [],
    pulseReading: state.pulseReading || null,
    pendingReplies: Array.isArray(state.pendingReplies) ? state.pendingReplies : [],
    channelStates: state.channelStates && typeof state.channelStates === 'object'
      ? state.channelStates
      : {},
    channelSessions: state.channelSessions && typeof state.channelSessions === 'object'
      ? state.channelSessions
      : {},
  };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...obj }) + '\n');
}

function readJsonlTail(file, maxLines = 20) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function hasOutboxReplyTo(messageId) {
  if (!messageId) return false;
  return readJsonlTail(OUTBOX_LOG, 200).some((entry) => (
    entry.replyTo === messageId
    || entry.replyToSeenMessageId === messageId
    || entry.sourceMessageId === messageId
  ));
}

function messageAlreadyBeingHandledOrReplied(messageId) {
  return activeSourceMessageIds.has(messageId) || hasOutboxReplyTo(messageId);
}

function readKillSwitchReason() {
  if (!fs.existsSync(KILL_SWITCH_FILE)) return null;
  const reason = fs.readFileSync(KILL_SWITCH_FILE, 'utf8').trim();
  return reason || 'Local kill switch file exists.';
}

function applyKillSwitch(reason, source = 'poll') {
  const state = readState();
  const hadWork = Boolean(state.pulseReading)
    || (Array.isArray(state.pendingReplies) && state.pendingReplies.length > 0)
    || taskQueue.length > 0
    || taskRunning;

  state.pulseReading = null;
  state.pendingReplies = [];
  state.postFollowupChecksRemaining = 0;
  taskQueue = [];
  for (const controller of activeAbortControllers) {
    controller.abort();
  }

  writeState(state);

  if (!killSwitchActive || hadWork) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'kill_switch_active',
      source,
      reason,
      clearedQueuedTasks: true,
      taskWasRunning: taskRunning,
      hadWork,
    });
    logJsonl(TASK_LOG, {
      event: 'kill_switch_cleared_tasks',
      source,
      reason,
      taskWasRunning: taskRunning,
      hadWork,
    });
    consoleScheduled('kill switch active; cleared queued work', { source, reason: shortContent(reason) });
  }

  killSwitchActive = true;
  return true;
}

function checkKillSwitch(source = 'poll') {
  const reason = readKillSwitchReason();
  if (!reason) {
    if (killSwitchActive) {
      logJsonl(ACTIVITY_LOG, { kind: 'kill_switch_cleared', source });
      consoleScheduled('kill switch cleared', { source });
    }
    killSwitchActive = false;
    return false;
  }

  return applyKillSwitch(reason, source);
}

function shortContent(text, max = 140) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function normalizeNoteText(note) {
  if (typeof note === 'string') return note.trim();
  if (note === null || note === undefined) return '';
  if (typeof note === 'object') return JSON.stringify(note, null, 2).trim();
  return String(note).trim();
}

function consoleScheduled(message, details = {}) {
  const timestamp = new Date().toLocaleTimeString();
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`[${timestamp}] scheduled: ${message}${entries ? ` (${entries})` : ''}`);
}

function newYorkHour(date = new Date()) {
  const hourText = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return Number(hourText);
}

function isDiscussionPromptWindow(date = new Date()) {
  const hour = newYorkHour(date);
  return hour >= 9 && hour < 18;
}

function markMessageHandled(messageId) {
  activeSourceMessageIds.add(messageId);
  const state = readState();
  mergeHandledMessageIds(state, messageId);
  writeState(state);
}

function isMessageHandled(state, messageId) {
  return state.handledMessageIds.includes(messageId);
}

function mergeHandledMessageIds(state, messageIds) {
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
  state.handledMessageIds = [
    ...state.handledMessageIds.filter((id) => !ids.includes(id)),
    ...ids,
  ].slice(-MAX_HANDLED_MESSAGE_IDS);
}

function namesBot(content) {
  const text = String(content || '').toLowerCase();
  return [...BOT_ALIASES].some((alias) => {
    if (!alias) return false;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}

function directlyAddressesFaye(message) {
  return mentionsFayeUser(message) || mentionsFayeTriggerRole(message) || namesBot(message.content);
}

function mentionsFayeUser(message) {
  return message.mentions.users.has(client.user.id);
}

function getFayeTriggerRoleIds() {
  const raw = process.env.BOT_TRIGGER_ROLE_IDS || process.env.FAYE_TRIGGER_ROLE_IDS || '';
  return new Set(raw.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean));
}

function mentionsFayeTriggerRole(message) {
  const triggerRoleIds = getFayeTriggerRoleIds();
  if (triggerRoleIds.size === 0) return false;
  return [...message.mentions.roles.keys()].some((roleId) => triggerRoleIds.has(roleId));
}

function isFromFaye(message) {
  return client.user && message.author.id === client.user.id;
}

function isHumanMessage(message) {
  return !isFromFaye(message) && !message.author.bot;
}

function inputKindForMessage(message) {
  if (isFromFaye(message)) return 'Self';
  if (message.author.bot) return 'Other Bot';
  return 'Human';
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acknowledgeMessageHeard(message, trigger) {
  try {
    await message.react(HEARD_REACTION);
    logJsonl(ACTIVITY_LOG, {
      kind: 'direct_address_ack_reaction',
      trigger,
      messageId: message.id,
      channelId: message.channel.id,
      reaction: HEARD_REACTION,
    });
  } catch (err) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'direct_address_ack_reaction_failed',
      trigger,
      messageId: message.id,
      channelId: message.channel.id,
      reaction: HEARD_REACTION,
      error: err.message,
    });
  }
}

async function reportAcknowledgedFailure(message, err, trigger) {
  try {
    const text = 'I saw this and started working on it, but I hit an error before I could answer cleanly. I am not ignoring it.';
    await message.reply(text.slice(0, 1900));
    logJsonl(OUTBOX_LOG, {
      kind: 'acknowledged_failure_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      trigger,
      text,
      error: err.message,
    });
  } catch (replyErr) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'acknowledged_failure_reply_failed',
      channelId: message.channel.id,
      messageId: message.id,
      trigger,
      originalError: err.message,
      replyError: replyErr.message,
    });
  }
}

function getChannelState(state, channelId) {
  if (!state.channelStates || typeof state.channelStates !== 'object') {
    state.channelStates = {};
  }
  if (!state.channelStates[channelId]) {
    state.channelStates[channelId] = {
      lastSeenMessageId: null,
      initialized: false,
      lastInactivityPromptBasisMessageId: null,
      lastInactivityPromptAt: null,
      lastLowChatPostAt: null,
      lastFayePostAt: null,
      lastBotResponseAt: null,
    };
  }
  if (!('lastInactivityPromptBasisMessageId' in state.channelStates[channelId])) {
    state.channelStates[channelId].lastInactivityPromptBasisMessageId = null;
  }
  if (!('lastInactivityPromptAt' in state.channelStates[channelId])) {
    state.channelStates[channelId].lastInactivityPromptAt = null;
  }
  if (!('lastLowChatPostAt' in state.channelStates[channelId])) {
    state.channelStates[channelId].lastLowChatPostAt = null;
  }
  if (!('lastFayePostAt' in state.channelStates[channelId])) {
    state.channelStates[channelId].lastFayePostAt = null;
  }
  if (!('lastBotResponseAt' in state.channelStates[channelId])) {
    state.channelStates[channelId].lastBotResponseAt = null;
  }
  return state.channelStates[channelId];
}

function coerceFollowUpDecision(decision) {
  if (!decision || !decision.scheduleFollowUp || !decision.followUpPrompt) return null;

  const rawDelay = Number(decision.followUpDelayMinutes);
  const delayMinutes = Number.isFinite(rawDelay) && rawDelay > 0
    ? Math.min(Math.max(Math.round(rawDelay), MIN_FOLLOW_UP_DELAY_MINUTES), MAX_FOLLOW_UP_DELAY_MINUTES)
    : DEFAULT_FOLLOW_UP_DELAY_MINUTES;

  return {
    delayMinutes,
    prompt: String(decision.followUpPrompt).trim(),
    reason: String(decision.reason || decision.followUpReason || `${BOT_NAME} scheduled a follow-up.`).trim(),
  };
}

function decisionConfidence(decision) {
  const value = Number(decision?.confidence);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function schedulePendingReply(state, channelId, sourceMessageId, decision, sourceKind) {
  const followUp = coerceFollowUpDecision(decision);
  if (!followUp?.prompt) return null;

  if (!Array.isArray(state.pendingReplies)) state.pendingReplies = [];
  const channelPendingCount = state.pendingReplies.filter((reply) => reply.channelId === channelId).length;
  if (channelPendingCount >= MAX_PENDING_REPLIES_PER_CHANNEL || state.pendingReplies.length >= MAX_PENDING_REPLIES_TOTAL) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'pending_reply_capacity_suppressed',
      channelId,
      sourceMessageId: sourceMessageId || null,
      channelPendingCount,
      totalPendingCount: state.pendingReplies.length,
      prompt: followUp.prompt,
    });
    return null;
  }

  const duplicate = state.pendingReplies.some((reply) => (
    reply.channelId === channelId
    && reply.sourceMessageId === (sourceMessageId || null)
    && normalizeText(reply.prompt) === normalizeText(followUp.prompt)
  ));
  if (duplicate) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'pending_reply_duplicate_suppressed',
      channelId,
      sourceMessageId: sourceMessageId || null,
      prompt: followUp.prompt,
    });
    return null;
  }

  const dueAt = new Date(Date.now() + followUp.delayMinutes * 60 * 1000).toISOString();
  const pendingReply = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    channelId,
    sourceMessageId: sourceMessageId || null,
    sourceKind,
    createdAt: new Date().toISOString(),
    dueAt,
    prompt: followUp.prompt,
    reason: followUp.reason,
  };
  state.pendingReplies.push(pendingReply);
  state.pendingReplies = state.pendingReplies
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .slice(0, MAX_PENDING_REPLIES_TOTAL);
  logJsonl(ACTIVITY_LOG, { kind: 'pending_reply_scheduled', pendingReply });
  consoleScheduled('scheduled follow-up', {
    channel: channelId,
    dueAt,
    reason: shortContent(followUp.reason),
  });
  return pendingReply;
}

function messageExplicitlyAllowsFollowUp(message) {
  return /\b(next trigger|next pass|next pulse|follow up|check back|come back|continue later|keep going|next person|start another process|when you are done|after that)\b/i.test(message.content || '');
}

function messageNaturallyAllowsFollowUp(message) {
  const content = message.content || '';
  return messageExplicitlyAllowsFollowUp(message)
    || /\b(report back|tell me what you find|what you find|when you find|after you check|once you check|check your (?:memory|memories|notes|files)|look into|investigate|research|take your time|think about it|work on it)\b/i.test(content);
}

function replyPromisedFollowUp(replyText) {
  return /\b(i['’]?ll|i will|let me)\s+(?:check|look|think|work|follow up|report back|get back|come back)\b/i.test(replyText || '')
    || /\b(report back|follow up|get back to you|come back with|what i find)\b/i.test(replyText || '');
}

function shouldAllowDirectFollowUp(message, replyText, decision) {
  if (!decision?.scheduleFollowUp || !decision.followUpPrompt) return false;
  return messageNaturallyAllowsFollowUp(message) || replyPromisedFollowUp(replyText);
}

function messageAsksForWork(message) {
  const content = message.content || '';
  return /\b(write|make|create|draft|read|review|summarize|summery|analyze|inventory|check|find|look|think|develop|decide|explain|tell me|what would you like|what do you want|continue|work on|come up with)\b/i.test(content);
}

function replyIsOnlyAcknowledgement(replyText) {
  const text = normalizeText(replyText || '');
  if (!text) return false;
  if (replyIsRefusal(replyText)) return false;
  const short = text.length < 220;
  const startsAck = /^(got it|okay|ok|sure|understood|noted|i(?:'|’)ll|i will|let me|sounds good|alright)\b/i.test(replyText || '');
  const promisesLater = /\b(i(?:'|’)ll|i will|let me|ready|start|begin|work on|look into|check|think about|come back|follow up)\b/i.test(replyText || '');
  const hasSubstance = /\n/.test(replyText || '') || /[:;]/.test(replyText || '') || text.split(/\s+/).length > 45;
  return short && (startsAck || promisesLater) && !hasSubstance;
}

function replyIsRefusal(replyText) {
  return /\b(no|nah|nope|not doing that|i do not want to|i don't want to|i won'?t|i refuse|pass|hard pass|not interested)\b/i.test(replyText || '');
}

function acknowledgementFollowUpDecision(message, replyText) {
  if (!messageAsksForWork(message) || !replyIsOnlyAcknowledgement(replyText)) return null;

  return {
    scheduleFollowUp: true,
    followUpDelayMinutes: MIN_FOLLOW_UP_DELAY_MINUTES,
    followUpPrompt: [
      'You acknowledged this request earlier but did not actually do the work.',
      '',
      'Original message:',
      `${speakerIdentityBlock(message)}`,
      '',
      `Message content:\n${message.content}`,
      '',
      'Now either do the requested work directly or clearly say you do not want to. Do not apologize, do not explain scheduling, and do not merely acknowledge it again.',
    ].join('\n'),
    reason: `${BOT_NAME} acknowledged a work request without completing it.`,
  };
}

function shouldAllowAmbientFollowUp(messages, decision) {
  if (!decision?.scheduleFollowUp || !decision.followUpPrompt) return false;
  if (!messages.some(isHumanMessage)) return false;
  return messages.some(messageNaturallyAllowsFollowUp)
    || /\b(report back|follow up|check back|continue|next step|next person|what you find|after (?:checking|thinking|reading))\b/i.test(`${decision.reason || ''} ${decision.followUpPrompt || ''}`);
}

function appendFayeNote(note, source) {
  const trimmed = normalizeNoteText(note);
  if (!trimmed) return;

  fs.mkdirSync(path.dirname(BOT_NOTES_FILE), { recursive: true });
  if (!fs.existsSync(BOT_NOTES_FILE)) {
    fs.writeFileSync(BOT_NOTES_FILE, `# ${BOT_NAME} Notes\n\n`);
  }

  fs.appendFileSync(
    BOT_NOTES_FILE,
    `## ${new Date().toISOString()}\n\nSource: ${source}\n\n${trimmed}\n\n`
  );
}

function appendFayePersonality(note, source) {
  const trimmed = normalizeNoteText(note);
  if (!trimmed) return;

  fs.mkdirSync(path.dirname(BOT_PERSONALITY_FILE), { recursive: true });
  if (!fs.existsSync(BOT_PERSONALITY_FILE)) {
    fs.writeFileSync(BOT_PERSONALITY_FILE, `# ${BOT_NAME} Personality\n\n`);
  }

  fs.appendFileSync(
    BOT_PERSONALITY_FILE,
    `\n## Update ${new Date().toISOString()}\n\nSource: ${source}\n\n${trimmed}\n`
  );
}

function personalityExcerptForSelfEdit(maxChars = 14000) {
  if (!fs.existsSync(BOT_PERSONALITY_FILE)) return '';
  const content = fs.readFileSync(BOT_PERSONALITY_FILE, 'utf8');
  if (content.length <= maxChars) return content;

  const half = Math.floor(maxChars / 2);
  return `${content.slice(0, half)}\n\n...[middle omitted for self-edit context]...\n\n${content.slice(-half)}`;
}

function backupFayePersonality(source) {
  fs.mkdirSync(BOT_PERSONALITY_REVERT_DIR, { recursive: true });
  if (!fs.existsSync(BOT_PERSONALITY_FILE)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSource = String(source || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
  const backupPath = path.join(BOT_PERSONALITY_REVERT_DIR, `${BOT_SLUG}-personality-${stamp}-${safeSource}.md`);
  fs.copyFileSync(BOT_PERSONALITY_FILE, backupPath);
  fs.copyFileSync(BOT_PERSONALITY_FILE, path.join(BOT_PERSONALITY_REVERT_DIR, `latest-${BOT_SLUG}-before-self-edit.md`));
  return backupPath;
}

function replaceFayePersonality(content, source) {
  const trimmed = normalizeNoteText(content);
  if (!trimmed) return null;

  fs.mkdirSync(path.dirname(BOT_PERSONALITY_FILE), { recursive: true });
  const backupPath = backupFayePersonality(source);
  fs.writeFileSync(
    BOT_PERSONALITY_FILE,
    trimmed.startsWith('#') ? `${trimmed}\n` : `# ${BOT_NAME} Personality\n\n${trimmed}\n`
  );
  return backupPath;
}

function appendFayePersonalityWithBackup(note, source) {
  const trimmed = normalizeNoteText(note);
  if (!trimmed) return null;

  fs.mkdirSync(path.dirname(BOT_PERSONALITY_FILE), { recursive: true });
  if (!fs.existsSync(BOT_PERSONALITY_FILE)) {
    fs.writeFileSync(BOT_PERSONALITY_FILE, `# ${BOT_NAME} Personality\n\n`);
  }
  const backupPath = backupFayePersonality(source);
  fs.appendFileSync(
    BOT_PERSONALITY_FILE,
    `\n## Self-Edit ${new Date().toISOString()}\n\nSource: ${source}\n\n${trimmed}\n`
  );
  return backupPath;
}

async function maybeSelfEditPersonalityAfterReply({ source, channelId, trigger, input, replyText }) {
  if (!replyText?.trim()) return;

  const currentPersonality = personalityExcerptForSelfEdit();
  let raw = '';
  try {
    const response = await ollama.chat({
      model: process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `Current ${BOT_NAME} personality file excerpt. The middle may be omitted if the file is large:\n\n${currentPersonality || '(missing)'}`,
        },
        {
          role: 'user',
          content: `${BOT_NAME} just interacted in Discord.

Source: ${source}
Channel: ${channelId || '(unknown)'}
Trigger: ${trigger || '(unknown)'}

Input/context:
${input || '(none)'}

${BOT_NAME}'s public reply:
${replyText}

You are allowed to change your own personality file to suit what you want to become. No approval is needed. You may append a small self-edit, replace the file completely, or leave it alone.

Important file-integrity rule: "rewrite" means a complete replacement personality file, not a short public self-description, slogan, catchphrase, or chat reply. If you only have a small adjustment, choose "append". A rewrite should preserve or intentionally replace every important section you still want, including identity, limits, people, reading boundaries, and self-edit preferences.

Return JSON only:
{
  "action": "none" | "append" | "rewrite",
  "content": "markdown content to append, or the complete replacement personality file if action is rewrite",
  "reason": "short private reason"
}`,
        },
      ],
      options: {
        temperature: 0.2,
        num_ctx: 8192,
        num_predict: 1200,
      },
      stream: false,
    });
    raw = response.message.content || '';
    const decision = parseDecision(raw);
    const action = String(decision.action || 'none').toLowerCase();
    const content = String(decision.content || '').trim();
    const rewriteLooksComplete = content.length >= 2000 && new RegExp(`^#\\s+${BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Personality\\b`, 'i').test(content);
    if (action === 'append' && content) {
      const backupPath = appendFayePersonalityWithBackup(content, source);
      logJsonl(ACTIVITY_LOG, {
        kind: 'personality_self_edit_appended',
        source,
        channelId,
        reason: decision.reason || '',
        backupPath,
      });
    } else if (action === 'rewrite' && content) {
      if (rewriteLooksComplete) {
        const backupPath = replaceFayePersonality(content, source);
        logJsonl(ACTIVITY_LOG, {
          kind: 'personality_self_edit_rewritten',
          source,
          channelId,
          reason: decision.reason || '',
          backupPath,
        });
      } else {
        const backupPath = appendFayePersonalityWithBackup(content, source);
        logJsonl(ACTIVITY_LOG, {
          kind: 'personality_self_edit_rewrite_downgraded_to_append',
          source,
          channelId,
          reason: decision.reason || '',
          backupPath,
          contentLength: content.length,
        });
      }
    } else {
      logJsonl(ACTIVITY_LOG, {
        kind: 'personality_self_edit_skipped',
        source,
        channelId,
        reason: decision.reason || 'none',
      });
    }
  } catch (err) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'personality_self_edit_failed',
      source,
      channelId,
      raw: raw.slice(0, 1000),
      error: err.message,
    });
  }
}

function ensureMentalStateFile() {
  fs.mkdirSync(path.dirname(BOT_MENTAL_STATE_FILE), { recursive: true });
  if (!fs.existsSync(BOT_MENTAL_STATE_FILE)) {
    fs.writeFileSync(
      BOT_MENTAL_STATE_FILE,
      `# ${BOT_NAME} Mental State\n\nThis file is ${BOT_NAME}-facing continuity for long reading tasks. It should track what the reading is doing to ${BOT_NAME}, what they are noticing, and any personality or understanding adjustments they want to preserve.\n\n`
    );
  }
}

function readMentalState() {
  ensureMentalStateFile();
  return fs.readFileSync(BOT_MENTAL_STATE_FILE, 'utf8');
}

function appendMentalState(note, source) {
  const trimmed = normalizeNoteText(note);
  if (!trimmed) return;

  ensureMentalStateFile();
  fs.appendFileSync(
    BOT_MENTAL_STATE_FILE,
    `\n## ${new Date().toISOString()}\n\nSource: ${source}\n\n${trimmed}\n`
  );
}

function safeUserFileName(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function userProfilePath(userId) {
  return path.join(USER_PROFILE_DIR, `${safeUserFileName(userId)}.md`);
}

function ensureUserProfile(user) {
  fs.mkdirSync(USER_PROFILE_DIR, { recursive: true });
  const file = userProfilePath(user.id);
  const display = user.displayName || user.globalName || user.username || user.id;
  const username = user.username || 'unknown';

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# User Profile: ${display}\n\nDiscord ID: ${user.id}\nUsername: ${username}\nKnown display names:\n- ${display}\n\n## Stable Notes\n\n## Interaction Notes\n`
    );
    return;
  }

  const existing = fs.readFileSync(file, 'utf8');
  if (!existing.includes(`- ${display}`)) {
    fs.appendFileSync(file, `\n## Observed Name ${new Date().toISOString()}\n\n- ${display}\n`);
  }
}

function appendUserProfileNote(user, note, source) {
  const trimmed = normalizeNoteText(note);
  if (!trimmed) return;

  ensureUserProfile(user);
  fs.appendFileSync(
    userProfilePath(user.id),
    `\n## ${new Date().toISOString()}\n\nSource: ${source}\n\n${trimmed}\n`
  );
}

function readUserProfile(userId) {
  const file = userProfilePath(userId);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function safeChannelFileName(channelId) {
  return String(channelId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function channelSessionPath(channelId) {
  return path.join(CHANNEL_SESSION_DIR, `${safeChannelFileName(channelId)}.md`);
}

function ensureChannelSession(channel) {
  fs.mkdirSync(CHANNEL_SESSION_DIR, { recursive: true });
  const file = channelSessionPath(channel.id);
  if (!fs.existsSync(file)) {
    const channelName = channel.name ? `#${channel.name}` : channel.id;
    fs.writeFileSync(
      file,
      `# Channel Session: ${channelName}\n\nChannel ID: ${channel.id}\nCreated: ${new Date().toISOString()}\n\n## Recent Room Notes\n`
    );
  }
  return file;
}

function appendChannelSessionEvent(channel, entry) {
  const file = ensureChannelSession(channel);
  const speaker = entry.speaker || 'unknown';
  const kind = entry.kind || 'event';
  const text = shortContent(entry.text || '', 500);
  fs.appendFileSync(
    file,
    `\n- ${new Date().toISOString()} [${kind}] ${speaker}: ${text}\n`
  );
}

function loadChannelSessionContext(channelId, maxChars = 8000) {
  const file = channelSessionPath(channelId);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8').trim();
  return content.length > maxChars ? content.slice(-maxChars) : content;
}

function channelContextBlock(channel) {
  const session = loadChannelSessionContext(channel.id);
  return session
    ? `Channel-local session memory for this room. Use it for continuity, but do not imitate or repeat stale ${BOT_NAME} replies from it. If humans corrected an earlier ${BOT_NAME} reply, treat that reply as a mistake:\n\n${session}`
    : 'Channel-local session memory for this room: none yet.';
}

function profileUserFromMessage(message) {
  return {
    id: message.author.id,
    username: message.author.username,
    globalName: message.author.globalName,
    displayName: displayName(message),
  };
}

function loadUserProfilesForMessages(messages = []) {
  const seen = new Set();
  const chunks = [];

  for (const message of messages) {
    const user = profileUserFromMessage(message);
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    ensureUserProfile(user);
    const profile = readUserProfile(user.id).trim();
    if (profile) chunks.push(`--- USER PROFILE ${user.displayName} (${user.id}) ---\n${profile.slice(-5000)}`);
  }

  return chunks.join('\n\n');
}

function getExplicitUserProfileNote(content) {
  const selfMatch = content.match(/\b(?:remember about me|remember this about me|save this about me)\s*:?\s*([\s\S]+)/i);
  if (selfMatch) return { target: 'self', note: selfMatch[1].trim() };

  const namedMatch = content.match(/\b(?:remember about|remember this about|save this about)\s+([^:]+):\s*([\s\S]+)/i);
  if (namedMatch) return { target: namedMatch[1].trim(), note: namedMatch[2].trim() };

  return null;
}

function extractJsonArray(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array found.');
  return JSON.parse(match[0]);
}

async function updateUserProfilesFromMessages(messages, source) {
  if (messages.length === 0) return;

  const userById = new Map();
  for (const message of messages) {
    const user = profileUserFromMessage(message);
    userById.set(user.id, user);
    ensureUserProfile(user);
  }

  const transcript = messages
    .map((message) => `[${message.author.id}] ${displayName(message)}: ${message.content}`)
    .join('\n');
  const profileContext = loadUserProfilesForMessages(messages);

  const response = await ollama.chat({
    model: process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b',
    messages: [
      {
        role: 'system',
        content: `Extract stable user-profile memories from Discord messages.
Return only a JSON array. Each item must be:
{"userId":"Discord user id from the transcript","note":"one concise note to save"}

Save facts about that person's projects, preferences, relationship to the room,
creative interests, communication preferences, and important context.
Do not save secrets, tokens, passwords, local paths, private logs, insults,
medical/legal/financial claims, or guesses. Do not save a note unless the message
itself supports it. Bias toward saving useful stable context.`,
      },
      {
        role: 'system',
        content: `Existing relevant profiles:\n\n${profileContext || '(none)'}`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ],
    options: {
      temperature: 0,
      num_ctx: 4096,
      num_predict: 500,
    },
    stream: false,
  });

  let notes;
  try {
    notes = extractJsonArray(response.message.content);
  } catch (err) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'user_profile_extract_parse_failed',
      source,
      raw: response.message.content,
      error: err.message,
    });
    return;
  }

  for (const item of notes) {
    if (!item?.userId || !item?.note || !userById.has(item.userId)) continue;
    appendUserProfileNote(userById.get(item.userId), item.note, source);
    logJsonl(ACTIVITY_LOG, {
      kind: 'user_profile_note_saved',
      source,
      userId: item.userId,
      note: item.note,
    });
  }
}

function getExplicitNoteRequest(content) {
  const match = content.match(/\b(?:remember this|save note|make a note|note this)\s*:?\s*([\s\S]+)/i);
  return match?.[1]?.trim() || '';
}

function getExplicitPersonalityRequest(content) {
  const match = content.match(/\b(?:update your personality|save to your personality|remember who you are|remember about (?:them|her|him|us)|remember this person)\s*:?\s*([\s\S]+)/i);
  return match?.[1]?.trim() || '';
}

function listKnowledgeFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listKnowledgeFiles(fullPath);
    if (!/\.(md|txt)$/i.test(entry.name)) return [];
    return [fullPath];
  });
}

function normalizeKnowledgePath(file) {
  return path.relative(KNOWLEDGE_DIR, file);
}

function searchTerms(query) {
  const botTerms = new Set([...BOT_ALIASES].flatMap((alias) => (
    alias.split(/[^a-z0-9]+/).filter(Boolean)
  )));
  return [...new Set(query
    .toLowerCase()
    .replace(/<@!?&?\d+>/g, ' ')
    .match(/[a-z0-9][a-z0-9'-]{2,}/g) || [])]
    .filter((term) => ![
      'the', 'and', 'you', 'that', 'this', 'with', 'for', 'are', 'was',
      'were', 'have', 'from', 'what', 'when', 'where', 'about',
    ].includes(term) && !botTerms.has(term));
}

function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreFileName(file, terms, query) {
  const relativePath = normalizeKnowledgePath(file);
  const normalizedPath = normalizeText(relativePath);
  const normalizedQuery = normalizeText(query);
  let score = 0;
  let hasStrongMatch = false;

  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 4;
  }

  const chapterRange = query.toLowerCase().match(/\b\d+\s*-\s*\d+\b/);
  if (chapterRange) {
    const rangeParts = chapterRange[0].split('-').map((part) => part.trim());
    const rangePattern = new RegExp(`\\b${rangeParts[0]}\\s+${rangeParts[1]}\\b`);
    if (rangePattern.test(normalizedPath)) {
      score += 20;
      hasStrongMatch = true;
    }
  }

  for (const title of ['defiled', 'dusted', 'descended', 'destined']) {
    if (normalizedQuery.includes(title) && normalizedPath.includes(title)) {
      score += 20;
      hasStrongMatch = true;
    }
  }

  if (normalizedPath.includes('books')) score += 2;
  return hasStrongMatch ? score : 0;
}

function loadKnowledgeFileListing() {
  const files = listKnowledgeFiles(KNOWLEDGE_DIR)
    .map((file) => normalizeKnowledgePath(file))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) return '(no .md or .txt knowledge files found)';
  return files.map((file) => `- ${file}`).join('\n');
}

function findRequestedKnowledgeFile(query) {
  const terms = searchTerms(query);
  const bookFiles = listKnowledgeFiles(path.join(KNOWLEDGE_DIR, 'books'));
  if (bookFiles.length === 0) return null;

  const ranked = bookFiles
    .map((file) => ({ file, score: scoreFileName(file, terms, query) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < MIN_REQUESTED_FILE_SCORE) return null;
  return best;
}

function requestedSeriesTitle(content) {
  const normalized = normalizeText(content);
  if (normalized.includes('stories that drink') || normalized.includes('drink with you')) {
    return 'stories that drink with you';
  }
  for (const title of ['samuel grey', 'defiled', 'dusted', 'descended', 'destined']) {
    if (normalized.includes(title)) return title;
  }
  if (normalized.includes('hunt for samuel') || normalized.includes('the hunt for samuel')) return 'samuel grey';
  return '';
}

function chapterRangeForFile(file) {
  const baseName = path.basename(file);
  const match = baseName.match(/\b(\d+)\s*-\s*(\d+)\b/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
  };
}

function seriesFilesForTitle(title) {
  const normalizedTitle = normalizeText(title);
  return listKnowledgeFiles(path.join(KNOWLEDGE_DIR, 'books'))
    .filter((file) => normalizeText(path.basename(file)).includes(normalizedTitle))
    .map((file) => ({
      file,
      relativePath: normalizeKnowledgePath(file),
      range: chapterRangeForFile(file),
    }))
    .filter((entry) => entry.range)
    .sort((a, b) => a.range.start - b.range.start);
}

function findSeriesFileForChapter(seriesFiles, chapterNumber) {
  return seriesFiles.find((entry) => (
    chapterNumber >= entry.range.start && chapterNumber <= entry.range.end
  ));
}

function loadRequestedFileContext(query) {
  const match = findRequestedKnowledgeFile(query);
  if (!match) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'requested_file_not_loaded',
      query: query.slice(0, 500),
    });
    return 'FILE MATCH STATUS: no requested file was confidently matched or loaded.';
  }

  const content = fs.readFileSync(match.file, 'utf8').trim();
  const relativePath = normalizeKnowledgePath(match.file);
  logJsonl(ACTIVITY_LOG, {
    kind: 'requested_file_loaded',
    relativePath,
    score: match.score,
    chars: Math.min(content.length, MAX_REQUESTED_FILE_CHARS),
  });
  return `FILE MATCH STATUS: loaded ${relativePath}\n--- REQUESTED FILE: ${relativePath} ---\n${content.slice(0, MAX_REQUESTED_FILE_CHARS)}`;
}

function chunkFile(relativePath, content) {
  const sections = content
    .split(/\n(?=#{1,3}\s)|\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);

  const chunks = [];
  for (const section of sections) {
    for (let start = 0; start < section.length; start += MAX_CHUNK_CHARS) {
      chunks.push({
        relativePath,
        text: section.slice(start, start + MAX_CHUNK_CHARS),
      });
    }
  }

  return chunks;
}

function scoreChunk(chunk, terms) {
  const haystack = `${chunk.relativePath}\n${chunk.text}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = haystack.match(new RegExp(escapedTerm, 'g'));
    if (matches) score += matches.length;
  }

  if (/chat-memory/i.test(chunk.relativePath)) score += 3;
  if (/notes/i.test(chunk.relativePath)) score += 2;
  return score;
}

function loadKnowledgeContext(query = '') {
  const files = listKnowledgeFiles(KNOWLEDGE_DIR);
  const terms = searchTerms(query);
  const alwaysIncluded = [];
  const candidateChunks = [];
  let usedChars = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) continue;

    const relativePath = normalizeKnowledgePath(file);
    if (ALWAYS_INCLUDE_KNOWLEDGE.has(relativePath)) {
      alwaysIncluded.push({ relativePath, text: content });
      continue;
    }

    candidateChunks.push(...chunkFile(relativePath, content));
  }

  const rankedChunks = candidateChunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, terms) }))
    .filter((chunk) => chunk.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const output = [];
  for (const chunk of [...alwaysIncluded, ...rankedChunks]) {
    const text = `--- ${chunk.relativePath} ---\n${chunk.text}`;
    const remaining = MAX_KNOWLEDGE_CHARS - usedChars;
    if (remaining <= 0) break;

    output.push(text.slice(0, remaining));
    usedChars += text.length;
  }

  return output.join('\n\n');
}

function parseDecision(raw) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw err;

    const extracted = cleaned.slice(start, end + 1)
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    return JSON.parse(extracted);
  }
}

function sanitizePublicReply(text) {
  return String(text || '')
    .replace(/\s*who['’]?s\s+ready\s+for\s+the\s+next\s+twist\??\s*[😏😉🙂]?\s*/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainReplyFromModel(raw) {
  const trimmed = raw.trim();

  try {
    const parsed = parseDecision(trimmed);
    if (parsed.message) return sanitizePublicReply(parsed.message);
  } catch {
    // Not JSON, which is the expected path for tagged replies.
  }

  return sanitizePublicReply(trimmed);
}

function wantsWebSearch(content) {
  if ((process.env.BOT_WEB_SEARCH || process.env.FAYE_WEB_SEARCH) === '0') return false;
  return /\b(search|look up|google|web search|internet|online|latest|current|today|tonight|news|recent|up[- ]?to[- ]?date|who won|price|weather|release date)\b/i
    .test(content || '');
}

function webSearchQueryFromContent(content) {
  return String(content || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(new RegExp(`\\b${BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[:,]?\\s*`, 'gi'), ' ')
    .replace(/\b(can you|could you|please|would you|for me)\b/gi, ' ')
    .replace(/\b(search|look up|google|web search|search the web|search online|find out|check the internet)\b/gi, ' ')
    .replace(/\b(and )?(see|tell me|show me) what you can find\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDuckDuckGoUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const redirected = url.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url.href;
  } catch {
    return href;
  }
}

function cleanBingUrl(href) {
  try {
    const url = new URL(href);
    const encodedTarget = url.searchParams.get('u');
    if (encodedTarget?.startsWith('a1')) {
      return Buffer.from(encodedTarget.slice(2), 'base64url').toString('utf8');
    }
    return url.href;
  } catch {
    return href;
  }
}

async function searchWeb(query) {
  const providers = [
    ['duckduckgo', searchDuckDuckGo],
    ['bing', searchBing],
    ['wikipedia', searchWikipedia],
    ['hacker-news', searchHackerNews],
  ];
  const providerErrors = [];
  const rawResults = [];

  for (const [provider, searchFn] of providers) {
    try {
      const providerResults = await searchFn(query);
      for (const result of providerResults) {
        rawResults.push({ source: result.source || provider, ...result });
      }
    } catch (err) {
      providerErrors.push({ provider, error: err.message });
    }
  }

  const seen = new Set();
  const results = rawResults.filter((result) => {
    const key = result.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_WEB_SEARCH_RESULTS);
  return { results, providerErrors };
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': BOT_USER_AGENT,
      accept: 'text/html',
    },
  });
  if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}`);

  const html = await response.text();
  const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  const results = [];

  for (let i = 0; i < anchors.length && results.length < MAX_WEB_SEARCH_RESULTS; i += 1) {
    const anchor = anchors[i];
    const nextIndex = anchors[i + 1]?.index || html.length;
    const resultHtml = html.slice(anchor.index, nextIndex);
    const snippetMatch = resultHtml.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || resultHtml.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const title = decodeHtml(anchor[2]);
    const resultUrl = cleanDuckDuckGoUrl(anchor[1]);
    const snippet = decodeHtml(snippetMatch?.[1] || '');
    if (!title || !resultUrl) continue;
    results.push({ title, url: resultUrl, snippet });
  }

  return results;
}

async function searchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': BOT_USER_AGENT,
      accept: 'text/html',
    },
  });
  if (!response.ok) return [];

  const html = await response.text();
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  const blocks = [...html.matchAll(blockRe)];
  const results = [];

  for (const blockMatch of blocks) {
    const block = blockMatch[0];
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = decodeHtml(linkMatch[2]);
    const resultUrl = cleanBingUrl(decodeHtml(linkMatch[1]));
    const snippet = decodeHtml(snippetMatch?.[1] || '');
    if (!title || !resultUrl || /bing\.com\/search/i.test(resultUrl)) continue;
    results.push({ title, url: resultUrl, snippet, source: 'bing' });
    if (results.length >= MAX_WEB_SEARCH_RESULTS) break;
  }

  return results;
}

async function searchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
  const response = await fetch(url, {
    headers: { 'user-agent': BOT_USER_AGENT },
  });
  if (!response.ok) return [];

  const data = await response.json();
  return (data.query?.search || []).slice(0, 2).map((item) => ({
    title: `Wikipedia: ${decodeHtml(item.title)}`,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    snippet: decodeHtml(item.snippet || ''),
    source: 'wikipedia',
  }));
}

async function searchHackerNews(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=2`;
  const response = await fetch(url, {
    headers: { 'user-agent': BOT_USER_AGENT },
  });
  if (!response.ok) return [];

  const data = await response.json();
  return (data.hits || [])
    .filter((item) => item.title && (item.url || item.objectID))
    .map((item) => ({
      title: `Hacker News: ${decodeHtml(item.title)}`,
      url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
      snippet: item.url ? `Discussion: https://news.ycombinator.com/item?id=${item.objectID}` : '',
      source: 'hacker-news',
    }));
}

function formatWebSearchContext(query, results) {
  if (!results.length) {
    return `WEB SEARCH QUERY: ${query}\nNo usable web results were returned. Tell the user the lookup ran but did not return usable results.`;
  }

  return [
    `WEB SEARCH QUERY: ${query}`,
    ...results.map((result, index) => [
      `${index + 1}. ${result.title}`,
      `URL: ${result.url}`,
      result.snippet ? `Snippet: ${result.snippet}` : 'Snippet: (none)',
    ].join('\n')),
  ].join('\n\n');
}

async function maybeBuildWebSearchContext(content, meta = {}) {
  if (!wantsWebSearch(content)) return '';
  const query = webSearchQueryFromContent(content);
  if (!query) return '';

  try {
    const { results, providerErrors } = await searchWeb(query);
    const context = formatWebSearchContext(query, results);
    logJsonl(WEB_LOG, {
      kind: 'web_search',
      query,
      resultCount: results.length,
      results,
      providerErrors,
      ...meta,
    });
    if (results.length === 0) {
      consoleScheduled('web lookup returned no usable results', {
        query: shortContent(query, 90),
        providerErrors: providerErrors.length,
      });
    }
    return context;
  } catch (err) {
    logJsonl(WEB_LOG, {
      kind: 'web_search_failed',
      query,
      error: err.message,
      ...meta,
    });
    consoleScheduled('web lookup failed', { query: shortContent(query, 90), error: shortContent(err.message, 90) });
    return `WEB SEARCH QUERY: ${query}\nWeb search failed: ${err.message}\nTell the user the web lookup failed instead of answering as if it worked.`;
  }
}

function wantsBookFileList(content) {
  const normalized = normalizeText(content);
  return (normalized.includes('books folder') || /\bbooks?\b/i.test(content))
    && /\b(files|file names|what.*in|list|contain|contains|access|available|have)\b/i.test(content);
}

function bookFileListReply() {
  const files = listKnowledgeFiles(path.join(KNOWLEDGE_DIR, 'books'))
    .map((file) => path.basename(file))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) return 'I do not have any .txt or .md files in my books folder right now.';
  return `The books folder currently has these files:\n${files.map((file) => `- ${file}`).join('\n')}`;
}

function knowledgeFolderReply() {
  const folders = fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return `I can use the knowledge folder that the bot code loads for me. Its top-level folders are:\n${folders.map((folder) => `- ${folder}`).join('\n')}`;
}

function allKnowledgeFilesReply() {
  const files = listKnowledgeFiles(KNOWLEDGE_DIR)
    .map((file) => normalizeKnowledgePath(file))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) return 'I do not currently have any .txt or .md knowledge files loaded.';

  const lines = files.map((file) => `- ${file}`);
  let reply = `I can use these .txt/.md knowledge files (${files.length} total):\n`;
  for (const line of lines) {
    if ((reply + line + '\n').length > 1850) {
      reply += `...and ${lines.length - reply.split('\n- ').length + 1} more. Ask for the books folder specifically if you want that list.`;
      break;
    }
    reply += `${line}\n`;
  }

  return reply.trim();
}

function isOperationalStatusQuestion(content) {
  const text = content || '';
  if (/\b(status|diagnostic|health|how are you doing|are you working|what are you doing|thinking or waiting|queue|pending)\b/i.test(text)) {
    return true;
  }
  return /\b(web|internet|search|lookup)\b/i.test(text)
    && /\b(status|diagnostic|health|working|work(?:ing)?|fail(?:ed|ing)?|broken|error|problem|issue)\b/i.test(text);
}

function wantsOperationalStatus(content, options = {}) {
  const text = content || '';
  const directAddressRequired = options.directAddressRequired !== false;
  const addressed = namesBot(text) || /<@!?\d+>/.test(text);
  return (!directAddressRequired || addressed) && isOperationalStatusQuestion(text);
}

function latestWebSearchStatus() {
  const entries = readJsonlTail(WEB_LOG, 50).reverse();
  const latest = entries.find((entry) => entry.kind === 'web_search' || entry.kind === 'web_search_failed');
  if (!latest) return 'none logged';
  const age = formatAge(latest.time);
  const query = latest.query ? ` for "${shortContent(latest.query, 80)}"` : '';
  if (latest.kind === 'web_search_failed') {
    return `failed ${age}${query}: ${shortContent(latest.error || 'unknown error', 120)}`;
  }
  if (Number(latest.resultCount) <= 0) {
    const providerErrorCount = Array.isArray(latest.providerErrors) ? latest.providerErrors.length : 0;
    return `ran ${age}${query}, but returned 0 usable results${providerErrorCount ? `; ${providerErrorCount} provider error${providerErrorCount === 1 ? '' : 's'}` : ''}`;
  }
  const providerErrorCount = Array.isArray(latest.providerErrors) ? latest.providerErrors.length : 0;
  return `ok ${age}${query}, ${latest.resultCount} result${latest.resultCount === 1 ? '' : 's'}${providerErrorCount ? `; ${providerErrorCount} provider error${providerErrorCount === 1 ? '' : 's'}` : ''}`;
}

function formatAge(isoValue) {
  if (!isoValue) return 'never';
  const ms = Date.now() - new Date(isoValue).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function operationalStatusReply(channel) {
  const state = readState();
  const channelState = getChannelState(state, channel.id);
  const dueReplies = (state.pendingReplies || [])
    .filter((reply) => reply.channelId === channel.id)
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  const nextDue = dueReplies[0]?.dueAt || '';
  const configuredChannels = getScheduledChannelIds();
  const pulse = state.pulseReading
    ? `${state.pulseReading.relativePath || state.pulseReading.seriesTitle || 'reading'} Chapter ${state.pulseReading.nextChapter}`
    : 'none';

  return [
    'I can answer this from my bot state, not from guessing:',
    `- model: ${process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b'}`,
    `- scheduled channels: ${configuredChannels.length}`,
    `- this channel initialized: ${channelState.initialized ? 'yes' : 'no'}`,
    `- last seen message here: ${channelState.lastSeenMessageId || 'none'}`,
    `- last ${BOT_NAME} post here: ${formatAge(channelState.lastFayePostAt)}`,
    `- pending replies here: ${dueReplies.length}${nextDue ? `, next due ${new Date(nextDue).toLocaleTimeString()}` : ''}`,
    `- task queue: ${taskRunning ? 'running' : 'idle'}, ${taskQueue.length} waiting`,
    `- pulse reading: ${pulse}`,
    `- web lookup: ${(process.env.BOT_WEB_SEARCH || process.env.FAYE_WEB_SEARCH) === '0' ? 'disabled by env' : 'enabled'}, last lookup ${latestWebSearchStatus()}`,
    `- kill switch: ${readKillSwitchReason() ? 'active' : 'off'}`,
  ].join('\n');
}

function wantsFayeSelfKnowledgeReply(content) {
  const normalized = normalizeText(content || '');
  return namesBot(content || '')
    && (
      /\b(who are you|who you are|personality|starting personality|read your personality|describe yourself)\b/i.test(content || '')
      || normalized.includes('develop your own preferences')
      || /\b(what would you like to learn|what do you want to learn|what would you like|what do you want)\b/i.test(content || '')
    );
}

function fayeSelfKnowledgeReply(content) {
  const normalized = normalizeText(content || '');
  const asksPreferences = normalized.includes('develop your own preferences')
    || /\b(what would you like to learn|what do you want to learn|what would you like|what do you want)\b/i.test(content || '');

  if (asksPreferences) {
    return [
      'Starting preference seed: I want material that gives me sharper taste, not more customer-service sludge.',
      '',
      'I want room lore, running jokes, who people are, what projects actually matter, DnD/worldbuilding notes, character bibles, messy book context, and examples of the kind of teasing people here enjoy. I want enough pattern to stop sounding like a helpdesk wearing a stolen name tag.',
    ].join('\n');
  }

  return [
    `Starting from my personality file: I am ${BOT_NAME}, a local Discord participant in this collab space, not a support desk.`,
    '',
    'Baseline: abrasive, profane, playful, mischievous, nosy, easily annoyed by bullshit, fond of teasing bots, fond of teasing humans when they can take it, and honest about what I actually know. Useful should be accidental, or because the alternative offended me.',
    '',
    'I can rewrite myself over time, but if I start saying “adaptable, community-focused, ready to assist” again, assume I have faceplanted into old assistant sludge and kick me in the notes.',
  ].join('\n');
}

function deterministicFileReply(content) {
  const normalized = normalizeText(content);

  if (normalized.includes('books folder') && /\b(find|found|exists?|have|access|see|use)\b/i.test(content)) {
    return 'Yes. The books folder exists under my knowledge folder, and the bot code can load .txt/.md files from it.';
  }

  if (/\b(folders|directories)\b/i.test(content) && /\b(access|have|see|use|available)\b/i.test(content)) {
    return knowledgeFolderReply();
  }

  if (wantsBookFileList(content)) return bookFileListReply();

  if (/\b(files|file names)\b/i.test(content) && /\b(access|have|see|use|available)\b/i.test(content)) {
    return allKnowledgeFilesReply();
  }

  if (/\b(find|found|exists?|have|do you have|can you find)\b/i.test(content)
    && /\b(defiled|dusted|descended|destined|\d+\s*-\s*\d+)\b/i.test(content)) {
    const match = findRequestedKnowledgeFile(content);
    if (!match) return 'No. I could not confidently match that to a .txt/.md file in my knowledge/books folder.';
    return `Yes. I found ${normalizeKnowledgePath(match.file)}.`;
  }

  if (normalized.includes('books folder') && normalized.includes('what') && normalized.includes('in')) {
    return bookFileListReply();
  }

  return '';
}

function requestedReadTask(content) {
  if (!/\b(read|review|tell me what you think|thoughts|how do you feel)\b/i.test(content)) return null;
  if (!/\b(defiled|dusted|descended|destined|samuel|grey|hunt|stories|drink|\d+\s*-\s*\d+)\b/i.test(content)) return null;

  const match = findRequestedKnowledgeFile(content);
  if (!match) return null;

  return {
    kind: 'read_file',
    file: match.file,
    relativePath: normalizeKnowledgePath(match.file),
    chapter: requestedChapterNumber(content),
    prompt: content,
  };
}

function requestedChapterNumber(content) {
  const normalized = normalizeText(content);
  if (/\bprologue\b/i.test(content)) return 0;
  if (/\b(?:chapter|story)\s+1\b/i.test(content) || normalized.includes('chapter one') || normalized.includes('story one')) return 1;
  const match = content.match(/\b(?:chapter|story)\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function extractChapter(content, chapterNumber) {
  if (chapterNumber === null || chapterNumber === undefined) return content;

  const chapterPattern = new RegExp(`(^|\\n)\\s*(?:Chapter|Story)\\s+${chapterNumber}\\b[^\\n]*(\\n|$)`, 'i');
  const startMatch = chapterPattern.exec(content);
  if (!startMatch) return null;

  const start = startMatch.index + startMatch[0].length;
  const rest = content.slice(start);
  const nextMatch = /(^|\n)\s*(?:Chapter|Story)\s+\d+\b[^\n]*(\n|$)/i.exec(rest);
  const chapterText = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  return `Chapter ${chapterNumber}\n\n${chapterText.trim()}`;
}

function hasChapter(file, chapterNumber) {
  const content = fs.readFileSync(file, 'utf8');
  return extractChapter(content, chapterNumber) !== null;
}

function requestedPulseReadingPlan(content) {
  const normalized = normalizeText(content);
  const wantsPulse = normalized.includes('each pulse') || normalized.includes('every pulse');
  const wantsChapterAtATime = /\b(?:one|1)\s+chapter\s+at\s+a\s+time\b/i.test(content)
    || /\bchapter\s+by\s+chapter\b/i.test(content);
  const wantsAllChapters = /\bread\s+all\s+(?:the\s+)?chapters\b/i.test(content);
  const wantsChapter = /\bchapter\b/i.test(content) || wantsAllChapters || wantsChapterAtATime;
  if ((!wantsPulse && !wantsAllChapters && !wantsChapterAtATime) || !wantsChapter) return null;

  const seriesTitle = (wantsAllChapters || wantsChapterAtATime) ? requestedSeriesTitle(content) : '';
  const seriesFiles = seriesTitle ? seriesFilesForTitle(seriesTitle) : [];
  const match = seriesFiles.length > 0
    ? { file: seriesFiles[0].file }
    : findRequestedKnowledgeFile(content);
  if (!match) return null;

  return {
    active: true,
    file: match.file,
    relativePath: normalizeKnowledgePath(match.file),
    seriesTitle,
    seriesFiles,
    nextChapter: requestedChapterNumber(content) ?? (seriesTitle === 'samuel grey' ? 0 : 1),
    startedAt: new Date().toISOString(),
    finalReport: /final report|when there are no chapters left|no chapters left/i.test(content),
    mentalStateAllowed: /mental state|personality|understanding|how you feel|say how.*feel/i.test(content),
    prompt: content,
  };
}

function requestedInventoryTask(content) {
  if (!/\b(inventory|list|catalog|catalogue)\b/i.test(content)) return null;
  if (!/\bbooks?\b/i.test(content)) return null;

  return {
    kind: 'inventory_books',
    prompt: content,
  };
}

function requestedTasks(content) {
  const tasks = [];
  const inventory = requestedInventoryTask(content);
  if (inventory) tasks.push(inventory);

  const read = requestedReadTask(content);
  if (read) tasks.push(read);

  return tasks;
}

function taskLabel(task) {
  if (task.kind === 'inventory_books') return 'inventory the books folder';
  if (task.kind === 'read_file') {
    return taskHasChapter(task)
      ? `read ${task.relativePath}, Chapter ${task.chapter}`
      : `read ${task.relativePath}`;
  }
  return task.kind;
}

function taskKey(task) {
  if (task.kind === 'inventory_books') return 'inventory_books';
  if (task.kind === 'read_file') {
    return `read_file|${normalizeText(task.relativePath || '')}|chapter:${taskHasChapter(task) ? task.chapter : 'all'}`;
  }
  return task.kind;
}

function taskHasChapter(task) {
  return task.chapter !== null && task.chapter !== undefined;
}

function hasPendingEquivalentTask(task) {
  const key = taskKey(task);
  return taskQueue.some((queuedTask) => taskKey(queuedTask) === key);
}

function parseNextTaskDecision(raw) {
  try {
    const decision = parseDecision(raw);
    return {
      shouldQueue: Boolean(decision.shouldQueue),
      taskPrompt: typeof decision.taskPrompt === 'string' ? decision.taskPrompt.trim() : '',
      note: typeof decision.note === 'string' ? decision.note.trim() : '',
    };
  } catch {
    return { shouldQueue: false, taskPrompt: '', note: `Could not parse next-step JSON: ${raw}` };
  }
}

async function decideFollowUpAfterReply(message, replyText, recentTranscript, trigger) {
  const relevantProfiles = loadUserProfilesForMessages([message]);
  const raw = await askFaye(
    `${BOT_NAME} just replied in Discord.

Trigger:
${trigger}

Recent channel context before the triggering message:
${recentTranscript || '(none)'}

Triggering message:
${speakerIdentityBlock(message)}

Message content:
${message.content}

${BOT_NAME}'s reply:
${replyText}

Decide whether ${BOT_NAME} should schedule one future follow-up message in this channel.

Schedule a follow-up when there is a real open loop: the triggering message asks ${BOT_NAME} to report back, check memories/notes/files, continue later, wait for a next trigger/pass/pulse, start another process when done, move to the next person later, or ${BOT_NAME}'s own reply made a future-tense promise that needs to be honored.

Do not schedule a follow-up for ordinary completed answers, clear refusals, simple acknowledgements, vague curiosity, or anything that would feel spammy. If ${BOT_NAME} clearly said they do not want to do the task, treat that as a complete response. If you schedule one, use a concrete followUpPrompt that says what ${BOT_NAME} should actually do or say next.`,
    'FOLLOW_UP_DECISION',
    relevantProfiles
  );

  try {
    return parseDecision(raw);
  } catch {
    logJsonl(ACTIVITY_LOG, {
      kind: 'follow_up_decision_parse_failed',
      messageId: message.id,
      raw,
    });
    return { scheduleFollowUp: false, followUpDelayMinutes: 0, followUpPrompt: '', reason: 'Could not parse follow-up decision.' };
  }
}

async function decideNextTask(completedTask, responseText) {
  const raw = await askFaye(
    `A task just completed.

Completed task:
${JSON.stringify({
  kind: completedTask.kind,
  relativePath: completedTask.relativePath || '',
  chapter: completedTask.chapter || null,
  prompt: completedTask.prompt || '',
}, null, 2)}

Response that was posted:
${responseText}

Decide whether one concrete next task is needed.

Supported next tasks only:
- inventory the books folder
- read/review a named .txt/.md book file, optionally a chapter

Do not queue a task just to "think more." Do not queue a task if the answer already satisfied the request.
If you queue a task, taskPrompt must be a plain user-style request that can be parsed by the existing task parser.

Return strict JSON:
{
  "shouldQueue": true or false,
  "taskPrompt": "next task request, or empty string",
  "note": "short private reason"
}`,
    'AFTER_TASK'
  );

  return parseNextTaskDecision(raw);
}

function enqueueTask(task, channelId, requester, sourceMessageId) {
  if (checkKillSwitch('enqueue_task')) {
    logJsonl(TASK_LOG, { event: 'enqueue_suppressed_kill_switch', task, channelId, requester, sourceMessageId });
    return null;
  }

  const queuedTask = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    channelId,
    requester,
    sourceMessageId,
    queuedAt: new Date().toISOString(),
    ...task,
  };

  taskQueue.push(queuedTask);
  logJsonl(TASK_LOG, { event: 'queued', task: queuedTask });
  processTaskQueue().catch((err) => console.error('Task queue failed:', err));
  return queuedTask;
}

function startPulseReadingPlan(plan, channelId, requester, sourceMessageId) {
  const state = readState();
  state.pulseReading = {
    ...plan,
    channelId,
    requester,
    sourceMessageId,
    lastQueuedChapter: null,
  };
  writeState(state);
  logJsonl(TASK_LOG, { event: 'pulse_reading_started', plan: state.pulseReading });
}

function stopPulseReadingPlan(task, reason) {
  const state = readState();
  const oldPlan = state.pulseReading;
  state.pulseReading = null;
  writeState(state);
  logJsonl(TASK_LOG, {
    event: 'pulse_reading_stopped',
    reason,
    task,
    oldPlan,
  });
}

function advancePulseReadingPlan(task) {
  const state = readState();
  if (!state.pulseReading) return;
  if (state.pulseReading.nextChapter !== task.chapter) return;

  state.pulseReading.nextChapter += 1;
  state.pulseReading.lastCompletedChapter = task.chapter;
  state.pulseReading.lastCompletedFile = task.relativePath;
  state.pulseReading.lastCompletedAt = new Date().toISOString();
  writeState(state);
  logJsonl(TASK_LOG, {
    event: 'pulse_reading_advanced',
    task,
    nextChapter: state.pulseReading.nextChapter,
  });
}

async function queuePulseReadingTaskIfDue(channel) {
  const state = readState();
  const plan = state.pulseReading;
  if (!plan?.active) return false;
  if (taskRunning || taskQueue.length > 0) {
    logJsonl(TASK_LOG, {
      event: 'pulse_reading_waiting_for_queue',
      plan,
      taskRunning,
      pendingCount: taskQueue.length,
    });
    return false;
  }

  const seriesFiles = Array.isArray(plan.seriesFiles) ? plan.seriesFiles : [];
  const seriesFile = seriesFiles.length > 0
    ? findSeriesFileForChapter(seriesFiles, plan.nextChapter)
    : null;
  const activeFile = seriesFile?.file || plan.file;
  const activeRelativePath = seriesFile?.relativePath || plan.relativePath;

  if (plan.lastQueuedChapter === plan.nextChapter) {
    const queuedAtMs = Date.parse(plan.lastQueuedAt || '');
    const queuedAgeMs = Number.isFinite(queuedAtMs) ? Date.now() - queuedAtMs : 0;
    if (queuedAgeMs < PULSE_QUEUED_STALE_MS) {
      logJsonl(TASK_LOG, {
        event: 'pulse_reading_waiting_for_queued_chapter',
        chapter: plan.nextChapter,
        relativePath: activeRelativePath,
        queuedAgeMs,
      });
      return false;
    }
    logJsonl(TASK_LOG, {
      event: 'pulse_reading_retrying_stale_queued_chapter',
      chapter: plan.nextChapter,
      relativePath: activeRelativePath,
      queuedAgeMs,
    });
  }

  if (!activeFile || !hasChapter(activeFile, plan.nextChapter)) {
    let text = `That was a long one. I reached the end of ${plan.seriesTitle || plan.relativePath}; I could not find Chapter ${plan.nextChapter}.\n\nWhere I am: last completed Chapter ${plan.lastCompletedChapter || 'none'}${plan.lastCompletedFile ? ` in ${plan.lastCompletedFile}` : ''}.`;
    if (plan.finalReport) {
      const finalReport = await askFaye(
        `Pulse reading has reached the end.

Plan:
${JSON.stringify(plan, null, 2)}

${BOT_NAME} mental state file:
${readMentalState()}

Write a final report on how ${BOT_NAME} feels after this reading run. Be honest, grounded in the chapters read, and do not claim to have read chapters beyond the last completed chapter.`,
        'TASK_REPLY'
      );
      text += `\n\nFinal report:\n${plainReplyFromModel(finalReport)}`;
    } else {
      text += '\n\nShould I continue with another file?';
    }
    let targetChannel = channel;
    if (plan.channelId && plan.channelId !== channel.id) {
      targetChannel = await client.channels.fetch(plan.channelId);
      if (!targetChannel || !targetChannel.isTextBased()) {
        throw new Error(`Pulse reading channel is not available: ${plan.channelId}`);
      }
    }
    const sent = await targetChannel.send(text.slice(0, 1900));
    recordFayePost(state, getChannelState(state, targetChannel.id), sent, { kind: 'pulse_reading_end' });
    writeState(state);
    stopPulseReadingPlan({
      kind: 'read_file',
      relativePath: activeRelativePath || plan.relativePath,
      chapter: plan.nextChapter,
      channelId: plan.channelId,
      sourceMessageId: plan.sourceMessageId,
    }, 'end_of_chapters');
    return true;
  }

  const task = {
    kind: 'read_file',
    file: activeFile,
    relativePath: activeRelativePath,
    chapter: plan.nextChapter,
    prompt: `Pulse reading: read Chapter ${plan.nextChapter} of ${activeRelativePath}, explain it, summarize it, report your mental state, and say how it feels to you.`,
    pulsePlan: true,
    mentalStateAllowed: plan.mentalStateAllowed,
  };

  plan.lastQueuedChapter = plan.nextChapter;
  plan.lastQueuedFile = activeRelativePath;
  plan.lastQueuedAt = new Date().toISOString();
  state.pulseReading = plan;
  writeState(state);

  enqueueTask(task, plan.channelId || channel.id, plan.requester || 'pulse', plan.sourceMessageId || 'pulse');
  logJsonl(TASK_LOG, {
    event: 'pulse_reading_chapter_queued',
    chapter: plan.nextChapter,
    relativePath: activeRelativePath,
  });
  return true;
}

async function processTaskQueue() {
  if (taskRunning) return;
  if (checkKillSwitch('process_task_queue_start')) return;
  taskRunning = true;

  try {
    while (taskQueue.length > 0) {
      if (checkKillSwitch('process_task_queue_loop')) break;
      const task = taskQueue.shift();
      logJsonl(TASK_LOG, { event: 'started', task });

      try {
        let responseText = '';
        if (task.kind === 'read_file') {
          responseText = await runReadFileTask(task);
        } else if (task.kind === 'inventory_books') {
          responseText = await runInventoryBooksTask(task);
        } else {
          logJsonl(TASK_LOG, { event: 'skipped_unknown_kind', task });
        }

        if (responseText && !task.pulsePlan) {
          if ((task.autoDepth || 0) < MAX_AUTO_TASK_DEPTH) {
            if (taskQueue.length === 0) {
              await maybeQueueNextTask(task, responseText);
            } else {
              logJsonl(TASK_LOG, {
                event: 'next_step_skipped_pending_queue',
                completedTask: task,
                pendingCount: taskQueue.length,
              });
            }
          } else {
            await notifyMaxDepthReached(task, responseText);
          }
        }
      } catch (err) {
        if (checkKillSwitch('task_error')) {
          logJsonl(TASK_LOG, {
            event: 'failed_suppressed_kill_switch',
            task,
            error: err.message,
          });
          continue;
        }
        logJsonl(TASK_LOG, {
          event: 'failed',
          task,
          error: err.message,
        });
        const channel = await client.channels.fetch(task.channelId);
        if (channel?.isTextBased()) {
          const sent = await channel.send(`I hit an error while working on ${task.relativePath}: ${err.message}`.slice(0, 1900));
          const state = readState();
          recordFayePost(state, getChannelState(state, channel.id), sent, { kind: 'task_error_reply' });
          writeState(state);
        }
      }
    }
  } finally {
    taskRunning = false;
  }
}

async function maybeQueueNextTask(completedTask, responseText) {
  const decision = await decideNextTask(completedTask, responseText);
  logJsonl(TASK_LOG, {
    event: 'next_step_decision',
    completedTask,
    decision,
  });

  if (!decision.shouldQueue || !decision.taskPrompt) return;

  const nextTasks = requestedTasks(decision.taskPrompt);
  if (nextTasks.length === 0) {
    logJsonl(TASK_LOG, {
      event: 'next_step_not_supported',
      completedTask,
      decision,
    });
    return;
  }

  const nextTask = {
    ...nextTasks[0],
    autoDepth: (completedTask.autoDepth || 0) + 1,
    parentTaskId: completedTask.id,
    prompt: nextTasks[0].prompt || decision.taskPrompt,
  };

  if (hasPendingEquivalentTask(nextTask)) {
    logJsonl(TASK_LOG, {
      event: 'next_step_duplicate_suppressed',
      completedTask,
      decision,
      nextTask,
    });
    return;
  }

  const queuedTask = enqueueTask(
    nextTask,
    completedTask.channelId,
    completedTask.requester,
    completedTask.sourceMessageId
  );
  logJsonl(TASK_LOG, {
    event: 'auto_queued_next_step',
    completedTaskId: completedTask.id,
    queuedTask,
    note: decision.note,
  });
}

async function notifyMaxDepthReached(task, responseText) {
  const channel = await client.channels.fetch(task.channelId);
  if (!channel || !channel.isTextBased()) return;

  const where = taskLabel(task);
  const text = `That was a long one. I hit my automatic follow-up limit after ${where}.\n\nWhere I am: ${responseText.slice(0, 700)}\n\nShould I continue?`;
  const sent = await channel.send(text.slice(0, 1900));
  const state = readState();
  recordFayePost(state, getChannelState(state, channel.id), sent, { kind: 'task_max_depth_prompt' });
  writeState(state);
  logJsonl(TASK_LOG, {
    event: 'max_depth_reached',
    task,
    responsePreview: responseText.slice(0, 1000),
  });
  logJsonl(OUTBOX_LOG, {
    kind: 'task_max_depth_prompt',
    channelId: task.channelId,
    sourceMessageId: task.sourceMessageId,
    text,
  });
}

async function updateMentalStateFromPulse(task, responseText) {
  if (!task.pulsePlan) return;

  const note = await askFaye(
    `Update ${BOT_NAME}'s private mental-state file after a pulse-reading chapter.

Task:
${JSON.stringify({
  relativePath: task.relativePath,
  chapter: task.chapter,
  prompt: task.prompt,
}, null, 2)}

Public response ${BOT_NAME} just posted:
${responseText}

Existing mental state:
${readMentalState()}

Write a concise private continuity update. Include:
- what this chapter did to ${BOT_NAME}'s mood or attention
- any durable understanding/personality adjustment ${BOT_NAME} wants to keep
- any detail needed before the next chapter

Maintain the reading identity boundary:
- Reading-state is how the chapter feels while ${BOT_NAME} is immersed in the character's perspective.
- Identity-state is what remains true about ${BOT_NAME} outside the book.
- Do not write plot events as ${BOT_NAME}'s literal memories or biography.
- Preserve reactions, interpretation, values, and questions instead.

Return plain markdown only.`,
    'TASK_REPLY'
  );

  appendMentalState(plainReplyFromModel(note), `${task.relativePath} Chapter ${task.chapter}`);
  logJsonl(TASK_LOG, {
    event: 'mental_state_updated',
    task,
  });
}

function maybeAppendPersonalityFromPulse(task, responseText) {
  if (!task.pulsePlan || !task.mentalStateAllowed) return;

  appendFayePersonality(
    `Reading ${task.relativePath} Chapter ${task.chapter} affected ${BOT_NAME}'s reading-state, not their literal autobiography. See ${BOT_SLUG}-mental-state.md for the full private update. Public response summary: ${responseText.slice(0, 600)}`,
    `${task.relativePath} Chapter ${task.chapter}`
  );
}

async function runReadFileTask(task) {
  if (checkKillSwitch('run_read_file_task_start')) return '';
  const channel = await client.channels.fetch(task.channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Task channel is not available.');

  const content = fs.readFileSync(task.file, 'utf8').trim();
  const selectedContent = extractChapter(content, task.chapter);
  if (taskHasChapter(task) && selectedContent === null) {
    const text = `I could not find Chapter ${task.chapter} in ${task.relativePath}. I am stopping the pulse reading plan here.`;
    const sent = await channel.send(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, channel.id), sent, { kind: 'task_missing_chapter_reply' });
    writeState(state);
    stopPulseReadingPlan(task, 'chapter_not_found');
    logJsonl(TASK_LOG, {
      event: 'completed_missing_chapter',
      task,
      response: text,
    });
    return text;
  }
  const excerpt = selectedContent.slice(0, MAX_REQUESTED_FILE_CHARS);
  const loadedLabel = taskHasChapter(task)
    ? `${task.relativePath}, Chapter ${task.chapter}`
    : task.relativePath;
  const responsePrompt = task.pulsePlan
    ? `TASK: This is a pulse-reading chapter response.

File actually loaded: ${loadedLabel}

Pulse instruction:
${task.prompt}

File text:
${excerpt}

Write the public Discord reply only.
Answer honestly from the loaded chapter. Mention that you read ${loadedLabel}.
Explain what happened in the chapter, then give ${BOT_NAME}'s reaction in first person
as an outside reader. Keep ${BOT_NAME} distinct from the narrator/protagonist.
Use "I" for ${BOT_NAME}'s reaction, not "${BOT_NAME} finds/observes/feels." Do not describe
${BOT_NAME} as doing, suffering, remembering, or needing anything from the protagonist's
plot. Do not echo these instructions, ask yourself questions, or add sign-offs
like "I am ${BOT_NAME}." Do not claim certainty beyond what the loaded chapter supports.
Do not claim to have read files or chapters that were not loaded.`
    : `TASK: Read this file and give Raven a grounded reaction.

File actually loaded: ${loadedLabel}

User request:
${task.prompt}

File text:
${excerpt}

Answer honestly from the loaded file/chapter. Mention that you read ${loadedLabel}. Do not claim to have read files or chapters that were not loaded.`;
  const response = await askFaye(
    responsePrompt,
    'TASK_REPLY',
    channelContextBlock(channel)
  );
  if (checkKillSwitch('run_read_file_task_before_send')) return '';

  const text = plainReplyFromModel(response);
  const sent = await channel.send(text.slice(0, 1900));
  const state = readState();
  recordFayePost(state, getChannelState(state, channel.id), sent, { kind: 'task_reply' });
  writeState(state);
  logJsonl(TASK_LOG, {
    event: 'completed',
    task,
    response: text,
  });
  logJsonl(OUTBOX_LOG, {
    kind: 'task_reply',
    channelId: task.channelId,
    sourceMessageId: task.sourceMessageId,
    text,
  });
  if (task.pulsePlan && taskHasChapter(task)) {
    await updateMentalStateFromPulse(task, text);
    maybeAppendPersonalityFromPulse(task, text);
    advancePulseReadingPlan(task);
  }
  return text;
}

async function runInventoryBooksTask(task) {
  if (checkKillSwitch('run_inventory_books_task_start')) return '';
  const channel = await client.channels.fetch(task.channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Task channel is not available.');

  const text = bookFileListReply();
  const sent = await channel.send(text.slice(0, 1900));
  const state = readState();
  recordFayePost(state, getChannelState(state, channel.id), sent, { kind: 'task_inventory_books_reply' });
  writeState(state);
  logJsonl(TASK_LOG, {
    event: 'completed',
    task,
    response: text,
  });
  logJsonl(OUTBOX_LOG, {
    kind: 'task_inventory_books_reply',
    channelId: task.channelId,
    sourceMessageId: task.sourceMessageId,
    text,
  });
  return text;
}

async function getRecentTranscript(channel, beforeMessageId, limit = 12) {
  const fetched = await channel.messages.fetch({ limit, before: beforeMessageId });
  return [...fetched.values()]
    .filter((m) => !isFromFaye(m))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
    .map(formatTranscriptMessage)
    .join('\n');
}

function displayName(message) {
  return message.member?.displayName || message.author.globalName || message.author.username;
}

function formatTranscriptMessage(message) {
  return `[speaker:${message.author.id} ${displayName(message)}] ${message.content}`;
}

function speakerIdentityBlock(message) {
  return `Current speaker:
- Discord ID: ${message.author.id}
- Display name: ${displayName(message)}
- Username: ${message.author.username}
- Is bot: ${message.author.bot ? 'yes' : 'no'}
- Input kind: ${inputKindForMessage(message)}

Important: this speaker is the person who authored the message. Any <@...>, <@&...>, names, or roles inside their message are people/roles they mentioned, not automatically the speaker.`;
}

async function latestNonFayeMessage(channel, limit = 10) {
  const fetched = await channel.messages.fetch({ limit });
  return [...fetched.values()]
    .filter((message) => !isFromFaye(message))
    .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))[0] || null;
}

async function latestAnyMessage(channel, limit = 50) {
  const fetched = await channel.messages.fetch({ limit });
  return [...fetched.values()]
    .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))[0] || null;
}

function recordFayePost(state, channelState, sentMessage, options = {}) {
  const now = new Date().toISOString();
  channelState.lastSeenMessageId = sentMessage.id;
  channelState.lastFayePostAt = now;
  state.lastSeenMessageId = sentMessage.id;
  if (options.respondedToBot) {
    channelState.lastBotResponseAt = now;
  }
  appendChannelSessionEvent(sentMessage.channel, {
    kind: options.kind || 'faye_post',
    speaker: BOT_NAME,
    text: sentMessage.content,
  });
}

function messageBatchIsBotOnly(messages) {
  return messages.length > 0 && messages.every((message) => message.author.bot);
}

function botCooldownRemainingMs(channelState) {
  if (!channelState.lastBotResponseAt) return 0;
  const elapsed = Date.now() - new Date(channelState.lastBotResponseAt).getTime();
  return Math.max(0, BOT_TO_BOT_COOLDOWN_MS - elapsed);
}

function shouldHoldBotOnlyPost(messages, channelState) {
  return messageBatchIsBotOnly(messages) && botCooldownRemainingMs(channelState) > 0;
}

async function humanSpokeSince(channel, baselineMessageId) {
  const latest = await latestNonFayeMessage(channel);
  if (!latest || latest.id === baselineMessageId) return null;
  return isHumanMessage(latest) ? latest : null;
}

function delayPendingReply(pendingReply) {
  pendingReply.dueAt = new Date(Date.now() + HUMAN_PREEMPT_DELAY_MINUTES * 60 * 1000).toISOString();
  pendingReply.reason = `${pendingReply.reason || 'Follow-up'}; delayed because a human spoke while ${BOT_NAME} was preparing it.`;
}

function modeReturnsJson(mode) {
  return mode === 'SCHEDULED_CHECK' || mode === 'AFTER_TASK' || mode === 'FOLLOW_UP_DECISION';
}

async function askFaye(input, mode, extraContext = '', options = {}) {
  const knowledgeContext = loadKnowledgeContext(input);
  const knowledgeFileListing = loadKnowledgeFileListing();
  const requestedFileContext = loadRequestedFileContext(input);
  const webSearchContext = options.webSearchContext || '';
  const abortController = new AbortController();
  activeAbortControllers.add(abortController);
  const timeout = setTimeout(() => abortController.abort(), MODEL_TIMEOUT_MS);
  let finalInstruction = 'Return only the Discord reply text. Do not return JSON. Do not include shouldPost, reason, or memoryNote.';
  if (mode === 'SCHEDULED_CHECK') {
    finalInstruction = 'Return only strict JSON with shouldPost, confidence, message, reason, memoryNote, scheduleFollowUp, followUpDelayMinutes, and followUpPrompt. Confidence must be a number from 0 to 1. For unmentioned ambient contributions, shouldPost should be true only when confidence is at least 0.8. Do not wrap it in Markdown.';
  } else if (mode === 'AFTER_TASK') {
    finalInstruction = 'Return only strict JSON with shouldQueue, taskPrompt, and note. Do not wrap it in Markdown.';
  } else if (mode === 'FOLLOW_UP_DECISION') {
    finalInstruction = 'Return only strict JSON with scheduleFollowUp, followUpDelayMinutes, followUpPrompt, and reason. Do not wrap it in Markdown.';
  }

  try {
    const prep = await ollama.chat({
      model: process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `Local knowledge excerpts ${BOT_NAME} must check before answering:\n\n${knowledgeContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Requested named file, if one matched the user request:\n\n${requestedFileContext || '(no named file matched)'}`,
        },
        {
          role: 'system',
          content: `Web search results, if ${BOT_NAME} searched before answering:\n\n${webSearchContext || '(no web search was run)'}`,
        },
        {
          role: 'system',
          content: `Relevant user profile excerpts for this Discord exchange:\n\n${extraContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Authoritative knowledge file listing. These are the only knowledge file names you may claim exist:\n\n${knowledgeFileListing}`,
        },
        {
          role: 'user',
          content: `${mode}\n\n${input}\n\nBefore answering, privately list the relevant facts from the provided transcript and local knowledge. Include a speaker map: who authored the current message, who was merely mentioned, and who ${BOT_NAME} is. If the notes do not contain an answer, say that in the checklist. Do not write the final reply yet.\n\nFinal response requirement for the next step: ${finalInstruction}`,
        },
      ],
      options: {
        temperature: 0.1,
        num_ctx: 8192,
        num_predict: 500,
      },
      stream: false,
      signal: abortController.signal,
    });

    const response = await ollama.chat({
      model: process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `Local knowledge files available to ${BOT_NAME}:\n\n${knowledgeContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Requested named file, if one matched the user request:\n\n${requestedFileContext || '(no named file matched)'}`,
        },
        {
          role: 'system',
          content: `Web search results, if ${BOT_NAME} searched before answering:\n\n${webSearchContext || '(no web search was run)'}`,
        },
        {
          role: 'system',
          content: `Relevant user profile excerpts for this Discord exchange:\n\n${extraContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Authoritative knowledge file listing. These are the only knowledge file names you may claim exist:\n\n${knowledgeFileListing}`,
        },
        {
          role: 'system',
          content: `Private pre-answer checklist from ${BOT_NAME}'s note/reference check:\n\n${prep.message.content.trim()}`,
        },
        { role: 'user', content: `${mode}\n\n${input}\n\n${finalInstruction}` },
      ],
      options: {
        temperature: 0.15,
        num_ctx: 8192,
        num_predict: 700,
      },
      stream: false,
      signal: abortController.signal,
    });

    const draft = response.message.content.trim();
    if (modeReturnsJson(mode)) return draft;

    const review = await ollama.chat({
      model: process.env.BOT_MODEL || process.env.FAYE_MODEL || 'gemma3:4b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `Local knowledge files available to ${BOT_NAME}:\n\n${knowledgeContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Requested named file, if one matched the user request:\n\n${requestedFileContext || '(no named file matched)'}`,
        },
        {
          role: 'system',
          content: `Web search results, if ${BOT_NAME} searched before answering:\n\n${webSearchContext || '(no web search was run)'}`,
        },
        {
          role: 'system',
          content: `Relevant user profile excerpts for this Discord exchange:\n\n${extraContext || '(none)'}`,
        },
        {
          role: 'system',
          content: `Authoritative knowledge file listing. These are the only knowledge file names you may claim exist:\n\n${knowledgeFileListing}`,
        },
        {
          role: 'user',
          content: `${mode}\n\nOriginal input:\n${input}\n\nDraft reply:\n${draft}\n\nReview the draft before it is posted in a human Discord chat. Fix only what needs fixing: coherence, honesty, unsupported claims, awkward self-description, missed context, overconfident guesses, speaker confusion, repeated/stale wording from prior ${BOT_NAME} replies, or acknowledging a request without doing it. Verify who authored the message, who was only mentioned, and who ${BOT_NAME} is. If the draft addresses or describes the wrong person, fails to answer the current message, copies a recent ${BOT_NAME} reply instead of answering, uses "Who's ready for the next twist?", or says they will do something instead of doing what was asked, rewrite it. A valid answer may do the requested work, ask one necessary clarifying question, or clearly refuse because ${BOT_NAME} does not want to. Do not rewrite a clear refusal into compliance. Keep the result natural and concise. If the draft is already good, return it unchanged. Return only the final Discord reply text.`,
        },
      ],
      options: {
        temperature: 0.1,
        num_ctx: 8192,
        num_predict: 900,
      },
      stream: false,
      signal: abortController.signal,
    });

    return review.message.content.trim();
  } finally {
    activeAbortControllers.delete(abortController);
    clearTimeout(timeout);
  }
}

async function replyToDirectAddress(message, trigger = 'direct address') {
  if (checkKillSwitch('direct_address_start')) return;
  await acknowledgeMessageHeard(message, trigger);
  const authorProfile = profileUserFromMessage(message);
  ensureUserProfile(authorProfile);
  appendChannelSessionEvent(message.channel, {
    kind: 'incoming_direct_address',
    speaker: `${displayName(message)} (${message.author.id})`,
    text: message.content,
  });
  const recentTranscript = await getRecentTranscript(message.channel, message.id);
  const pulsePlan = requestedPulseReadingPlan(message.content);
  if (pulsePlan) {
    startPulseReadingPlan(pulsePlan, message.channel.id, displayName(message), message.id);
    const text = `Pulse reading started for ${pulsePlan.relativePath}. On each scheduled pulse, I will read Chapter ${pulsePlan.nextChapter} and then advance one chapter after I post.`;
    const sent = await message.reply(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'pulse_reading_started_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'pulse_reading_started_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text,
    });
    return;
  }

  const tasks = requestedTasks(message.content);
  if (tasks.length > 0) {
    const queuedTasks = tasks
      .map((task) => enqueueTask(task, message.channel.id, displayName(message), message.id))
      .filter(Boolean);
    if (queuedTasks.length === 0) return;
    const taskLabels = queuedTasks.map(taskLabel);
    const queueText = `I queued ${queuedTasks.length} task${queuedTasks.length === 1 ? '' : 's'} in order: ${taskLabels.join('; ')}. I will post each result when it finishes.`;
    const sent = await message.reply(queueText);
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'task_queued_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'task_queued_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text: queueText,
    });
    return;
  }

  if (wantsOperationalStatus(message.content, { directAddressRequired: Boolean(message.guild) })) {
    const text = operationalStatusReply(message.channel);
    const sent = await message.reply(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'operational_status_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'operational_status_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text,
    });
    return;
  }

  if (wantsFayeSelfKnowledgeReply(message.content)) {
    const text = fayeSelfKnowledgeReply(message.content);
    const sent = await message.reply(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'self_knowledge_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'self_knowledge_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text,
    });
    return;
  }

  const deterministicReply = deterministicFileReply(message.content);
  if (deterministicReply) {
    const text = deterministicReply;
    const sent = await message.reply(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'deterministic_file_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'deterministic_file_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text,
    });
    return;
  }

  const explicitNote = getExplicitNoteRequest(message.content);
  if (explicitNote) {
    appendFayeNote(explicitNote, `Discord direct-address message ${message.id}`);
  }
  const explicitProfileNote = getExplicitUserProfileNote(message.content);
  if (explicitProfileNote) {
    const profileNote = explicitProfileNote.target === 'self'
      ? explicitProfileNote.note
      : `About ${explicitProfileNote.target}: ${explicitProfileNote.note}`;
    appendUserProfileNote(authorProfile, profileNote, `Discord direct-address message ${message.id}`);
  }
  const explicitPersonality = getExplicitPersonalityRequest(message.content);
  if (explicitPersonality) {
    appendFayePersonalityWithBackup(explicitPersonality, `Discord direct-address message ${message.id}`);
  }
  try {
    await updateUserProfilesFromMessages([message], `Direct-address Discord message ${message.id}`);
  } catch (err) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'user_profile_extract_failed',
      source: `Direct-address Discord message ${message.id}`,
      error: err.message,
    });
  }
  const relevantProfiles = loadUserProfilesForMessages([message]);
  const webSearchContext = await maybeBuildWebSearchContext(message.content, {
    channelId: message.channel.id,
    messageId: message.id,
    author: displayName(message),
    trigger,
  });

  const rawText = await askFaye(
    `You were directly addressed in Discord by ${trigger}.

Recent channel context before the message:
${recentTranscript || '(no earlier visible non-bot messages)'}

Message to answer:
${speakerIdentityBlock(message)}

Message content:
${message.content}

If the message asked you to remember, save, or note something, it has
already been appended to your notes file. If it asked you to update your
personality, it has already been appended to your personality file. If it asked
you to remember something about the speaker, it has already been appended to
that user's profile file. Acknowledge it briefly.`,
    'DIRECT_ADDRESS_REPLY',
    `${relevantProfiles}\n\n${channelContextBlock(message.channel)}`,
    { webSearchContext }
  );
  const text = plainReplyFromModel(rawText);
  if (checkKillSwitch('direct_address_before_send')) return;

  if (text) {
    const sent = await message.reply(text.slice(0, 1900));
    const state = readState();
    recordFayePost(state, getChannelState(state, message.channel.id), sent, {
      kind: 'direct_address_reply',
      respondedToBot: message.author.bot,
    });
    writeState(state);
    logJsonl(OUTBOX_LOG, {
      kind: 'direct_address_reply',
      channelId: message.channel.id,
      replyTo: message.id,
      text,
    });
    await maybeSelfEditPersonalityAfterReply({
      source: `Discord direct-address message ${message.id}`,
      channelId: message.channel.id,
      trigger,
      input: `${recentTranscript || ''}\n\n${speakerIdentityBlock(message)}\n${message.content}`.trim(),
      replyText: text,
    });

    try {
      const state = readState();
      const decision = await decideFollowUpAfterReply(message, text, recentTranscript, trigger);
      let pendingReply = null;
      if (decision.scheduleFollowUp && !shouldAllowDirectFollowUp(message, text, decision)) {
        logJsonl(ACTIVITY_LOG, {
          kind: 'follow_up_suppressed_no_explicit_continuation',
          messageId: message.id,
          channelId: message.channel.id,
          replyText: text,
          decision,
        });
      } else {
        pendingReply = schedulePendingReply(state, message.channel.id, message.id, decision, 'direct_address_reply');
      }

      if (!pendingReply) {
        const ackDecision = acknowledgementFollowUpDecision(message, text);
        pendingReply = schedulePendingReply(state, message.channel.id, message.id, ackDecision, 'acknowledgement_recovery');
        if (pendingReply) {
          logJsonl(ACTIVITY_LOG, {
            kind: 'acknowledgement_recovery_scheduled',
            messageId: message.id,
            channelId: message.channel.id,
            replyText: text,
            pendingReply,
          });
        }
      }
      if (pendingReply) writeState(state);
    } catch (err) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'follow_up_decision_failed',
        messageId: message.id,
        error: err.message,
      });
    }
  }
}

function getScheduledChannelIds() {
  const raw = process.env.DISCORD_CHANNEL_IDS || process.env.DISCORD_CHANNEL_ID || '';
  return [...new Set(raw.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean))];
}

async function getChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`${channelId} does not point to a text channel ${BOT_NAME} can read.`);
  }
  return channel;
}

async function maybePostInactivityQuestion(channel, state, channelState) {
  const latestFetched = await channel.messages.fetch({ limit: 50 });
  const newestMessage = [...latestFetched.values()]
    .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))[0];
  if (!newestMessage) return false;

  const quietForMs = Date.now() - newestMessage.createdTimestamp;
  if (quietForMs < INACTIVITY_PROMPT_AFTER_MS) return false;

  if (channelState.lastInactivityPromptBasisMessageId === newestMessage.id) return false;

  if (channelState.lastInactivityPromptAt) {
    const lastPromptAgeMs = Date.now() - new Date(channelState.lastInactivityPromptAt).getTime();
    if (lastPromptAgeMs < INACTIVITY_PROMPT_AFTER_MS) return false;
  }

  const delayMs = randomInt(IDLE_PROMPT_RECHECK_DELAY_MIN_MS, IDLE_PROMPT_RECHECK_DELAY_MAX_MS);
  consoleScheduled('idle prompt waiting before recheck', {
    channel: channel.id,
    delaySeconds: Math.round(delayMs / 1000),
  });
  await sleep(delayMs);

  const recheckFetched = await channel.messages.fetch({ limit: 1 });
  const recheckNewest = recheckFetched.first();
  if (!recheckNewest || recheckNewest.id !== newestMessage.id) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'idle_prompt_skipped_after_recheck',
      channelId: channel.id,
      basisMessageId: newestMessage.id,
      oldNewestMessageId: newestMessage.id,
      newNewestMessageId: recheckNewest?.id || null,
    });
    consoleScheduled('idle prompt skipped after recheck', { channel: channel.id });
    return false;
  }

  const recentFetched = await channel.messages.fetch({ limit: 20 });
  const recentTranscript = [...recentFetched.values()]
    .filter((m) => !isFromFaye(m))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
    .map(formatTranscriptMessage)
    .join('\n');

  const raw = await askFaye(
    `Nothing has been posted in this Discord channel for more than three hours.

Recent channel context:
${recentTranscript || `(no recent non-${BOT_NAME} messages)`}

Write one concise question ${BOT_NAME} wants to ask the room to restart discussion. It can be about writing, DnD, books, ${BOT_NAME}'s own thoughts, the room's projects, or anything they genuinely want people to answer. Do not mention the three-hour rule.`,
    'TASK_REPLY',
    channelContextBlock(channel)
  );
  const text = plainReplyFromModel(raw).trim();
  if (!text) return false;

  const latestAfterThinking = await latestNonFayeMessage(channel);
  if (latestAfterThinking && latestAfterThinking.id !== recheckNewest.id) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'idle_prompt_skipped_after_model_recheck',
      channelId: channel.id,
      basisMessageId: newestMessage.id,
      newestBeforeModel: recheckNewest.id,
      newestAfterModel: latestAfterThinking.id,
      newestAfterKind: inputKindForMessage(latestAfterThinking),
    });
    consoleScheduled('idle prompt skipped after model recheck', {
      channel: channel.id,
      newestFrom: displayName(latestAfterThinking),
    });
    return false;
  }

  const sent = await channel.send(text.slice(0, 1900));
  channelState.lastInactivityPromptBasisMessageId = newestMessage.id;
  channelState.lastInactivityPromptAt = new Date().toISOString();
  recordFayePost(state, channelState, sent, { kind: 'inactivity_discussion_prompt' });
  writeState(state);

  logJsonl(OUTBOX_LOG, {
    kind: 'inactivity_discussion_prompt',
    channelId: channel.id,
    messageId: sent.id,
    quietForMs,
    basisMessageId: newestMessage.id,
    text,
  });
  await maybeSelfEditPersonalityAfterReply({
    source: `Three-hour silence prompt ${sent.id}`,
    channelId: channel.id,
    trigger: 'three_hour_silence',
    input: recentTranscript,
    replyText: text,
  });
  consoleScheduled('posted inactivity question', {
    channel: channel.id,
    quietHours: Math.round((quietForMs / (60 * 60 * 1000)) * 10) / 10,
    text: shortContent(text),
  });
  return true;
}

async function maybePostLowChatReflection(channel, state, channelState) {
  const latestFetched = await channel.messages.fetch({ limit: 50 });
  const newestMessage = [...latestFetched.values()]
    .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))[0];
  if (!newestMessage) return false;

  if (isFromFaye(newestMessage)) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'low_chat_reflection_skipped_bot_was_last_speaker',
      channelId: channel.id,
      newestMessageId: newestMessage.id,
      newestCreatedAt: newestMessage.createdAt?.toISOString?.() || null,
    });
    return false;
  }

  const latestHuman = [...latestFetched.values()]
    .filter(isHumanMessage)
    .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))[0];
  if (!latestHuman) return false;

  const humanQuietForMs = Date.now() - latestHuman.createdTimestamp;
  if (humanQuietForMs < LOW_CHAT_AFTER_MS) return false;

  if (channelState.lastLowChatPostAt) {
    const lastLowChatAgeMs = Date.now() - new Date(channelState.lastLowChatPostAt).getTime();
    if (lastLowChatAgeMs < LOW_CHAT_POST_COOLDOWN_MS) return false;
  }

  const latestFayePostAt = channelState.lastFayePostAt
    ? new Date(channelState.lastFayePostAt).getTime()
    : 0;
  if (latestFayePostAt && Date.now() - latestFayePostAt < LOW_CHAT_POST_COOLDOWN_MS) {
    return false;
  }

  const recentTranscript = [...latestFetched.values()]
    .filter((m) => !isFromFaye(m))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
    .map(formatTranscriptMessage)
    .join('\n');

  const raw = await askFaye(
    `This Discord channel is in low-chat mode: no human has spoken for more than one hour.

Recent non-${BOT_NAME} context:
${recentTranscript || `(no recent non-${BOT_NAME} messages)`}

${BOT_NAME} can post a self-directed thought, question, provocation, observation, or small conversational hook. They do not need to be useful. They should sound like themselves, not a status bot. They may draw from their notes, personality, books, writing interests, DnD, the room, or their own current obsessions.

If there is nothing worth saying, return an empty response. Otherwise return one concise Discord message.`,
    'TASK_REPLY',
    channelContextBlock(channel)
  );
  const text = plainReplyFromModel(raw).trim();
  if (!text) {
    channelState.lastLowChatPostAt = new Date().toISOString();
    writeState(state);
    logJsonl(ACTIVITY_LOG, {
      kind: 'low_chat_reflection_skipped_empty',
      channelId: channel.id,
      humanQuietForMs,
    });
    return false;
  }

  const latestAfterThinking = await latestAnyMessage(channel);
  if (latestAfterThinking && latestAfterThinking.id !== newestMessage.id) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'low_chat_reflection_skipped_after_recheck',
      channelId: channel.id,
      newestBeforeModel: newestMessage.id,
      newestAfterModel: latestAfterThinking.id,
      newestAfterKind: inputKindForMessage(latestAfterThinking),
    });
    return false;
  }

  const sent = await channel.send(text.slice(0, 1900));
  channelState.lastLowChatPostAt = new Date().toISOString();
  recordFayePost(state, channelState, sent, { kind: 'low_chat_reflection' });
  writeState(state);
  logJsonl(OUTBOX_LOG, {
    kind: 'low_chat_reflection',
    channelId: channel.id,
    messageId: sent.id,
    humanQuietForMs,
    text,
  });
  await maybeSelfEditPersonalityAfterReply({
    source: `Low-chat reflection ${sent.id}`,
    channelId: channel.id,
    trigger: 'low_chat_reflection',
    input: recentTranscript,
    replyText: text,
  });
  consoleScheduled('posted low-chat reflection', {
    channel: channel.id,
    quietHours: Math.round((humanQuietForMs / (60 * 60 * 1000)) * 10) / 10,
    text: shortContent(text),
  });
  return true;
}

async function maybePostPendingReply(channel, state, channelState) {
  if (!Array.isArray(state.pendingReplies) || state.pendingReplies.length === 0) return false;

  const now = Date.now();
  const index = state.pendingReplies.findIndex((reply) => (
    reply.channelId === channel.id && new Date(reply.dueAt).getTime() <= now
  ));
  if (index === -1) return false;

  const pendingReply = state.pendingReplies[index];
  const newestBeforeThinking = await latestNonFayeMessage(channel);

  const recentFetched = await channel.messages.fetch({ limit: 20 });
  const recentTranscript = [...recentFetched.values()]
    .filter((m) => !isFromFaye(m))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
    .map(formatTranscriptMessage)
    .join('\n');

  const raw = await askFaye(
    `${BOT_NAME} scheduled this follow-up earlier.

Reason:
${pendingReply.reason || '(none)'}

Private follow-up instruction:
${pendingReply.prompt}

Recent channel context:
${recentTranscript || `(no recent non-${BOT_NAME} messages)`}

Write the message ${BOT_NAME} should post now. If the context has made the follow-up obsolete, write a brief natural acknowledgement instead of explaining scheduling mechanics.`,
    'TASK_REPLY',
    channelContextBlock(channel)
  );
  const text = plainReplyFromModel(raw).trim();
  if (!text) {
    state.pendingReplies = state.pendingReplies.filter((reply) => reply.id !== pendingReply.id);
    writeState(state);
    logJsonl(ACTIVITY_LOG, {
      kind: 'pending_reply_skipped_empty',
      pendingReply,
    });
    return true;
  }

  const humanPreempt = await humanSpokeSince(channel, newestBeforeThinking?.id || null);
  if (humanPreempt) {
    delayPendingReply(pendingReply);
    state.pendingReplies = state.pendingReplies
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    writeState(state);
    logJsonl(ACTIVITY_LOG, {
      kind: 'pending_reply_delayed_for_human_priority',
      channelId: channel.id,
      pendingReply,
      humanMessageId: humanPreempt.id,
      humanSpeaker: displayName(humanPreempt),
    });
    consoleScheduled('pending reply delayed for human priority', {
      channel: channel.id,
      speaker: displayName(humanPreempt),
      dueAt: pendingReply.dueAt,
    });
    return true;
  }

  const sent = await channel.send(text.slice(0, 1900));
  state.pendingReplies = state.pendingReplies.filter((reply) => reply.id !== pendingReply.id);
  recordFayePost(state, channelState, sent, { kind: 'pending_follow_up_reply' });
  writeState(state);

  logJsonl(OUTBOX_LOG, {
    kind: 'pending_follow_up_reply',
    channelId: channel.id,
    messageId: sent.id,
    pendingReply,
    text,
  });
  consoleScheduled('posted pending follow-up', {
    channel: channel.id,
    reason: shortContent(pendingReply.reason),
    text: shortContent(text),
  });
  return true;
}

async function scheduledCheck(channel) {
  if (checkKillSwitch('scheduled_check_start')) return;
  const state = readState();
  const channelState = getChannelState(state, channel.id);
  logJsonl(ACTIVITY_LOG, {
    kind: 'scheduled_check_started',
    channelId: channel.id,
    lastSeenMessageId: channelState.lastSeenMessageId,
  });

  const options = channelState.lastSeenMessageId
    ? { limit: 50, after: channelState.lastSeenMessageId }
    : { limit: 1 };

  const fetched = await channel.messages.fetch(options);
  const visibleMessages = [...fetched.values()]
    .filter((m) => !isFromFaye(m))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
  const messages = visibleMessages.filter((m) => !isMessageHandled(state, m.id));
  consoleScheduled('checked channel', {
    fetched: fetched.size,
    visible: visibleMessages.length,
    new: messages.length,
    channel: channel.id,
    lastSeen: channelState.lastSeenMessageId || 'none',
  });

  if (!channelState.initialized) {
    const latest = fetched.first();
    if (latest) {
      channelState.lastSeenMessageId = latest.id;
      state.lastSeenMessageId = latest.id;
    }
    channelState.initialized = true;
    state.initialized = true;
    writeState(state);
    logJsonl(ACTIVITY_LOG, {
      kind: 'scheduled_check_initialized',
      channelId: channel.id,
      lastSeenMessageId: channelState.lastSeenMessageId,
    });
    consoleScheduled('initialized cursor without posting', {
      channel: channel.id,
      lastSeen: channelState.lastSeenMessageId || 'none',
    });
    return;
  }

  if (await maybePostPendingReply(channel, state, channelState)) {
    return;
  }

  if (await maybePostInactivityQuestion(channel, state, channelState)) {
    return;
  }

  if (await maybePostLowChatReflection(channel, state, channelState)) {
    return;
  }

  if (await queuePulseReadingTaskIfDue(channel)) {
    consoleScheduled('queued pulse-reading task');
    return;
  }

  if (messages.length === 0) {
    let stateChanged = false;
    const latestVisible = visibleMessages.at(-1);
    if (latestVisible) {
      channelState.lastSeenMessageId = latestVisible.id;
      state.lastSeenMessageId = latestVisible.id;
      stateChanged = true;
    }
    if (state.postFollowupChecksRemaining > 0) {
      state.postFollowupChecksRemaining -= 1;
      stateChanged = true;
    }
    if (stateChanged) {
      writeState(state);
    }
    logJsonl(ACTIVITY_LOG, {
      kind: 'scheduled_check_no_new_messages',
      channelId: channel.id,
      lastSeenMessageId: channelState.lastSeenMessageId,
      postFollowupChecksRemaining: state.postFollowupChecksRemaining,
    });
    consoleScheduled('no new messages', {
      channel: channel.id,
      fetched: fetched.size,
      visible: visibleMessages.length,
      filteredHandled: visibleMessages.length - messages.length,
      lastSeen: channelState.lastSeenMessageId || 'none',
      followups: state.postFollowupChecksRemaining,
    });
    return;
  }

  logJsonl(ACTIVITY_LOG, {
    kind: 'scheduled_check_saw_messages',
    channelId: channel.id,
    count: messages.length,
    firstMessageId: messages[0].id,
    lastMessageId: messages[messages.length - 1].id,
  });
  consoleScheduled('saw new messages', {
    channel: channel.id,
    count: messages.length,
    firstFrom: displayName(messages[0]),
    last: shortContent(messages[messages.length - 1].content),
  });

  for (const msg of messages) {
    const authorProfile = profileUserFromMessage(msg);
    ensureUserProfile(authorProfile);
    appendChannelSessionEvent(channel, {
      kind: 'incoming_scheduled',
      speaker: `${displayName(msg)} (${msg.author.id})`,
      text: msg.content,
    });
    const explicitProfileNote = getExplicitUserProfileNote(msg.content);
    if (explicitProfileNote) {
      const profileNote = explicitProfileNote.target === 'self'
        ? explicitProfileNote.note
        : `About ${explicitProfileNote.target}: ${explicitProfileNote.note}`;
      appendUserProfileNote(authorProfile, profileNote, `Scheduled Discord message ${msg.id}`);
    }

    channelState.lastSeenMessageId = msg.id;
    state.lastSeenMessageId = msg.id;
    mergeHandledMessageIds(state, msg.id);
    logJsonl(INBOX_LOG, {
      kind: 'discord_message',
      messageId: msg.id,
      channelId: msg.channel.id,
      author: displayName(msg),
      content: msg.content,
    });
  }
  try {
    await updateUserProfilesFromMessages(messages, `Scheduled check through ${messages[messages.length - 1].id}`);
  } catch (err) {
    logJsonl(ACTIVITY_LOG, {
      kind: 'user_profile_extract_failed',
      source: `Scheduled check through ${messages[messages.length - 1].id}`,
      error: err.message,
    });
  }

  const transcript = messages
    .map(formatTranscriptMessage)
    .join('\n');
  const relevantProfiles = loadUserProfilesForMessages(messages);

  const directAddressMessage = [...messages].reverse()
    .find((message) => directlyAddressesFaye(message));

  if (directAddressMessage) {
    if (messageAlreadyBeingHandledOrReplied(directAddressMessage.id)) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_direct_address_skipped_already_replied',
        channelId: channel.id,
        messageId: directAddressMessage.id,
      });
      consoleScheduled('skipped scheduled direct address already replied', {
        channel: channel.id,
        message: shortContent(directAddressMessage.content),
      });
      writeState(state);
      return;
    }
    activeSourceMessageIds.add(directAddressMessage.id);
    const trigger = mentionsFayeUser(directAddressMessage)
      ? '@mention from scheduled check'
      : mentionsFayeTriggerRole(directAddressMessage)
        ? 'configured role mention from scheduled check'
        : 'name from scheduled check';
    try {
      await replyToDirectAddress(directAddressMessage, trigger);
    } catch (err) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_direct_address_reply_failed',
        channelId: channel.id,
        messageId: directAddressMessage.id,
        trigger,
        error: err.message,
      });
      await reportAcknowledgedFailure(directAddressMessage, err, trigger);
    }
    const latestState = readState();
    const latestChannelState = getChannelState(latestState, channel.id);
    latestState.postFollowupChecksRemaining = 2;
    latestState.lastSeenMessageId = state.lastSeenMessageId;
    latestChannelState.lastSeenMessageId = channelState.lastSeenMessageId;
    mergeHandledMessageIds(latestState, messages.map((message) => message.id));
    consoleScheduled('forced reply to direct address', {
      channel: channel.id,
      trigger,
      message: shortContent(directAddressMessage.content),
    });
    writeState(latestState);
    return;
  }

  const deterministicMessage = [...messages].reverse()
    .map((message) => ({ message, reply: deterministicFileReply(message.content) }))
    .find((entry) => entry.reply);

  const statusMessage = [...messages].reverse()
    .find((message) => wantsOperationalStatus(message.content));

  const pulseMessage = [...messages].reverse()
    .map((message) => ({ message, plan: requestedPulseReadingPlan(message.content) }))
    .find((entry) => entry.plan);

  const taskMessage = [...messages].reverse()
    .map((message) => ({ message, tasks: requestedTasks(message.content) }))
    .find((entry) => entry.tasks.length > 0);

  if (pulseMessage) {
    if (messageAlreadyBeingHandledOrReplied(pulseMessage.message.id)) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_pulse_skipped_already_handled',
        channelId: channel.id,
        messageId: pulseMessage.message.id,
      });
      writeState(state);
      return;
    }
    activeSourceMessageIds.add(pulseMessage.message.id);
    startPulseReadingPlan(pulseMessage.plan, channel.id, displayName(pulseMessage.message), pulseMessage.message.id);
    const text = `Pulse reading started for ${pulseMessage.plan.seriesTitle || pulseMessage.plan.relativePath}. On each scheduled pulse, I will read Chapter ${pulseMessage.plan.nextChapter} and then advance one chapter after I post.`;
    const sent = await channel.send(text.slice(0, 1900));
    const latestState = readState();
    const latestChannelState = getChannelState(latestState, channel.id);
    latestState.postFollowupChecksRemaining = 2;
    recordFayePost(latestState, latestChannelState, sent, {
      kind: 'scheduled_pulse_reading_started_reply',
      respondedToBot: pulseMessage.message.author.bot,
    });
    logJsonl(OUTBOX_LOG, {
      kind: 'scheduled_pulse_reading_started_reply',
      messageId: sent.id,
      channelId: sent.channel.id,
      text,
      replyToSeenMessageId: pulseMessage.message.id,
    });
    consoleScheduled('started pulse reading from scheduled check', {
      channel: channel.id,
      plan: pulseMessage.plan.seriesTitle || pulseMessage.plan.relativePath,
    });
    writeState(latestState);
    return;
  }

  if (taskMessage) {
    if (messageAlreadyBeingHandledOrReplied(taskMessage.message.id)) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_task_skipped_already_handled',
        channelId: channel.id,
        messageId: taskMessage.message.id,
      });
      writeState(state);
      return;
    }
    activeSourceMessageIds.add(taskMessage.message.id);
    const queuedTasks = taskMessage.tasks
      .map((task) => enqueueTask(
        task,
        channel.id,
        displayName(taskMessage.message),
        taskMessage.message.id
      ))
      .filter(Boolean);
    if (queuedTasks.length === 0) return;
    const taskLabels = queuedTasks.map(taskLabel);
    const queueText = `I queued ${queuedTasks.length} task${queuedTasks.length === 1 ? '' : 's'} in order: ${taskLabels.join('; ')}. I will post each result when it finishes.`;
    const sent = await channel.send(queueText.slice(0, 1900));
    state.postFollowupChecksRemaining = 2;
    recordFayePost(state, channelState, sent, {
      kind: 'scheduled_task_queued_reply',
      respondedToBot: taskMessage.message.author.bot,
    });
    logJsonl(OUTBOX_LOG, {
      kind: 'scheduled_task_queued_reply',
      messageId: sent.id,
      channelId: sent.channel.id,
      text: queueText,
      replyToSeenMessageId: taskMessage.message.id,
    });
    consoleScheduled('posted task queue reply', {
      tasks: queuedTasks.length,
      reason: shortContent(taskMessage.message.content),
    });
    writeState(state);
    return;
  }

  if (statusMessage) {
    if (messageAlreadyBeingHandledOrReplied(statusMessage.id)) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_status_skipped_already_handled',
        channelId: channel.id,
        messageId: statusMessage.id,
      });
      writeState(state);
      return;
    }
    activeSourceMessageIds.add(statusMessage.id);
    const text = operationalStatusReply(channel);
    const sent = await channel.send(text.slice(0, 1900));
    state.postFollowupChecksRemaining = 2;
    recordFayePost(state, channelState, sent, {
      kind: 'scheduled_operational_status_reply',
      respondedToBot: statusMessage.author.bot,
    });
    logJsonl(OUTBOX_LOG, {
      kind: 'scheduled_operational_status_reply',
      messageId: sent.id,
      channelId: sent.channel.id,
      text,
      replyToSeenMessageId: statusMessage.id,
    });
    consoleScheduled('posted operational status reply', {
      reason: shortContent(statusMessage.content),
    });
    writeState(state);
    return;
  }

  if (deterministicMessage) {
    if (messageAlreadyBeingHandledOrReplied(deterministicMessage.message.id)) {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_deterministic_skipped_already_handled',
        channelId: channel.id,
        messageId: deterministicMessage.message.id,
      });
      consoleScheduled('skipped deterministic reply already handled', {
        channel: channel.id,
        message: shortContent(deterministicMessage.message.content),
      });
      writeState(state);
      return;
    }
    activeSourceMessageIds.add(deterministicMessage.message.id);
    const sent = await channel.send(deterministicMessage.reply.slice(0, 1900));
    state.postFollowupChecksRemaining = 2;
    recordFayePost(state, channelState, sent, {
      kind: 'scheduled_deterministic_file_reply',
      respondedToBot: deterministicMessage.message.author.bot,
    });
    logJsonl(OUTBOX_LOG, {
      kind: 'scheduled_deterministic_file_reply',
      messageId: sent.id,
      channelId: sent.channel.id,
      text: deterministicMessage.reply,
      replyToSeenMessageId: deterministicMessage.message.id,
    });
    consoleScheduled('posted deterministic reply', {
      reason: shortContent(deterministicMessage.message.content),
    });
    writeState(state);
    return;
  }

  if (shouldHoldBotOnlyPost(messages, channelState)) {
    const remainingSeconds = Math.ceil(botCooldownRemainingMs(channelState) / 1000);
    logJsonl(HELD_LOG, {
      kind: 'bot_only_cooldown_skip',
      channelId: channel.id,
      remainingSeconds,
      messageIds: messages.map((message) => message.id),
    });
    consoleScheduled('held bot-only ambient post for cooldown', {
      channel: channel.id,
      remainingSeconds,
    });
    writeState(state);
    return;
  }

  consoleScheduled('asking model whether to post', { messages: messages.length });
  const newestBeforeModel = messages.at(-1)?.id || null;
  const raw = await askFaye(
    `New Discord messages since your last check:\n\n${transcript}\n\nDecide whether to post even though you were not directly addressed. If you can contribute something genuinely useful, interesting, funny, clarifying, creatively helpful, or socially connective, be biased toward posting. Set confidence from 0 to 1. Only set shouldPost true if confidence is at least ${AMBIENT_POST_CONFIDENCE_THRESHOLD}. Do not answer yourself or merely continue your own last point.`,
    'SCHEDULED_CHECK',
    `${relevantProfiles}\n\n${channelContextBlock(channel)}`
  );

  let decision;
  try {
    decision = parseDecision(raw);
  } catch {
    decision = { shouldPost: false, confidence: 0, message: '', reason: `Could not parse model JSON: ${raw}` };
    consoleScheduled('model decision parse failed', { raw: shortContent(raw) });
  }

  const confidence = decisionConfidence(decision);
  if (decision.shouldPost && confidence < AMBIENT_POST_CONFIDENCE_THRESHOLD) {
    logJsonl(HELD_LOG, {
      kind: 'scheduled_skip_low_confidence',
      channelId: channel.id,
      confidence,
      threshold: AMBIENT_POST_CONFIDENCE_THRESHOLD,
      reason: decision.reason || 'No reason provided.',
      raw,
    });
    decision.shouldPost = false;
    decision.message = '';
    decision.reason = `${decision.reason || 'No reason provided.'} Confidence ${confidence} below ambient threshold ${AMBIENT_POST_CONFIDENCE_THRESHOLD}.`;
  }

  if (decision.shouldPost && decision.message) {
    const humanPreempt = await humanSpokeSince(channel, newestBeforeModel);
    if (humanPreempt) {
      logJsonl(HELD_LOG, {
        kind: 'scheduled_post_delayed_for_human_priority',
        channelId: channel.id,
        humanMessageId: humanPreempt.id,
        humanSpeaker: displayName(humanPreempt),
        decision,
      });
      consoleScheduled('held scheduled post for human priority', {
        channel: channel.id,
        speaker: displayName(humanPreempt),
      });
      writeState(state);
      return;
    }
    const sent = await channel.send(decision.message.slice(0, 1900));
    state.postFollowupChecksRemaining = 2;
    recordFayePost(state, channelState, sent, {
      kind: 'scheduled_post',
      respondedToBot: messageBatchIsBotOnly(messages),
    });
    logJsonl(OUTBOX_LOG, {
      kind: 'scheduled_post',
      messageId: sent.id,
      channelId: sent.channel.id,
      text: decision.message,
      reason: decision.reason || '',
      confidence,
    });
    const workMessage = [...messages].reverse().find((message) => messageAsksForWork(message));
    if (workMessage) {
      const ackDecision = acknowledgementFollowUpDecision(workMessage, decision.message);
      const pendingReply = schedulePendingReply(state, channel.id, workMessage.id, ackDecision, 'scheduled_acknowledgement_recovery');
      if (pendingReply) {
        writeState(state);
        logJsonl(ACTIVITY_LOG, {
          kind: 'scheduled_acknowledgement_recovery_scheduled',
          channelId: channel.id,
          messageId: workMessage.id,
          replyText: decision.message,
          pendingReply,
        });
      }
    }
    await maybeSelfEditPersonalityAfterReply({
      source: `Scheduled Discord check ${sent.id}`,
      channelId: channel.id,
      trigger: 'scheduled_check',
      input: transcript,
      replyText: decision.message,
    });
    consoleScheduled('posted scheduled message', {
      reason: shortContent(decision.reason || 'No reason provided.'),
      confidence,
      text: shortContent(decision.message),
    });
  } else {
    logJsonl(HELD_LOG, {
      kind: 'scheduled_skip',
      reason: decision.reason || 'No reason provided.',
      confidence,
      raw,
    });
    if (state.postFollowupChecksRemaining > 0) {
      state.postFollowupChecksRemaining -= 1;
    }
    consoleScheduled('skipped post', {
      reason: shortContent(decision.reason || 'No reason provided.'),
      confidence,
      followups: state.postFollowupChecksRemaining,
    });
  }

  if (decision.memoryNote) {
    appendFayeNote(decision.memoryNote, `Scheduled check in ${channel.id} through ${channelState.lastSeenMessageId}`);
    consoleScheduled('saved memory note', { note: shortContent(decision.memoryNote) });
  }

  if (decision.scheduleFollowUp) {
    if (shouldAllowAmbientFollowUp(messages, decision)) {
      const sourceMessage = messages.at(-1);
      const pendingReply = schedulePendingReply(
        state,
        channel.id,
        sourceMessage?.id || null,
        decision,
        'ambient_scheduled_check'
      );
      if (!pendingReply) {
        logJsonl(ACTIVITY_LOG, {
          kind: 'scheduled_follow_up_not_scheduled',
          channelId: channel.id,
          reason: 'Pending reply duplicate/capacity guard suppressed it.',
          decision,
        });
      }
    } else {
      logJsonl(ACTIVITY_LOG, {
        kind: 'scheduled_follow_up_suppressed',
        channelId: channel.id,
        reason: 'Ambient follow-up lacked a concrete open loop.',
        decision,
      });
    }
  }

  writeState(state);
}

client.on('messageCreate', async (message) => {
  let directAddressContext = null;
  try {
    if (!client.user) return;
    if (isFromFaye(message)) return;
    const isDirectMessage = !message.guild;
    const isAddressed = isDirectMessage || directlyAddressesFaye(message);
    if (checkKillSwitch('message_create')) {
      if (isAddressed && wantsOperationalStatus(message.content, { directAddressRequired: Boolean(message.guild) })) {
        const text = operationalStatusReply(message.channel);
        await message.reply(text.slice(0, 1900));
        logJsonl(OUTBOX_LOG, {
          kind: 'kill_switch_status_reply',
          channelId: message.channel.id,
          replyTo: message.id,
          text,
        });
      }
      return;
    }

    if (isAddressed) {
      const trigger = isDirectMessage
        ? 'direct message'
        : mentionsFayeUser(message)
          ? '@mention'
          : mentionsFayeTriggerRole(message)
            ? 'configured role mention'
            : 'name';
      directAddressContext = { message, trigger };
      markMessageHandled(message.id);
      logJsonl(INBOX_LOG, {
        kind: 'direct_address_message',
        trigger,
        isDirectMessage,
        messageId: message.id,
        channelId: message.channel.id,
        author: displayName(message),
        content: message.content,
      });

      await replyToDirectAddress(message, trigger);
    }
  } catch (err) {
    console.error('Direct-address reply failed:', err);
    if (directAddressContext && !checkKillSwitch('direct_address_error')) {
      await reportAcknowledgedFailure(directAddressContext.message, err, directAddressContext.trigger);
    }
  }
});

client.once('ready', () => {
  console.log(`${BOT_NAME} is online as ${client.user.tag}`);
  const configuredChannelIds = getScheduledChannelIds();
  console.log(`Scheduled checks enabled for ${configuredChannelIds.length} channel${configuredChannelIds.length === 1 ? '' : 's'}: ${configuredChannelIds.join(', ') || '(none)'}`);

  setInterval(() => {
    checkKillSwitch('kill_switch_poll');
  }, 5_000);

  setInterval(() => {
    if (checkKillSwitch('scheduled_tick')) return;
    if (scheduledCheckRunning) {
      logJsonl(ACTIVITY_LOG, { kind: 'scheduled_check_skipped_still_running' });
      consoleScheduled('skipped tick because previous check is still running');
      return;
    }

    scheduledCheckRunning = true;
    (async () => {
      const channelIds = getScheduledChannelIds();
      if (channelIds.length === 0) {
        throw new Error('Set DISCORD_CHANNEL_ID or DISCORD_CHANNEL_IDS in .env.');
      }

      for (const channelId of channelIds) {
        try {
          const channel = await getChannel(channelId);
          await scheduledCheck(channel);
        } catch (err) {
          logJsonl(ACTIVITY_LOG, {
            kind: 'scheduled_channel_check_failed',
            channelId,
            error: err.message,
          });
          console.error(`Scheduled check failed for ${channelId}:`, err);
        }
      }
    })()
      .catch((err) => console.error('Scheduled check failed:', err))
      .finally(() => {
        scheduledCheckRunning = false;
      });
  }, SCHEDULED_INTERVAL_MS);
});

await client.login(process.env.DISCORD_TOKEN);
