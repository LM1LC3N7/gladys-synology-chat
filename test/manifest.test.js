// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  ACTIONS,
  MAX_MESSAGE_LENGTH,
  REQUEST_TIMEOUT,
  SCENE_ACTIONS,
  SCENE_DEADLINE,
  SCENE_TRIGGERS,
  TEST_DEADLINE,
  USER_AGENT,
  VERSION,
  WEBHOOKS,
} from '../src/constants.js';
import { inboundEvent } from '../src/inbound.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const allFields = [
  ...manifest.config_schema,
  ...manifest.actions.flatMap((a) => a.fields ?? []),
  ...manifest.scene_actions.flatMap((a) => a.fields ?? []),
  ...manifest.scene_triggers.flatMap((a) => a.fields ?? []),
];

test('the store basics: one version everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.countries, undefined, 'worldwide: no countries');
  assert.equal(manifest.keywords, undefined);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-synology-chat');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.ok(
    USER_AGENT.startsWith(`gladys-synology-chat/${pkg.version} (+https://github.com/LM1LC3N7/`),
  );
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-synology-chat:${manifest.version}`);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-synology-chat/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['notifications']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300);
    assert.match(docs, /not\s+affiliated\s+with\s+Synology|sans\s+lien\s+avec\s+Synology/i);
    assert.match(
      docs,
      /never\s+been\s+tested\s+with\s+a\s+real\s+NAS|jamais\s+été\s+testée\s+avec\s+un\s+vrai\s+NAS/i,
    );
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of allFields.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no network capture, no extra container, no device', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.network_wake, undefined);
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the configuration matches the code; secrets without default; no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const field of manifest.config_schema) assert.doesNotMatch(field.key, /^gladys_/, field.key);
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type === 'secret').map((f) => f.key),
    ['incoming_url', 'outgoing_token'],
  );
  for (const secret of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.equal(secret.default, undefined, secret.key);
    assert.match(secret.description.fr, /[Gg]ardée? par Gladys dans sa base, jamais réaffichée?/);
    assert.match(secret.description.en, /[Kk]ept by Gladys in its database, never shown again/);
  }
  assert.equal(fields.incoming_url.required, true);
  assert.equal(fields.allow_http.default, false);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('actions, scene action, trigger and webhook are the ones the code handles', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  assert.ok(manifest.actions[0].timeout_seconds * 1000 >= TEST_DEADLINE + REQUEST_TIMEOUT + 3000);

  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
  assert.ok(handlers.includes('onSceneAction(SCENE_ACTIONS.SEND'));
  const send = manifest.scene_actions[0];
  // The deadline of the queue leaves room before Gladys gives up the action.
  assert.ok(send.timeout_seconds * 1000 >= SCENE_DEADLINE + REQUEST_TIMEOUT + 3000);
  assert.ok(send.description.en.includes(String(MAX_MESSAGE_LENGTH)));
  assert.equal(send.outputs, undefined);

  assert.deepEqual(manifest.webhooks, [
    {
      key: WEBHOOKS.CHAT,
      label: manifest.webhooks[0].label,
      mode: 'fire_and_forget',
    },
  ]);
  assert.ok(handlers.includes('onWebhook(WEBHOOKS.CHAT'));
  assert.ok(handlers.includes('onWebhookUpdated('));

  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key),
    Object.values(SCENE_TRIGGERS),
  );
  const trigger = manifest.scene_triggers[0];
  // Every filter is a variable, and the event carries exactly the variables.
  const variables = trigger.variables.map((v) => v.key);
  for (const field of trigger.fields) assert.ok(variables.includes(field.key), field.key);
  const event = inboundEvent(
    {
      body: 'token=tokentoken&text=hello&channel_id=1&user_id=2&username=u&channel_name=c&trigger_word=h',
    },
    { tokens: ['tokentoken'], wallNow: 0, maxSkew: 1 },
  );
  assert.deepEqual(Object.keys(event.data).sort(), [...variables].sort());
  for (const v of trigger.variables) {
    const value = event.data[v.key];
    assert.ok(value === null || typeof value === v.type, `${v.key}: ${typeof value}`);
  }
  assert.ok(variables.length <= 20 && trigger.fields.length <= 10);
});

test('the image ships the license and the notices', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Synology/);
});
