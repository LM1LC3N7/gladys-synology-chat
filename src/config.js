// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// rest of the code never deals with `undefined` or a raw string from a form.
//
// The incoming webhook URL is a secret (its `token` parameter lets anyone post
// in the channel): it is parsed here, never logged nor shown, and an error
// about it never repeats it.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { MAX_TOKENS, MAX_URL_LENGTH } from './constants.js';

/** The defaults of the manifest (`test/manifest.test.js` ties both). */
export const DEFAULT_CONFIG = { allow_http: false };

const text = (value) => (typeof value === 'string' ? value.trim() : '');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/** An address nothing should be sent to: unspecified, broadcast, multicast. */
export function forbiddenAddress(host) {
  const version = isIP(host);
  if (version === 4) {
    const [a] = host.split('.').map(Number);
    return host === '0.0.0.0' || host === '255.255.255.255' || (a >= 224 && a <= 239);
  }
  if (version === 6) {
    const h = host.toLowerCase();
    return h === '::' || h.startsWith('ff');
  }
  return false;
}

/**
 * The incoming webhook URL copied from Synology Chat ("Integration" >
 * "Incoming Webhooks"), e.g.
 * https://nas:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22...%22
 * -> { scheme, host, port, path } (path with its query, token included), or
 * { error } with a code that never holds the URL: 'missing', 'invalid',
 * 'scheme', 'credentials', 'address', 'not_incoming'.
 */
export function parseIncomingUrl(value) {
  const raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > MAX_URL_LENGTH || CONTROL.test(raw) || /\s/.test(raw)) {
    return { error: 'invalid' };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'scheme' };
  if (url.username || url.password) return { error: 'credentials' };
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host || (!isIP(host) && !HOSTNAME.test(host))) return { error: 'invalid' };
  if (forbiddenAddress(host)) return { error: 'address' };
  const params = url.searchParams;
  const token = params.get('token') ?? '';
  if (
    !url.pathname.endsWith('/entry.cgi') ||
    params.get('api') !== 'SYNO.Chat.External' ||
    params.get('method') !== 'incoming' ||
    !token.replace(/"/g, '').trim()
  ) {
    return { error: 'not_incoming' };
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return {
    scheme,
    host: host.toLowerCase().replace(/\.$/, ''),
    port: url.port ? Number(url.port) : scheme === 'https' ? 443 : 80,
    path: `${url.pathname}${url.search}`,
  };
}

/**
 * A SHA-256 fingerprint as typed (colons, spaces or nothing between the
 * bytes, any case) -> `AA:BB:...` (Node's `fingerprint256`), '' when empty,
 * null when it is not 32 bytes of hex. Taken from gladys-egauge (approved).
 */
export function parseFingerprint(value) {
  const raw = text(value).replace(/^sha-?256\s*[:=]?\s*/i, '');
  if (!raw) return '';
  const hex = raw.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/**
 * The tokens of the outgoing webhooks (outgoing webhook, slash command, bot:
 * each has its own), separated by spaces, commas or semicolons. -> string[]
 * (empty: none), or null when one is not a plain printable token or there
 * are too many.
 */
export function parseTokens(value) {
  const raw = text(value);
  if (!raw) return [];
  const tokens = [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
  if (tokens.length > MAX_TOKENS) return null;
  if (!tokens.every((t) => /^[\x21-\x7e]{8,256}$/.test(t))) return null;
  return tokens;
}

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    incoming: parseIncomingUrl(source.incoming_url),
    /** '' none, null invalid, else `AA:BB:...`. */
    fingerprint: parseFingerprint(source.certificate_fingerprint),
    allowHttp: source.allow_http === true || source.allow_http === 'true',
    /** [] none, null invalid. */
    tokens: parseTokens(source.outgoing_token),
  };
}

/** What stops a message from being sent, '' when nothing does. */
export function sendBlocker(config) {
  if (config.incoming.error) return `url_${config.incoming.error}`;
  if (config.incoming.scheme === 'http' && !config.allowHttp) return 'http_refused';
  if (config.fingerprint === null) return 'fingerprint_invalid';
  return '';
}
