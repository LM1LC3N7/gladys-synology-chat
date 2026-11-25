// -----------------------------------------------------------------------------
// Constants of the Synology Chat integration. Manifest keys are forever: they
// are stored in the users' scenes.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of package.json (bumped by the Release workflow, shipped in the image). */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-synology-chat/${VERSION} (+https://github.com/LM1LC3N7/gladys-synology-chat)`;

export const ACTIONS = { TEST: 'test_message' };
export const SCENE_ACTIONS = { SEND: 'send_message' };
export const SCENE_TRIGGERS = { COMMAND: 'command_received' };
export const WEBHOOKS = { CHAT: 'chat' };

/** The longest URL accepted for the incoming webhook. */
export const MAX_URL_LENGTH = 2048;
/** Longest message sent (characters): a longer one is cut, with an ellipsis. */
export const MAX_MESSAGE_LENGTH = 2000;
/** Longest text relayed to a scene (the core caps a string at 1000). */
export const MAX_EVENT_TEXT = 1000;
/** Longest name, trigger word or channel relayed to a scene. */
export const MAX_EVENT_NAME = 200;
/** At most this many outgoing tokens (outgoing webhook, slash command, bot...). */
export const MAX_TOKENS = 5;

/** One request to the NAS: the whole exchange, and the answer size. */
export const REQUEST_TIMEOUT = 10_000;
export const MAX_ANSWER_BYTES = 16 * 1024;

/** The send queue: one request in flight, at least this gap between two. */
export const SEND_GAP = 1000;
/** At most this many messages waiting; more are refused (nothing sent). */
export const QUEUE_MAX = 10;
/** A message not started within this delay is dropped (nothing sent). */
// Waiting + the request (REQUEST_TIMEOUT) stays under the timeout_seconds of
// the scene action (30 s) and of the button (30 s): Gladys never gives up on a
// message that may still leave.
export const SCENE_DEADLINE = 15_000;
export const TEST_DEADLINE = 15_000;

/** The pause after a 429 or a 5xx of the NAS: doubled up to the maximum. */
export const PAUSE_MIN = 60_000;
export const PAUSE_MAX = 60 * 60_000;
/** A Retry-After above this is capped. */
export const RETRY_AFTER_MAX = 6 * 60 * 60_000;

/** getConfig() that fails: retried, doubled up to the maximum. */
export const CONFIG_RETRY_MIN = 5000;
export const CONFIG_RETRY_MAX = 5 * 60_000;

/** Inbound (chat -> Gladys): body cap, rate, duplicates, echoes, freshness. */
export const MAX_INBOUND_BYTES = 16 * 1024;
export const INBOUND_PER_MINUTE = 20;
export const SEEN_POSTS = 500;
export const ECHO_WINDOW = 60_000;
export const ECHO_KEEP = 20;
/** A message dated further than this from the clock of Gladys is ignored. */
export const INBOUND_MAX_SKEW = 10 * 60_000;
/** At most one warning per this delay for refused inbound requests. */
export const WARN_EVERY = 60_000;

export const DEFAULT_STATE_FILE = '/data/synology-chat-state.json';
