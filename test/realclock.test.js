// -----------------------------------------------------------------------------
// On a real clock (sped up x10): the messages of a burst leave one at a time,
// a second apart (never sooner), and nothing is left armed after stop().
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEND_GAP } from '../src/constants.js';
import { makeApp, within } from './helpers/app.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';

test('a burst of messages is sent one second apart', async (t) => {
  const clock = realClock({ speed: 10 });
  const ctx = makeApp({ clock });
  t.after(() => {
    ctx.app.stop();
    clock.close();
  });
  await within(ctx.gladys.connect());
  const spy = spyOn(ctx.app, 'deliver', clock);
  const acks = ['a', 'b', 'c', 'd'].map((text) => ctx.fake.sceneAction('send_message', { text }));
  await measurePeriod(spy, { count: 4, period: SEND_GAP, max: SEND_GAP * 2 });
  for (const ack of await within(Promise.all(acks), 10_000)) assert.equal(ack.success, true);
  assert.deepEqual(ctx.transport.sent, ['a', 'b', 'c', 'd']);
  ctx.app.stop();
  const armed = clock.timersSet;
  await clock.sleep(5000);
  assert.equal(clock.timersSet, armed, 'no timer armed after stop()');
});
