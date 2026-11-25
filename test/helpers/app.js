// A ChatApp on the SDK's fake Gladys, a memory /data, a virtual clock and a
// fake transport (each call checks the peer as the real one does, then
// answers what the test queued).

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ChatApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { ChatError, CODES } from '../../src/http.js';
import { createMemoryStore } from '../../src/store.js';
import { testClock } from '../kit/index.mjs';

export const URL_TOKEN = 'SeCrEtToKeN1234567890abcdef';
export const INCOMING = `https://nas.local:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22${URL_TOKEN}%22`;
export const OUT_TOKEN = 'OutGoingTokenABCDEFGH123456';
export const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
);
export const OTHER_FP = Array.from({ length: 32 }, () => 'AA').join(':');

export const ok = () => ({ status: 200, headers: {}, body: Buffer.from('{"success":true}') });

/** A fake transport: `answers` is a list of answers, errors, or functions. */
export function fakeTransport({ fingerprint = FP, authorized = false } = {}) {
  const t = {
    fingerprint,
    authorized,
    calls: [],
    sent: [],
    answers: [],
    async post(target, options) {
      const call = { target, options, at: undefined };
      t.calls.push(call);
      if (target.scheme === 'https') {
        // The TLS handshake takes time: the test may act meanwhile.
        if (t.beforePeer) await t.beforePeer(call);
        try {
          await options.checkPeer(t.fingerprint, t.authorized);
        } catch (err) {
          throw Object.assign(err, { notSent: true });
        }
      }
      options.onSent?.();
      const text = JSON.parse(
        decodeURIComponent(options.body.toString('utf8').replace(/^payload=/, '')),
      ).text;
      t.sent.push(text);
      const next = t.answers.length ? t.answers.shift() : ok();
      const answer = typeof next === 'function' ? await next(call) : next;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return t;
}

export const sentNoAnswer = () => new ChatError(CODES.TIMEOUT, 'No answer', { notSent: false });

export function makeApp({
  config = { incoming_url: INCOMING, certificate_fingerprint: FP, outgoing_token: OUT_TOKEN },
  webhooks = {
    available: true,
    webhooks: [{ key: 'chat', mode: 'fire_and_forget', url: 'https://plus/x' }],
  },
  store = createMemoryStore(),
  clock = testClock(),
  transport = fakeTransport(),
} = {}) {
  const gladys = createFakeGladys({ selector: 'synology-chat', config, webhooks });
  const lines = [];
  const logger = createLogger({ level: 'silent' });
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  }
  const app = new ChatApp({
    gladys,
    logger,
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    post: transport.post,
  });
  registerHandlers(gladys, app, logger);
  return { app, gladys, fake: gladys.fake, store, clock, transport, lines };
}

/** A form body as Synology Chat posts it. */
export function chatForm(fields) {
  return {
    method: 'POST',
    query: {},
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams(fields).toString(),
  };
}

/** Rejects past `ms` of real time: a test fails, never hangs. */
export function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Advances the virtual clock until `promise` settles (bounded: fails, never hangs). */
export async function drive(clock, promise, { step = 100, max = 2000 } = {}) {
  let done = false;
  const tracked = promise.finally(() => (done = true));
  for (let i = 0; i < max && !done; i += 1) {
    await clock.advance(step);
  }
  return within(tracked, 1000);
}
