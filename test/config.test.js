// -----------------------------------------------------------------------------
// The pure parts: the configuration (URL, fingerprint, tokens), the protocol
// (message text, form body, answers, Retry-After) and the inbound parsing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  parseFingerprint,
  parseIncomingUrl,
  parseTokens,
  sendBlocker,
} from '../src/config.js';
import { inboundEvent, oneLine, parseBody, timestampOf, tokenMatches } from '../src/inbound.js';
import { interpretAnswer, messageBody, prepareText, retryAfterMs } from '../src/synology.js';
import { INCOMING } from './helpers/app.js';

const Q = '/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22abc%22';

test('the incoming URL: parsed, or refused with a code that never holds it', () => {
  assert.deepEqual(parseIncomingUrl(INCOMING), {
    scheme: 'https',
    host: 'nas.local',
    port: 5001,
    path: INCOMING.slice('https://nas.local:5001'.length),
  });
  assert.deepEqual(parseIncomingUrl(`https://[fd00::2]${Q}`), {
    scheme: 'https',
    host: 'fd00::2',
    port: 443,
    path: Q,
  });
  assert.equal(parseIncomingUrl(`http://192.168.1.5:5000${Q}`).port, 5000);
  const cases = {
    missing: ['', undefined, '   '],
    invalid: [
      'not a url',
      `https://nas.local/x\ny${Q}`,
      `https://na s${Q}`,
      `https://${'a'.repeat(2100)}`,
    ],
    scheme: [`ftp://nas${Q}`, `javascript:alert(1)`],
    credentials: [`https://u:p@nas${Q}`],
    address: [
      `https://0.0.0.0${Q}`,
      `https://224.0.0.1${Q}`,
      `https://255.255.255.255${Q}`,
      `https://[ff02::1]${Q}`,
    ],
    not_incoming: [
      'https://nas/webapi/entry.cgi?api=SYNO.Chat.External&method=channel_list&token=x',
      'https://nas/other.cgi?api=SYNO.Chat.External&method=incoming&token=x',
      'https://nas/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&token=%22%22',
      'https://nas/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming',
    ],
  };
  for (const [code, values] of Object.entries(cases)) {
    for (const value of values) {
      const r = parseIncomingUrl(value);
      assert.deepEqual(r, { error: code }, String(value));
    }
  }
});

test('the fingerprint: any separator and case, or null', () => {
  const hex = 'ab'.repeat(32);
  const canon = Array(32).fill('AB').join(':');
  assert.equal(parseFingerprint(hex), canon);
  assert.equal(parseFingerprint(`SHA256: ${canon.toLowerCase()}`), canon);
  assert.equal(parseFingerprint(canon.replace(/:/g, ' ')), canon);
  assert.equal(parseFingerprint(''), '');
  assert.equal(parseFingerprint('ab'.repeat(20)), null);
  assert.equal(parseFingerprint('zz'.repeat(32)), null);
});

test('the tokens: several, deduplicated, bounded', () => {
  assert.deepEqual(parseTokens(''), []);
  assert.deepEqual(parseTokens(' tokenAAAA1, tokenBBBB2;tokenAAAA1 '), [
    'tokenAAAA1',
    'tokenBBBB2',
  ]);
  assert.equal(parseTokens('short'), null);
  assert.equal(parseTokens('a1234567 b1234567 c1234567 d1234567 e1234567 f1234567'), null);
  assert.equal(parseTokens('tokén12345'), null);
});

test('what blocks a send', () => {
  assert.equal(sendBlocker(normalizeConfig({})), 'url_missing');
  assert.equal(sendBlocker(normalizeConfig({ incoming_url: `http://nas${Q}` })), 'http_refused');
  assert.equal(
    sendBlocker(normalizeConfig({ incoming_url: `http://nas${Q}`, allow_http: true })),
    '',
  );
  assert.equal(
    sendBlocker(normalizeConfig({ incoming_url: INCOMING, certificate_fingerprint: 'x' })),
    'fingerprint_invalid',
  );
  assert.equal(sendBlocker(normalizeConfig({ incoming_url: INCOMING })), '');
  assert.equal(normalizeConfig(null).allowHttp, false);
  assert.equal(normalizeConfig({ allow_http: 'yes' }).allowHttp, false);
});

test('message text and body', () => {
  assert.equal(prepareText(' a\r\nb\u0000\u0007\tc '), 'a\nb\tc');
  assert.equal(prepareText(42), '42');
  assert.equal(prepareText(null), '');
  const long = prepareText('😀'.repeat(3000));
  assert.equal([...long].length, 2000);
  const body = messageBody('a&b=c "d"');
  assert.deepEqual(JSON.parse(new URLSearchParams(body.toString()).get('payload')), {
    text: 'a&b=c "d"',
  });
});

test('answers of the NAS', () => {
  const at = Date.UTC(2026, 0, 1);
  const json = (s, status = 200, headers = {}) =>
    interpretAnswer({ status, headers, body: Buffer.from(s) }, at);
  assert.deepEqual(json('{"success":true}'), { kind: 'ok' });
  assert.deepEqual(json('{"success":false,"error":{"code":120}}'), { kind: 'refused', code: 120 });
  assert.deepEqual(json('{"success":false}'), { kind: 'refused', code: null });
  assert.deepEqual(json('{"success":"yes"}'), { kind: 'unconfirmed' });
  assert.deepEqual(json('[]'), { kind: 'unconfirmed' });
  assert.deepEqual(json(''), { kind: 'unconfirmed' });
  assert.deepEqual(json('', 503), { kind: 'pause', retryAfter: undefined });
  assert.deepEqual(json('', 429, { 'retry-after': '120' }), { kind: 'pause', retryAfter: 120_000 });
  assert.deepEqual(json('', 301), { kind: 'redirect', status: 301 });
  assert.deepEqual(json('', 403), { kind: 'http', status: 403 });
  assert.equal(retryAfterMs(new Date(at + 90_000).toUTCString(), at), 90_000);
  assert.equal(retryAfterMs('0', at), undefined);
  assert.equal(retryAfterMs('soon', at), undefined);
  assert.equal(retryAfterMs('999999999', at), 6 * 3600_000);
});

test('inbound parsing: form, JSON, no prototype pollution, bounded', () => {
  assert.equal(parseBody({ body: '' }), null);
  assert.equal(parseBody({ body: 'x'.repeat(17 * 1024) }), null);
  const f = parseBody({ body: 'token=a&text=b&text=c' });
  assert.equal(f.text, 'b');
  const j = parseBody({
    body: '{"__proto__":{"x":1},"constructor":"c","token":"t","n":5,"o":{"a":1}}',
    contentType: 'application/json',
  });
  assert.equal(Object.getPrototypeOf(j), null);
  assert.equal(j.n, '5');
  assert.equal(j.o, undefined);
  assert.equal({}.x, undefined);
  assert.equal(oneLine(' a\n\tb ', 10), 'a b');
  assert.equal(oneLine('é'.repeat(20), 5), 'ééééé');
  assert.equal(timestampOf('1767225600000'), 1767225600000);
  assert.equal(timestampOf('1767225600'), 1767225600000);
  assert.equal(timestampOf('17.5'), null);
});

test('tokens compared exactly', () => {
  assert.equal(tokenMatches('abcdefgh', ['abcdefgh']), true);
  assert.equal(tokenMatches('abcdefgH', ['abcdefgh']), false);
  assert.equal(tokenMatches('', ['abcdefgh']), false);
  assert.equal(tokenMatches(undefined, ['abcdefgh']), false);
  assert.equal(tokenMatches('abcdefgh', []), false);
});

test('inbound event: command without its trigger word, ids, freshness both ways', () => {
  const now = Date.UTC(2026, 0, 1);
  const req = (fields) => ({ body: new URLSearchParams(fields).toString() });
  const base = { token: 'tokentoken', text: 'Gladys Salon ON', trigger_word: 'gladys' };
  const r = inboundEvent(req(base), { tokens: ['tokentoken'], wallNow: now, maxSkew: 600_000 });
  assert.equal(r.data.command, 'Salon ON');
  assert.equal(r.data.user_id, null);
  assert.equal(r.data.source, 'direct');
  for (const ts of [now - 700_000, now + 700_000]) {
    assert.deepEqual(
      inboundEvent(req({ ...base, timestamp: String(ts) }), {
        tokens: ['tokentoken'],
        wallNow: now,
        maxSkew: 600_000,
      }),
      { ok: false, reason: 'stale' },
    );
  }
  assert.equal(
    inboundEvent(req({ ...base, text: 'gladys' }), {
      tokens: ['tokentoken'],
      wallNow: now,
      maxSkew: 1,
    }).data.command,
    null,
  );
  assert.equal(
    inboundEvent(req({ ...base, text: '  ' }), { tokens: ['tokentoken'], wallNow: now, maxSkew: 1 })
      .reason,
    'empty',
  );
  assert.equal(
    inboundEvent(req({ ...base, user_id: '1e3', channel_id: '-1' }), {
      tokens: ['tokentoken'],
      wallNow: now,
      maxSkew: 1,
    }).data.user_id,
    null,
  );
});
