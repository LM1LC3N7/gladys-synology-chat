// -----------------------------------------------------------------------------
// The transport on REAL sockets (127.0.0.1): the certificate checked before a
// single byte of the request (its path holds the token), an answer that came
// first never read, bounded answers, a deadline, no redirect followed; then
// the whole app against a fake NAS in HTTPS.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ChatApp } from '../src/app.js';
import { CODES, ChatError, postForm } from '../src/http.js';
import { createMemoryStore } from '../src/store.js';
import { messageBody } from '../src/synology.js';
import { blackhole, certs, httpServer, httpsServer, impostorServer, reply } from './kit/index.mjs';
import { within } from './helpers/app.js';

const PATH = '/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22tok%22';
const target = (port, scheme = 'https') => ({ scheme, host: '127.0.0.1', port, path: PATH });
const options = (extra = {}) => ({
  body: messageBody('hello'),
  timeout: 3000,
  maxBytes: 16 * 1024,
  checkPeer: () => {},
  ...extra,
});
const NAS_ROUTES = { 'POST /webapi/entry.cgi': () => ({ success: true }) };

test('the certificate is checked before a byte is written; refused: nothing sent', async (t) => {
  const srv = await httpsServer({ routes: NAS_ROUTES });
  t.after(() => srv.close());
  let seen;
  await assert.rejects(
    within(
      postForm(
        target(srv.port),
        options({
          checkPeer: (fp, authorized) => {
            seen = { fp, authorized };
            throw new ChatError(CODES.CERTIFICATE, 'no', { fingerprint: fp });
          },
        }),
      ),
    ),
    (err) => err.code === CODES.CERTIFICATE && err.notSent === true,
  );
  assert.deepEqual(seen, { fp: certs.device.fingerprint256, authorized: false });
  assert.equal(srv.requests.length, 0);
});

test('accepted: the form is posted, the answer read', async (t) => {
  const srv = await httpsServer({ routes: NAS_ROUTES });
  t.after(() => srv.close());
  let sent = 0;
  const answer = await within(postForm(target(srv.port), options({ onSent: () => (sent += 1) })));
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { success: true });
  assert.equal(sent, 1);
  const [request] = srv.requests;
  assert.equal(request.url, PATH);
  assert.match(request.headers['content-type'], /^application\/x-www-form-urlencoded/);
  assert.match(request.headers['user-agent'], /^gladys-synology-chat\/0\.1\.0 /);
  assert.deepEqual(JSON.parse(new URLSearchParams(request.body).get('payload')), { text: 'hello' });
});

test('an impostor answering before the request: never read, nothing written', async (t) => {
  const imp = await impostorServer();
  t.after(() => imp.close());
  // Even a check that lets it through (slowly) never reads its forged answer.
  await assert.rejects(
    within(
      postForm(
        target(imp.port),
        options({ checkPeer: () => new Promise((resolve) => setTimeout(resolve, 100)) }),
      ),
    ),
    (err) => err.notSent === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(imp.received, 0);
});

test('oversized answer cut, silent NAS timed out, redirect returned as is', async (t) => {
  const big = await httpsServer({ routes: NAS_ROUTES, bigBody: 64 * 1024 });
  const redirect = await httpsServer({
    routes: {
      'POST /webapi/entry.cgi': () => reply(302, '', { location: 'https://127.0.0.1:1/' }),
    },
  });
  const hole = await blackhole();
  t.after(() => Promise.all([big.close(), redirect.close(), hole.close()]));
  await assert.rejects(
    within(postForm(target(big.port), options())),
    (e) => e.code === CODES.TOO_LARGE,
  );
  await assert.rejects(
    within(postForm(target(hole.port), options({ timeout: 300 }))),
    (e) => e.code === CODES.TIMEOUT && e.notSent === true,
  );
  const answer = await within(postForm(target(redirect.port), options()));
  assert.equal(answer.status, 302);
  assert.equal(redirect.requests.length, 1);
});

test('plain HTTP (when allowed): posted without TLS; a refused port is "not sent"', async (t) => {
  const srv = await httpServer({ routes: NAS_ROUTES });
  t.after(() => srv.close());
  const answer = await within(postForm(target(srv.port, 'http'), options()));
  assert.equal(answer.status, 200);
  await srv.close();
  await assert.rejects(
    within(postForm(target(srv.port, 'http'), options())),
    (e) => e.code === CODES.UNREACHABLE && !String(e.message).includes('127.0.0.1'),
  );
});

test('end to end: the app pins the typed fingerprint and posts to a fake NAS', async (t) => {
  const srv = await httpsServer({ routes: NAS_ROUTES });
  const imp = await impostorServer();
  t.after(() => Promise.all([srv.close(), imp.close()]));
  const url = (port) => `https://127.0.0.1:${port}${PATH}`;
  const gladys = createFakeGladys({
    config: { incoming_url: url(srv.port), certificate_fingerprint: certs.device.fingerprint256 },
  });
  const app = new ChatApp({ gladys, store: createMemoryStore() });
  t.after(() => app.stop());
  await app.start(gladys.fake.config);
  await within(app.send('bonjour', 5000));
  assert.equal(srv.requests.length, 1);
  // The same fingerprint typed, another certificate: nothing written.
  await app.start({
    incoming_url: url(imp.port),
    certificate_fingerprint: certs.device.fingerprint256,
  });
  await assert.rejects(within(app.send('x', 5000)), (e) => e.notSent === true);
  assert.equal(imp.received, 0);
  assert.ok(JSON.stringify(gladys.fake.connectionStatus).includes(certs.impostor.fingerprint256));
});
