// -----------------------------------------------------------------------------
// A request of Synology Chat relayed by Gladys Plus (outgoing webhook, slash
// command or bot), turned into the flat data of the `command_received` scene
// trigger. Pure: no I/O, no clock read (the caller passes the time).
//
// Synology Chat posts a form with these fields (official help, "Outgoing
// Webhooks", "Slash Commands", "Bots"): token, channel_id, channel_name,
// user_id, username, post_id, timestamp, text, trigger_word (a slash command
// and a bot send only some of them). A JSON body with the same keys is read
// too. The token is only read from the body, never from the query string.
// -----------------------------------------------------------------------------

import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_EVENT_NAME, MAX_EVENT_TEXT, MAX_INBOUND_BYTES } from './constants.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The fields of the body, or null when it cannot be read. */
export function parseBody({ body, contentType } = {}) {
  if (typeof body !== 'string' || !body.trim()) return null;
  if (Buffer.byteLength(body, 'utf8') > MAX_INBOUND_BYTES) return null;
  const type = String(contentType ?? '').toLowerCase();
  const text = body.trim();
  if (type.includes('json') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (!isPlain(parsed)) return null;
      // No prototype pollution: only own string keys, in a null-prototype object.
      const fields = Object.create(null);
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          fields[key] = value === null ? '' : String(value);
        }
      }
      return fields;
    } catch {
      return null;
    }
  }
  const fields = Object.create(null);
  for (const [key, value] of new URLSearchParams(text)) {
    // The first value of a repeated key, as Synology sends each once.
    if (!(key in fields)) fields[key] = value;
  }
  return fields;
}

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();

/** True when `given` is one of `tokens` (compared in constant time). */
export function tokenMatches(given, tokens) {
  if (typeof given !== 'string' || !given || !Array.isArray(tokens) || tokens.length === 0) {
    return false;
  }
  const g = digest(given);
  let found = false;
  for (const token of tokens) {
    // Every token compared, so the time does not tell which one matched.
    if (timingSafeEqual(g, digest(token))) found = true;
  }
  return found;
}

/** A one-line text: controls removed, spaces collapsed, cut at `max` characters. */
export function oneLine(value, max) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  // Cut in UTF-16 units (what Gladys counts), never inside a surrogate pair.
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A positive integer id, or null. */
function idOf(value) {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** The time of the message in epoch ms (Synology sends ms; seconds accepted), or null. */
export function timestampOf(value) {
  if (typeof value !== 'string' || !/^\d{9,16}$/.test(value)) return null;
  const n = Number(value);
  return n < 1e11 ? n * 1000 : n;
}

/**
 * The scene event of a request, or why it is ignored:
 *   { ok: true, data, postId, text }  -> publish `data`
 *   { ok: false, reason }             -> ignore the request
 * reason: 'unreadable' | 'no_token_configured' | 'bad_token' | 'empty' | 'stale'
 */
export function inboundEvent(request, { tokens, wallNow, maxSkew }) {
  const fields = parseBody(request);
  if (!fields) return { ok: false, reason: 'unreadable' };
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { ok: false, reason: 'no_token_configured' };
  }
  if (!tokenMatches(fields.token, tokens)) return { ok: false, reason: 'bad_token' };
  const text = oneLine(fields.text, MAX_EVENT_TEXT);
  if (!text) return { ok: false, reason: 'empty' };
  const at = timestampOf(fields.timestamp);
  if (at !== null && Math.abs(wallNow - at) > maxSkew) return { ok: false, reason: 'stale' };
  const triggerWord = oneLine(fields.trigger_word, MAX_EVENT_NAME);
  let command = text;
  if (triggerWord && text.toLowerCase().startsWith(triggerWord.toLowerCase())) {
    command = text.slice(triggerWord.length).trim();
  }
  const channelId = idOf(fields.channel_id);
  return {
    ok: true,
    postId:
      typeof fields.post_id === 'string' && /^\d{1,20}$/.test(fields.post_id)
        ? fields.post_id
        : null,
    text,
    data: {
      text,
      command: command || null,
      trigger_word: triggerWord,
      username: oneLine(fields.username, MAX_EVENT_NAME),
      user_id: idOf(fields.user_id),
      channel_name: oneLine(fields.channel_name, MAX_EVENT_NAME),
      channel_id: channelId,
      source: channelId !== null ? 'channel' : 'direct',
    },
  };
}
