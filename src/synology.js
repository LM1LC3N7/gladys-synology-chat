// -----------------------------------------------------------------------------
// The Synology Chat protocol, from the official help "Using Integration in
// Synology Chat" (kb.synology.com, read 2026-11-25). Pure: no I/O.
//
// Incoming webhook (Gladys -> chat): a POST to the webhook URL with a JSON
// string as the `payload` parameter of a form, `{"text": "..."}`. The NAS
// answers in JSON, `{"success": true}` or `{"success": false, "error": {"code"}}`
// (the Synology Web API envelope). The error codes are not documented: the
// code is shown as is, and none is taken for a refused token.
// -----------------------------------------------------------------------------

import { MAX_MESSAGE_LENGTH, RETRY_AFTER_MAX } from './constants.js';

// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The text of a message as it will be sent: line ends normalized, control
 * characters removed, trimmed, cut at MAX_MESSAGE_LENGTH characters (an
 * ellipsis marks the cut). '' when nothing is left.
 */
export function prepareText(value) {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const clean = raw.replace(/\r\n?/g, '\n').replace(CONTROL_BUT_LINES, '').trim();
  const chars = [...clean];
  if (chars.length <= MAX_MESSAGE_LENGTH) return clean;
  return `${chars
    .slice(0, MAX_MESSAGE_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** The form body of one message. */
export function messageBody(text) {
  return Buffer.from(`payload=${encodeURIComponent(JSON.stringify({ text }))}`, 'utf8');
}

/** Retry-After (seconds or an HTTP date) in ms, capped; undefined when unreadable. */
export function retryAfterMs(header, wallNow) {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  let ms;
  if (/^\d{1,9}$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    ms = at - wallNow;
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX);
}

/**
 * What the answer of the NAS means:
 *   { kind: 'ok' }
 *   { kind: 'pause', retryAfter? }   429 or 5xx: nothing more until the pause ends
 *   { kind: 'refused', code }        the NAS said no (`success: false`)
 *   { kind: 'redirect', status }     never followed (the URL holds the token)
 *   { kind: 'http', status }         another HTTP status
 *   { kind: 'unconfirmed' }          2xx, but not the expected JSON
 */
export function interpretAnswer({ status, headers = {}, body }, wallNow) {
  if (status === 429 || (status >= 500 && status <= 599)) {
    return { kind: 'pause', retryAfter: retryAfterMs(headers['retry-after'], wallNow) };
  }
  if (status >= 300 && status <= 399) return { kind: 'redirect', status };
  if (status < 200 || status > 299) return { kind: 'http', status };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''));
  } catch {
    return { kind: 'unconfirmed' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') {
    return { kind: 'unconfirmed' };
  }
  if (parsed.success === true) return { kind: 'ok' };
  const code = parsed.error?.code;
  return { kind: 'refused', code: Number.isInteger(code) ? code : null };
}
