// -----------------------------------------------------------------------------
// The integration on the SDK's fake Gladys, a virtual clock and a fake
// transport: sending (certificate, queue, gap, deadline, pause, answers),
// receiving (token, duplicates, echoes, rate, freshness, never a reply), the
// configuration retried, the stop, and no secret anywhere.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FP,
  INCOMING,
  OTHER_FP,
  OUT_TOKEN,
  URL_TOKEN,
  chatForm,
  fakeTransport,
  drive,
  makeApp,
  sentNoAnswer,
  within,
} from './helpers/app.js';
import { createMemoryStore } from '../src/store.js';
import { settle, testClock } from './kit/index.mjs';
import { readFileSync } from 'node:fs';
import {
  PAUSE_MIN,
  QUEUE_MAX,
  REQUEST_TIMEOUT,
  SCENE_DEADLINE,
  SEND_GAP,
  TEST_DEADLINE,
} from '../src/constants.js';

const statusText = (fake) => JSON.stringify(fake.connectionStatus);

async function connected(options) {
  const ctx = makeApp(options);
  await within(ctx.gladys.connect());
  return ctx;
}

/** A scene action started now, its ack awaited later. */
const scene = (fake, text) => fake.sceneAction('send_message', { text });

test('ready: status says so, chat commands active, no secret shown', async () => {
  const { fake, lines } = await connected();
  assert.equal(fake.connectionStatus.connected, true);
  assert.match(fake.connectionStatus.message.fr, /Commandes du chat : actives/);
  const all = JSON.stringify([fake.connectionStatuses, lines]);
  assert.ok(!all.includes(URL_TOKEN) && !all.includes(OUT_TOKEN) && !all.includes('nas.local'));
});

test('without Gladys Plus the status says only sending works', async () => {
  const { fake } = await connected({ webhooks: { available: false, webhooks: [] } });
  assert.equal(fake.connectionStatus.connected, true);
  assert.match(fake.connectionStatus.message.fr, /demandent Gladys Plus \(seul l'envoi marche\)/);
  await within(
    fake.webhookUpdated({
      available: true,
      webhooks: [{ key: 'chat', mode: 'fire_and_forget', url: 'u' }],
    }),
  );
  assert.match(fake.connectionStatus.message.fr, /actives/);
});

test('a scene action posts the text as the payload of a form', async () => {
  const { fake, transport } = await connected();
  const ack = await within(scene(fake, 'Porte ouverte\r\nà 20 h'));
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(transport.sent, ['Porte ouverte\nà 20 h']);
  const { target, options } = transport.calls[0];
  assert.equal(target.scheme, 'https');
  assert.equal(target.host, 'nas.local');
  assert.equal(target.port, 5001);
  assert.match(target.path, /^\/webapi\/entry\.cgi\?api=SYNO\.Chat\.External&method=incoming/);
  assert.match(options.body.toString(), /^payload=%7B%22text%22%3A/);
});

test('an empty message is refused, nothing sent', async () => {
  const { fake, transport } = await connected();
  const ack = await within(scene(fake, ' \u0001 '));
  assert.equal(ack.success, false);
  assert.match(ack.error, /Nothing sent: the message is empty/);
  assert.equal(transport.calls.length, 0);
});

test('a long message is cut at 2000 characters', async () => {
  const { fake, transport } = await connected();
  await within(scene(fake, 'é'.repeat(5000)));
  assert.equal([...transport.sent[0]].length, 2000);
  assert.ok(transport.sent[0].endsWith('…'));
});

test('self-signed certificate without fingerprint: nothing written, fingerprint shown', async () => {
  const { fake, transport, clock } = await connected({
    config: { incoming_url: INCOMING, outgoing_token: OUT_TOKEN },
  });
  const ack = await within(scene(fake, 'hello'));
  assert.equal(ack.success, false);
  assert.match(ack.error, /Nothing sent: the certificate of the NAS is not confirmed/);
  assert.deepEqual(transport.sent, []);
  assert.equal(fake.connectionStatus.connected, false);
  assert.ok(fake.connectionStatus.message.en.includes(FP));
  // The test button shows it too.
  const button = await drive(clock, fake.action('test_message', {}));
  assert.ok(button.data.message.fr.includes(FP), JSON.stringify(button));
  assert.deepEqual(transport.sent, []);
});

test('a certificate signed by an authority needs no fingerprint', async () => {
  const transport = fakeTransport({ authorized: true });
  const { fake } = await connected({
    config: { incoming_url: INCOMING, outgoing_token: OUT_TOKEN },
    transport,
  });
  assert.deepEqual(await within(scene(fake, 'hello')), { success: true });
  assert.deepEqual(transport.sent, ['hello']);
});

test('a typed fingerprint is the authority: another certificate is refused, even signed', async () => {
  const transport = fakeTransport({ fingerprint: OTHER_FP, authorized: true });
  const { fake, clock } = await connected({ transport });
  const ack = await within(scene(fake, 'hello'));
  assert.match(ack.error, /another certificate than the fingerprint typed/);
  assert.deepEqual(transport.sent, []);
  assert.ok(fake.connectionStatus.message.fr.includes(OTHER_FP));
  // Fixed by typing the new one: sent, status ready again.
  await within(
    fake.configUpdated({ incoming_url: INCOMING, certificate_fingerprint: OTHER_FP.toLowerCase() }),
  );
  assert.equal(fake.connectionStatus.connected, true);
  assert.deepEqual(await drive(clock, scene(fake, 'hello')), { success: true });
});

test('an invalid fingerprint, a bad URL, http without the option: nothing sent', async () => {
  for (const [config, pattern] of [
    [{ incoming_url: INCOMING, certificate_fingerprint: 'abc' }, /SHA-256/],
    [
      { incoming_url: 'https://nas.local/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming' },
      /not the URL of an incoming webhook/,
    ],
    [{ incoming_url: INCOMING.replace('https:', 'http:') }, /in clear/],
    [{}, /Paste the URL/],
  ]) {
    const { fake, transport } = await connected({ config });
    assert.equal(fake.connectionStatus.connected, false);
    assert.match(fake.connectionStatus.message.en, pattern);
    const ack = await within(scene(fake, 'x'));
    assert.match(ack.error, /^Nothing sent/);
    assert.equal(transport.calls.length, 0);
  }
});

test('http allowed by the option: sent without a certificate check', async () => {
  const transport = fakeTransport();
  transport.fingerprint = null;
  const { fake } = await connected({
    config: { incoming_url: INCOMING.replace('https:', 'http:'), allow_http: true },
    transport,
  });
  assert.deepEqual(await within(scene(fake, 'x')), { success: true });
  assert.equal(transport.calls[0].target.scheme, 'http');
  assert.equal(transport.calls[0].target.port, 5001);
});

test('one request at a time, at least a second apart', async () => {
  const { fake, transport, clock } = await connected();
  const acks = [scene(fake, 'a'), scene(fake, 'b'), scene(fake, 'c')];
  await settle();
  assert.deepEqual(transport.sent, ['a']);
  await clock.advance(SEND_GAP - 10);
  await settle();
  assert.deepEqual(transport.sent, ['a']);
  await clock.advance(20);
  await settle();
  assert.deepEqual(transport.sent, ['a', 'b']);
  await clock.advance(SEND_GAP);
  await settle();
  assert.deepEqual(transport.sent, ['a', 'b', 'c']);
  for (const ack of await within(Promise.all(acks))) assert.equal(ack.success, true);
});

test('a slow request keeps the others waiting; never two in flight', async () => {
  const transport = fakeTransport();
  let release;
  transport.answers.push(() => new Promise((resolve) => (release = resolve)));
  const { fake, clock } = await connected({ transport });
  const first = scene(fake, 'a');
  const second = scene(fake, 'b');
  await settle();
  await clock.advance(5000);
  await settle();
  assert.deepEqual(transport.sent, ['a']);
  release({ status: 200, headers: {}, body: Buffer.from('{"success":true}') });
  await settle();
  assert.deepEqual(transport.sent, ['a', 'b']);
  assert.equal((await within(first)).success, true);
  assert.equal((await within(second)).success, true);
});

test('queue full: refused at once, nothing sent; a message past its deadline is never sent', async () => {
  const transport = fakeTransport();
  transport.answers.push(() => new Promise(() => {}));
  const { fake, clock } = await connected({ transport });
  const acks = [scene(fake, 'stuck')];
  await settle();
  for (let i = 0; i < QUEUE_MAX; i += 1) acks.push(scene(fake, `m${i}`));
  const over = await within(scene(fake, 'over'));
  assert.match(over.error, /too many messages are waiting/);
  await clock.advance(SCENE_DEADLINE + 1);
  await settle();
  const results = await within(Promise.all(acks.slice(1)));
  for (const r of results) assert.match(r.error, /waited too long/);
  assert.deepEqual(transport.sent, ['stuck']);
});

test('sent without an answer: "sent, without confirmation", never sent again', async () => {
  const transport = fakeTransport();
  transport.answers.push(sentNoAnswer());
  const { fake, clock } = await connected({ transport });
  const ack = await within(scene(fake, 'once'));
  assert.match(ack.error, /^Message sent, without confirmation/);
  await clock.advance(60_000);
  await settle();
  assert.deepEqual(transport.sent, ['once']);
  assert.equal(fake.connectionStatus.connected, false);
});

test('answers: refused with its code, unreadable, redirect never followed, other HTTP', async () => {
  const transport = fakeTransport();
  transport.answers.push(
    { status: 200, headers: {}, body: Buffer.from('{"success":false,"error":{"code":117}}') },
    { status: 200, headers: {}, body: Buffer.from('<html>') },
    { status: 302, headers: { location: 'https://evil/' }, body: Buffer.alloc(0) },
    { status: 404, headers: {}, body: Buffer.alloc(0) },
  );
  const { fake, clock } = await connected({ transport });
  const errors = [];
  for (const text of ['a', 'b', 'c', 'd']) {
    const pending = scene(fake, text);
    await clock.advance(SEND_GAP);
    errors.push((await within(pending)).error);
  }
  assert.match(errors[0], /refused the message \(code 117\)/);
  assert.match(
    errors[1],
    /^Message sent, without confirmation: the answer of the NAS cannot be read/,
  );
  assert.match(errors[2], /redirection \(HTTP 302\), never followed/);
  assert.match(errors[3], /HTTP 404: message not posted/);
  assert.equal(transport.calls.length, 4);
  // A success clears the failure.
  const last = scene(fake, 'e');
  await clock.advance(SEND_GAP);
  assert.equal((await within(last)).success, true);
  assert.equal(fake.connectionStatus.connected, true);
});

test('a 503 pauses every send, kept in /data across a restart, doubled, cleared by a success', async () => {
  const store = createMemoryStore();
  const clock = testClock();
  const transport = fakeTransport();
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const { fake } = await connected({ store, clock, transport });
  const first = await within(scene(fake, 'a'));
  assert.match(first.error, /HTTP 503: publication not confirmed, sending paused for 1 min/);
  await clock.advance(SEND_GAP);
  const second = await within(scene(fake, 'b'));
  assert.match(second.error, /^Nothing sent: the NAS asked to slow down/);
  assert.equal(transport.calls.length, 1);
  assert.equal(store.data.pauseLevel, 1);
  assert.ok(store.data.pauseUntil > clock.now());
  assert.match(fake.connectionStatus.message.en, /slow down/);

  // A restart 30 s later: still paused, without any request.
  await clock.advance(30_000);
  const again = await connected({ store, clock, transport });
  const third = await within(scene(again.fake, 'c'));
  assert.match(third.error, /^Nothing sent: the NAS asked to slow down/);
  assert.equal(transport.calls.length, 1);

  // Ended: a new 503 doubles the pause (2 min).
  await clock.advance(31_000);
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const fourth = await within(scene(again.fake, 'd'));
  assert.match(fourth.error, /paused for 2 min/);
  await clock.advance(2 * 60_000 + 1);
  assert.equal((await within(scene(again.fake, 'e'))).success, true);
  assert.equal(store.data.pauseLevel, 0);
  assert.equal(again.fake.connectionStatus.connected, true);
});

test('Retry-After is honoured above the doubled pause, capped at 6 h', async () => {
  const transport = fakeTransport();
  transport.answers.push({
    status: 429,
    headers: { 'retry-after': '99999999' },
    body: Buffer.alloc(0),
  });
  const { fake, clock } = await connected({ transport });
  const ack = await within(scene(fake, 'a'));
  assert.match(ack.error, /HTTP 429.*paused for 360 min/);
  await clock.advance(6 * 3600_000 - 1000);
  assert.match((await within(scene(fake, 'b'))).error, /slow down/);
  await clock.advance(2000);
  assert.equal((await within(scene(fake, 'c'))).success, true);
});

test('a pause in /data further than 6 h is not ours: ignored', async () => {
  const clock = testClock();
  const store = createMemoryStore({ pauseUntil: clock.now() + 7 * 3600_000, pauseLevel: 1 });
  const { fake } = await connected({ store, clock });
  assert.equal((await within(scene(fake, 'a'))).success, true);
});

test('/data unreadable: never written, sending still works', async () => {
  const store = createMemoryStore();
  store.broken = true;
  const transport = fakeTransport();
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const { fake } = await connected({ store, transport });
  await within(scene(fake, 'a'));
  assert.equal(store.saves, 0);
});

test('getConfig failing in `connected`: status says so, retried, then started', async () => {
  const ctx = makeApp();
  // The first call is the SDK's own resync; the second is the integration's.
  let calls = 0;
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) {
      throw Object.assign(new Error('down'), { status: 503 });
    }
    return original();
  };
  await within(ctx.gladys.connect());
  assert.equal(ctx.fake.connectionStatus.connected, false);
  assert.match(ctx.fake.connectionStatus.message.en, /could not be read/);
  assert.match((await within(scene(ctx.fake, 'a'))).error, /configuration is not read yet/);
  await ctx.clock.advance(5000);
  await settle();
  assert.equal(ctx.fake.connectionStatus.connected, true);
  assert.equal((await within(scene(ctx.fake, 'b'))).success, true);
});

test('stop: waiting messages refused, no timer left, nothing sent after', async () => {
  const transport = fakeTransport();
  const { fake, app, clock } = await connected({ transport });
  const a = scene(fake, 'a');
  const b = scene(fake, 'b');
  await settle();
  app.stop();
  assert.match((await within(b)).error, /integration is stopping/);
  assert.equal((await within(a)).success, true);
  await settle();
  assert.equal(clock.pending, 0);
  await clock.advance(10_000);
  assert.deepEqual(transport.sent, ['a']);
  assert.match((await within(scene(fake, 'c'))).error, /stopping/);
});

// --- Chat -> Gladys ------------------------------------------------------------------

const form = (extra = {}) =>
  chatForm({
    token: OUT_TOKEN,
    channel_id: '4',
    channel_name: 'maison',
    user_id: '7',
    username: 'louis',
    post_id: '1001',
    timestamp: String(Date.UTC(2026, 0, 1)),
    text: 'gladys  lumières\toff',
    trigger_word: 'gladys',
    ...extra,
  });

test('a command with the right token fires the scene event; nothing answered, nothing sent', async () => {
  const { fake, transport } = await connected();
  const ack = await within(fake.webhook('chat', form()));
  assert.equal(ack, undefined);
  assert.deepEqual(fake.sceneEvents, [
    {
      key: 'command_received',
      data: {
        text: 'gladys lumières off',
        command: 'lumières off',
        trigger_word: 'gladys',
        username: 'louis',
        user_id: 7,
        channel_name: 'maison',
        channel_id: 4,
        source: 'channel',
      },
    },
  ]);
  assert.equal(transport.calls.length, 0);
  // The sync mode (never declared) answers nothing either.
  const sync = await within(fake.webhook('chat', form({ post_id: '1002' }), { mode: 'sync' }));
  assert.equal(sync.data, undefined);
});

test('a slash command or a bot (no channel) is "direct"; a JSON body is read too', async () => {
  const { fake } = await connected();
  await within(
    fake.webhook('chat', chatForm({ token: OUT_TOKEN, user_id: '3', username: 'a', text: 'ping' })),
  );
  await within(
    fake.webhook('chat', {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ token: OUT_TOKEN, text: 'pong', __proto__: { polluted: 1 } }),
    }),
  );
  assert.deepEqual(
    fake.sceneEvents.map((e) => [e.data.command, e.data.source, e.data.trigger_word]),
    [
      ['ping', 'direct', null],
      ['pong', 'direct', null],
    ],
  );
  assert.equal({}.polluted, undefined);
});

test('refused: wrong token, no token typed, token only in the query, unreadable or oversized body', async () => {
  const { fake, lines } = await connected();
  await within(fake.webhook('chat', form({ token: 'WrongTokenXXXXXXXX' })));
  await within(
    fake.webhook('chat', {
      ...form(),
      body: form().body.replace(/token=[^&]+&/, ''),
      query: { token: OUT_TOKEN },
    }),
  );
  await within(
    fake.webhook('chat', { method: 'POST', body: '{not json', contentType: 'application/json' }),
  );
  await within(fake.webhook('chat', form({ text: 'x'.repeat(20_000) })));
  assert.equal(fake.sceneEvents.length, 0);
  assert.ok(!lines.join('\n').includes('WrongToken'));

  const none = await connected({ config: { incoming_url: INCOMING, certificate_fingerprint: FP } });
  await within(none.fake.webhook('chat', form()));
  assert.equal(none.fake.sceneEvents.length, 0);
  assert.match(none.fake.connectionStatus.message.en, /token of the outgoing webhook is missing/);
});

test('several tokens: any of them is accepted', async () => {
  const { fake } = await connected({
    config: {
      incoming_url: INCOMING,
      certificate_fingerprint: FP,
      outgoing_token: `AnotherToken123, ${OUT_TOKEN}`,
    },
  });
  await within(fake.webhook('chat', form()));
  assert.equal(fake.sceneEvents.length, 1);
});

test('a duplicate (same post_id), a stale message and an echo of our own message are dropped', async () => {
  const { fake, clock } = await connected();
  await within(fake.webhook('chat', form()));
  await within(fake.webhook('chat', form()));
  assert.equal(fake.sceneEvents.length, 1);
  await within(
    fake.webhook(
      'chat',
      form({ post_id: '2', timestamp: String(Math.floor(clock.now() - 11 * 60_000)) }),
    ),
  );
  assert.equal(fake.sceneEvents.length, 1);
  // A scene answered with a message that starts with the trigger word.
  await drive(clock, scene(fake, 'gladys lumières off'));
  await within(fake.webhook('chat', form({ post_id: '3', timestamp: '' })));
  assert.equal(fake.sceneEvents.length, 1, 'echo dropped');
  await clock.advance(61_000);
  await within(fake.webhook('chat', form({ post_id: '4', timestamp: '' })));
  assert.equal(fake.sceneEvents.length, 2);
});

test('at most 20 requests a minute are handled', async () => {
  const { fake, clock } = await connected();
  for (let i = 0; i < 30; i += 1) {
    await within(fake.webhook('chat', form({ post_id: String(100 + i), timestamp: '' })));
  }
  assert.equal(fake.sceneEvents.length, 20);
  await clock.advance(60_001);
  await within(fake.webhook('chat', form({ post_id: '999', timestamp: '' })));
  assert.equal(fake.sceneEvents.length, 21);
});

test('a scene event refused by Gladys does not break the next ones', async (t) => {
  const { fake, gladys } = await connected();
  let first = true;
  const original = gladys.publishSceneEvent.bind(gladys);
  t.mock.method(gladys, 'publishSceneEvent', async (...args) => {
    if (first) {
      first = false;
      throw Object.assign(new Error('too many'), { status: 429 });
    }
    return original(...args);
  });
  await within(fake.webhook('chat', form({ post_id: '1' })));
  await within(fake.webhook('chat', form({ post_id: '2' })));
  assert.equal(fake.sceneEvents.length, 1);
});

test('nothing secret in /data, the statuses nor the logs', async () => {
  const store = createMemoryStore();
  const transport = fakeTransport();
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const { fake, lines } = await connected({ store, transport });
  await within(scene(fake, 'private text'));
  await within(fake.webhook('chat', form({ token: 'BadTokenZZZZZZZZ' })));
  await within(fake.webhook('chat', form()));
  const all = JSON.stringify([store.data, fake.connectionStatuses, lines]);
  for (const secret of [URL_TOKEN, OUT_TOKEN, 'BadTokenZZZZZZZZ', 'private text', 'nas.local']) {
    assert.ok(!all.includes(secret), secret);
  }
  assert.ok(!statusText(fake).includes('lumières'));
});

test('a reconnection publishes the status again; a status Gladys refused is sent again', async (t) => {
  const { fake, gladys, app } = await connected();
  const count = fake.connectionStatuses.length;
  await within(app.onConnected());
  assert.equal(fake.connectionStatuses.length, count + 1);
  let refuse = true;
  const original = gladys.setConnectionStatus.bind(gladys);
  t.mock.method(gladys, 'setConnectionStatus', async (...args) => {
    if (refuse) throw Object.assign(new Error('down'), { status: 503 });
    return original(...args);
  });
  await within(fake.configUpdated({}));
  refuse = false;
  await within(fake.configUpdated({}));
  assert.match(fake.connectionStatus.message.en, /Paste the URL/);
});

test('the end of a pause refreshes the status; a 503 after stop() arms nothing', async () => {
  const transport = fakeTransport();
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const { fake, clock, app } = await connected({ transport });
  await within(scene(fake, 'a'));
  await settle();
  assert.equal(fake.connectionStatus.connected, false);
  await clock.advance(PAUSE_MIN + 1);
  await settle();
  // Sending is possible again: ready, the 5xx is over.
  assert.equal(fake.connectionStatus.connected, true);
  assert.match(fake.connectionStatus.message.en, /Ready to send/);

  let release;
  transport.answers.push(() => new Promise((resolve) => (release = resolve)));
  const pending = scene(fake, 'b');
  await settle();
  app.stop();
  release({ status: 503, headers: {}, body: Buffer.alloc(0) });
  await within(pending);
  await settle();
  assert.equal(clock.pending, 0);
});

test('messages waiting behind a request answered 503 are never sent', async () => {
  const transport = fakeTransport();
  let release;
  transport.answers.push(() => new Promise((resolve) => (release = resolve)));
  const { fake, clock } = await connected({ transport });
  const a = scene(fake, 'a');
  const b = scene(fake, 'b');
  const c = scene(fake, 'c');
  await settle();
  await clock.advance(SEND_GAP * 3);
  release({ status: 503, headers: {}, body: Buffer.alloc(0) });
  assert.match((await within(a)).error, /HTTP 503/);
  assert.match((await within(b)).error, /slow down/);
  assert.match((await within(c)).error, /slow down/);
  await clock.advance(SEND_GAP * 3);
  assert.deepEqual(transport.sent, ['a']);
});

test('messages past their deadline are dropped and never sent once the line clears', async () => {
  const transport = fakeTransport();
  let release;
  transport.answers.push(() => new Promise((resolve) => (release = resolve)));
  const { fake, clock } = await connected({ transport });
  const a = scene(fake, 'a');
  const b = scene(fake, 'b');
  await settle();
  await clock.advance(SCENE_DEADLINE + 1);
  assert.match((await within(b)).error, /waited too long/);
  release({ status: 200, headers: {}, body: Buffer.from('{"success":true}') });
  assert.equal((await within(a)).success, true);
  await clock.advance(SEND_GAP * 5);
  await settle();
  assert.deepEqual(transport.sent, ['a']);
});

test('the configuration changed during the TLS handshake: nothing written to the old URL', async () => {
  const transport = fakeTransport();
  const { fake } = await connected({ transport });
  transport.beforePeer = async () => {
    transport.beforePeer = undefined;
    await fake.configUpdated({
      incoming_url: INCOMING.replace('nas.local', 'nas2.local'),
      certificate_fingerprint: FP,
    });
  };
  const ack = await within(scene(fake, 'a'));
  assert.match(ack.error, /Nothing sent: the configuration changed/);
  assert.deepEqual(transport.sent, []);
  assert.equal(fake.connectionStatus.connected, true, 'not a failure of the new URL');
});

// --- r1 ----------------------------------------------------------------------------

test('a write of /data that never returns never holds the queue (503, then success)', async () => {
  const store = createMemoryStore();
  store.save = () => new Promise(() => {});
  const transport = fakeTransport();
  transport.answers.push({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const { fake, clock } = await connected({ store, transport });
  assert.match((await within(scene(fake, 'a'))).error, /HTTP 503/);
  await clock.advance(PAUSE_MIN + 1);
  // The success after a pause writes /data too (level back to 0): never awaited.
  assert.equal((await within(scene(fake, 'b'))).success, true);
  await clock.advance(SEND_GAP);
  assert.equal((await within(scene(fake, 'c'))).success, true);
  assert.deepEqual(transport.sent, ['a', 'b', 'c']);
});

test('a status Gladys never acknowledges does not hold the ack of a message', async (t) => {
  const { fake, gladys, clock, transport } = await connected();
  t.mock.method(gladys, 'setConnectionStatus', () => new Promise(() => {}));
  assert.equal((await within(scene(fake, 'a'), 1000)).success, true);
  await clock.advance(SEND_GAP);
  const button = await within(drive(clock, fake.action('test_message', {})), 2000);
  assert.equal(button.success, true);
  // A failure changes the status: its ack does not wait for it either.
  transport.answers.push({ status: 404, headers: {}, body: Buffer.alloc(0) });
  await clock.advance(SEND_GAP);
  assert.match((await within(scene(fake, 'b'), 1000)).error, /HTTP 404/);
});

test('waiting plus the request stays under the delay Gladys grants the action and the button', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const margin = 3000;
  const send = manifest.scene_actions.find((a) => a.key === 'send_message');
  const button = manifest.actions.find((a) => a.key === 'test_message');
  assert.ok(SCENE_DEADLINE + REQUEST_TIMEOUT + margin <= send.timeout_seconds * 1000);
  assert.ok(TEST_DEADLINE + REQUEST_TIMEOUT + margin <= button.timeout_seconds * 1000);
});

test('a message queued before an http URL was saved without the option is never sent', async () => {
  const transport = fakeTransport();
  let release;
  transport.answers.push(() => new Promise((resolve) => (release = resolve)));
  const { fake, clock } = await connected({ transport });
  const a = scene(fake, 'a');
  const b = scene(fake, 'b');
  await settle();
  await within(fake.configUpdated({ incoming_url: INCOMING.replace('https:', 'http:') }));
  release({ status: 200, headers: {}, body: Buffer.from('{"success":true}') });
  assert.equal((await within(a)).success, true);
  await clock.advance(SEND_GAP);
  assert.match((await within(b)).error, /^Nothing sent: The URL starts with http:\/\//);
  assert.deepEqual(transport.sent, ['a']);
});

test('a long command is cut in UTF-16 units under the limit of Gladys, never inside a pair', async () => {
  const { fake } = await connected();
  await within(fake.webhook('chat', form({ text: `gladys ${'😀'.repeat(700)}`, post_id: '77' })));
  assert.equal(fake.sceneEvents.length, 1);
  const { text, command } = fake.sceneEvents[0].data;
  assert.ok(text.length <= 1000 && text.length >= 998, String(text.length));
  assert.doesNotMatch(text, /[\uD800-\uDBFF]$/);
  assert.ok(command.length < text.length);
});

test('a new URL lifts the pause; the button waits for it otherwise', async () => {
  const store = createMemoryStore();
  const transport = fakeTransport();
  transport.answers.push({ status: 502, headers: {}, body: Buffer.alloc(0) });
  const { fake, clock } = await connected({ store, transport });
  await within(scene(fake, 'a'));
  await clock.advance(SEND_GAP);
  const button = await within(fake.action('test_message', {}));
  assert.match(button.data.message.en, /slow down/);
  await within(
    fake.configUpdated({
      incoming_url: INCOMING.replace('nas.local', 'proxy.local'),
      certificate_fingerprint: FP,
    }),
  );
  await settle();
  assert.equal(store.data.pauseLevel, 0);
  assert.equal(fake.connectionStatus.connected, true);
  assert.equal((await within(scene(fake, 'b'))).success, true);
});

test('the echo guard remembers every message the queue can send in a minute', async () => {
  const { fake, clock } = await connected();
  for (let i = 0; i < 40; i += 1) {
    await drive(clock, scene(fake, `gladys reply ${i}`));
  }
  await within(
    fake.webhook('chat', form({ text: 'gladys reply 0', post_id: '500', timestamp: '' })),
  );
  assert.equal(fake.sceneEvents.length, 0);
});
