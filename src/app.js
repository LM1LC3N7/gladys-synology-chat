// -----------------------------------------------------------------------------
// The integration itself. index.js only wires the SDK handlers to it.
//
// Gladys -> chat: the scene action "Send a message" (and the test button)
// posts to the incoming webhook of the NAS. One request in flight, at least
// SEND_GAP between two, at most QUEUE_MAX waiting, each dropped ("nothing
// sent") when not started within its deadline. A 429 or a 5xx of the NAS
// pauses every send (60 s doubled up to 1 h, a longer Retry-After honoured up
// to 6 h), the end of the pause kept in /data for a restart. A message is
// never sent twice by the integration: one that left without a readable
// answer is reported "sent, without confirmation".
//
// The certificate: nothing is written to the NAS (the path of the request
// holds the token) before its certificate is checked: signed by an authority
// for the name in the URL, or the SHA-256 fingerprint the user typed (a
// self-signed certificate). The fingerprint met is shown in the status; a
// certificate that changes is never learned by itself.
//
// Chat -> Gladys: Synology Chat posts to the URL of the Gladys Plus webhook
// (relayed to `handleWebhook`). Only a request whose `token` is one of the
// tokens typed is turned into the scene event `command_received`; a token is
// required (none typed: every request is ignored). Never a reply: the webhook
// is fire_and_forget (Gladys answers an empty 200, which Synology Chat does
// not post), and nothing is sent in reaction to a received message. Bounded:
// INBOUND_PER_MINUTE requests a minute, duplicates (post_id) dropped, an echo
// of a message the integration just sent dropped (a scene that answers a
// command with a message starting with the trigger word cannot loop).
//
// Clocks: `monotonic` decides (gap, deadlines, pause, rate); the wall clock
// only dates the pause kept in /data and checks the date of a received
// message. Each decision reads each clock once.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, sendBlocker } from './config.js';
import {
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  ECHO_KEEP,
  ECHO_WINDOW,
  INBOUND_MAX_SKEW,
  INBOUND_PER_MINUTE,
  MAX_ANSWER_BYTES,
  MAX_EVENT_TEXT,
  PAUSE_MAX,
  PAUSE_MIN,
  QUEUE_MAX,
  REQUEST_TIMEOUT,
  RETRY_AFTER_MAX,
  SCENE_DEADLINE,
  SCENE_TRIGGERS,
  SEEN_POSTS,
  SEND_GAP,
  TEST_DEADLINE,
  WARN_EVERY,
  WEBHOOKS,
} from './constants.js';
import { CODES, ChatError, postForm } from './http.js';
import { T } from './i18n.js';
import { inboundEvent, oneLine } from './inbound.js';
import { createFileStore } from './store.js';
import { interpretAnswer, messageBody, prepareText } from './synology.js';

/** A message that failed: `failure` says why (T.failure), `notSent` if nothing left. */
export class SendFailure extends Error {
  constructor(failure) {
    const text = T.failure(failure);
    super(text.en);
    this.name = 'SendFailure';
    this.failure = failure;
    this.text = text;
    this.notSent = failure.kind === 'not_sent' || failure.kind === 'paused';
  }
}

const notSent = (reason, extra = {}) => new SendFailure({ kind: 'not_sent', reason, ...extra });
const minutesOf = (ms) => Math.max(1, Math.ceil(ms / 60_000));

export class ChatApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'synology-chat' }),
    store = createFileStore(),
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    post = postForm,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.post = post;

    this.config = normalizeConfig();
    this.configRead = false;
    this.closed = false;
    this.generation = 0;
    this.webhookState = 'unknown';
    this.lastStatus = undefined;
    this.lastError = undefined;

    this.queue = [];
    this.busy = false;
    this.lastStart = undefined;
    this.pumpTimer = undefined;
    this.pauseUntil = undefined;
    this.pauseLevel = 0;
    this.pauseTimer = undefined;
    this.configTimer = undefined;
    this.configDelay = CONFIG_RETRY_MIN;

    this.inboundTimes = [];
    this.seenPosts = [];
    this.echoes = [];
    this.lastWarn = undefined;

    this.loadState();
  }

  // --- /data -------------------------------------------------------------------

  loadState() {
    const loaded = this.store.load();
    this.storeOk = loaded.ok;
    if (!loaded.ok) {
      this.logger.warn(`State file unreadable (${loaded.code}): kept as is, never overwritten`);
      return;
    }
    const { pauseUntil, pauseLevel } = loaded.data;
    const wall = this.now();
    const mono = this.monotonic();
    if (Number.isInteger(pauseLevel) && pauseLevel >= 0 && pauseLevel <= 20) {
      this.pauseLevel = pauseLevel;
    }
    // A pause further than the longest one possible is not ours: ignored.
    if (Number.isFinite(pauseUntil) && pauseUntil > wall && pauseUntil - wall <= RETRY_AFTER_MAX) {
      this.pauseUntil = mono + (pauseUntil - wall);
      this.armPauseTimer(pauseUntil - wall);
    }
  }

  async saveState() {
    if (!this.storeOk) return false;
    const remaining = this.pauseUntil === undefined ? 0 : this.pauseUntil - this.monotonic();
    try {
      await this.store.save({
        pauseUntil: remaining > 0 ? this.now() + remaining : null,
        pauseLevel: this.pauseLevel,
      });
      return true;
    } catch (err) {
      this.logger.warn(`State file not written (${String(err?.code ?? 'error').slice(0, 20)})`);
      return false;
    }
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** The `connected` event: read the configuration, retried while it fails. */
  async onConnected() {
    if (this.closed) return;
    this.clearConfigTimer();
    // A (re)connection publishes the status again, even unchanged.
    this.lastStatus = undefined;
    const generation = this.generation;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (this.closed || generation !== this.generation) return;
      this.logger.warn(`getConfig failed (${err?.status ?? err?.code ?? 'error'}): retrying`);
      const delay = this.configDelay;
      this.configDelay = Math.min(this.configDelay * 2, CONFIG_RETRY_MAX);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected().catch(() => {});
      }, delay);
      await this.updateStatus();
      return;
    }
    if (this.closed || generation !== this.generation) return;
    await this.start(raw);
  }

  /** A configuration read or saved: applied at once. */
  async start(raw) {
    if (this.closed) return;
    this.clearConfigTimer();
    this.configDelay = CONFIG_RETRY_MIN;
    const previous = this.config;
    const wasRead = this.configRead;
    this.config = normalizeConfig(raw);
    this.configRead = true;
    this.generation += 1;
    // Another URL or fingerprint: the last failure and the pause were the
    // previous target's (never at the first read: a pause kept in /data stays).
    if (
      JSON.stringify([previous.incoming, previous.fingerprint, previous.allowHttp]) !==
      JSON.stringify([this.config.incoming, this.config.fingerprint, this.config.allowHttp])
    ) {
      this.lastError = undefined;
      if (wasRead) this.liftPause();
    }
    const generation = this.generation;
    await this.refreshWebhooks();
    if (generation !== this.generation) return;
    await this.updateStatus();
  }

  /** The Gladys Plus relay state (also on onWebhookUpdated). */
  async refreshWebhooks(info) {
    try {
      const { available, webhooks } = info ?? (await this.gladys.getWebhooks());
      this.webhookState =
        available === true &&
        Array.isArray(webhooks) &&
        webhooks.some((w) => w?.key === WEBHOOKS.CHAT && typeof w.url === 'string' && w.url)
          ? 'available'
          : 'none';
    } catch (err) {
      this.logger.warn(`Webhook state unavailable (${err?.status ?? 'error'})`);
      this.webhookState = 'unknown';
    }
  }

  async webhooksUpdated(info) {
    if (this.closed) return;
    await this.refreshWebhooks(info);
    await this.updateStatus();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.clearConfigTimer();
    if (this.pumpTimer !== undefined) this.timers.clearTimeout(this.pumpTimer);
    if (this.pauseTimer !== undefined) this.timers.clearTimeout(this.pauseTimer);
    this.pumpTimer = undefined;
    this.pauseTimer = undefined;
    for (const job of this.queue.splice(0)) {
      this.timers.clearTimeout(job.timer);
      job.reject(notSent('closed'));
    }
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
  }

  // --- Status ------------------------------------------------------------------

  inboundState() {
    if (this.config.tokens === null) return 'token_invalid';
    if (this.webhookState === 'none') return 'no_plus';
    if (this.webhookState === 'unknown') return 'unknown';
    if (this.config.tokens.length === 0) return 'no_token';
    return 'active';
  }

  currentStatus() {
    if (!this.configRead) return [false, T.configUnread];
    const blocker = sendBlocker(this.config);
    if (blocker) return [false, T.blocker(blocker)];
    const mono = this.monotonic();
    if (this.pauseUntil !== undefined && this.pauseUntil > mono) {
      return [false, T.paused(minutesOf(this.pauseUntil - mono))];
    }
    const e = this.lastError;
    if (e?.reason === CODES.CERTIFICATE && e.fingerprint) {
      return [false, T.certificate(e.fingerprint)];
    }
    if (e?.reason === CODES.CERTIFICATE_TYPED && e.fingerprint) {
      return [false, T.certificateTyped(e.fingerprint)];
    }
    if (e) return [false, T.join(T.failure(e), T.inbound(this.inboundState()))];
    return [true, T.ready(this.inboundState())];
  }

  async updateStatus() {
    if (this.closed) return;
    const [connected, message] = this.currentStatus();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      // Not shown: published again at the next change or connection.
      if (this.lastStatus === key) this.lastStatus = undefined;
      this.logger.warn(`setConnectionStatus failed (${err?.status ?? 'error'})`);
    });
  }

  // --- Sending -----------------------------------------------------------------

  isPaused(mono) {
    return this.pauseUntil !== undefined && this.pauseUntil > mono;
  }

  /**
   * Queues one message. Resolves once Synology Chat confirmed it; rejects a
   * SendFailure (nothing sent, sent without confirmation, refused).
   */
  send(value, deadline) {
    if (this.closed) return Promise.reject(notSent('closed'));
    if (!this.configRead) return Promise.reject(notSent('config_unread'));
    const blocker = sendBlocker(this.config);
    if (blocker) return Promise.reject(new SendFailure({ kind: 'blocked', reason: blocker }));
    const text = prepareText(value);
    if (!text) return Promise.reject(notSent('empty'));
    const mono = this.monotonic();
    if (this.isPaused(mono)) {
      return Promise.reject(
        new SendFailure({ kind: 'paused', minutes: minutesOf(this.pauseUntil - mono) }),
      );
    }
    if (this.queue.length >= QUEUE_MAX) return Promise.reject(notSent('queue_full'));
    return new Promise((resolve, reject) => {
      const job = { text, resolve, reject };
      job.timer = this.timers.setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(notSent('deadline'));
      }, deadline);
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.closed) return;
    if (this.pumpTimer !== undefined) {
      this.timers.clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    while (this.queue.length > 0) {
      const mono = this.monotonic();
      if (this.isPaused(mono)) {
        const job = this.queue.shift();
        this.timers.clearTimeout(job.timer);
        job.reject(new SendFailure({ kind: 'paused', minutes: minutesOf(this.pauseUntil - mono) }));
        continue;
      }
      const wait = this.lastStart === undefined ? 0 : this.lastStart + SEND_GAP - mono;
      if (wait > 0) {
        this.pumpTimer = this.timers.setTimeout(
          () => {
            this.pumpTimer = undefined;
            this.pump();
          },
          Math.min(wait, SEND_GAP),
        );
        return;
      }
      const job = this.queue.shift();
      this.timers.clearTimeout(job.timer);
      this.busy = true;
      this.lastStart = mono;
      this.deliver(job.text)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.busy = false;
          this.pump();
        });
      return;
    }
  }

  /** The request of one message, right after it left the queue. */
  async deliver(text) {
    const config = this.config;
    const blocker = sendBlocker(config);
    if (blocker) throw new SendFailure({ kind: 'blocked', reason: blocker });
    let answer;
    try {
      answer = await this.post(config.incoming, {
        body: messageBody(text),
        timeout: REQUEST_TIMEOUT,
        maxBytes: MAX_ANSWER_BYTES,
        checkPeer: (fingerprint, authorized) => this.checkPeer(config, fingerprint, authorized),
        onSent: () => this.rememberEcho(text),
      });
    } catch (err) {
      const reason =
        err instanceof ChatError
          ? err.code
          : err?.reason === 'config_changed'
            ? 'config_changed'
            : 'unreachable';
      const failure =
        err?.notSent === false
          ? { kind: 'unconfirmed', reason }
          : {
              kind: 'not_sent',
              reason,
              ...(err?.fingerprint ? { fingerprint: err.fingerprint } : {}),
            };
      if (reason !== 'config_changed') this.recordFailure(config, failure);
      throw new SendFailure(failure);
    }
    const meaning = interpretAnswer(answer, this.now());
    if (meaning.kind === 'ok') {
      this.recordSuccess(config);
      return;
    }
    let failure;
    if (meaning.kind === 'pause') {
      const ms = this.startPause(meaning.retryAfter);
      failure = { kind: 'pause_started', status: answer.status, minutes: minutesOf(ms) };
    } else if (meaning.kind === 'unconfirmed') {
      failure = { kind: 'unconfirmed', reason: 'unconfirmed' };
    } else {
      failure = { ...meaning };
    }
    this.recordFailure(config, failure);
    throw new SendFailure(failure);
  }

  /**
   * Right after the TLS handshake, before any byte is written: a fingerprint
   * typed is the authority (another certificate is refused, even one signed
   * by an authority); without one, the certificate must be signed by an
   * authority for the name of the URL.
   */
  checkPeer(config, fingerprint, authorized) {
    if (config !== this.config || this.closed) {
      throw Object.assign(new Error('Configuration changed'), { reason: 'config_changed' });
    }
    if (config.fingerprint) {
      if (fingerprint !== config.fingerprint) {
        throw new ChatError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', { fingerprint });
      }
      return;
    }
    if (!authorized) {
      throw new ChatError(CODES.CERTIFICATE, 'Certificate not confirmed', { fingerprint });
    }
  }

  /**
   * The outcome of a message: kept for the status, which is published (and
   * /data written) WITHOUT waiting: neither may hold the queue nor the ack of
   * the message (Gladys gives up the action at 30 s).
   */
  recordFailure(config, failure) {
    if (config !== this.config) return;
    this.lastError = failure;
    this.logger.warn(
      `Message not confirmed: ${failure.kind} ${failure.reason ?? failure.status ?? failure.code ?? ''}`.trim(),
    );
    this.publishStatus();
  }

  recordSuccess(config) {
    if (this.pauseLevel !== 0) {
      this.pauseLevel = 0;
      this.saveState();
    }
    if (config !== this.config) return;
    this.lastError = undefined;
    this.publishStatus();
  }

  /** updateStatus without waiting (errors already handled there). */
  publishStatus() {
    this.updateStatus().catch(() => {});
  }

  /** A new target: the pause of the previous one no longer applies. */
  liftPause() {
    if (this.pauseUntil === undefined && this.pauseLevel === 0) return;
    this.pauseUntil = undefined;
    this.pauseLevel = 0;
    if (this.pauseTimer !== undefined) this.timers.clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.saveState();
  }

  /** A 429/5xx: every send paused, kept in /data. Resolves the length (ms). */
  startPause(retryAfter) {
    this.pauseLevel = Math.min(this.pauseLevel + 1, 20);
    const doubled = Math.min(PAUSE_MIN * 2 ** (this.pauseLevel - 1), PAUSE_MAX);
    const ms = Math.min(Math.max(doubled, retryAfter ?? 0), RETRY_AFTER_MAX);
    this.pauseUntil = this.monotonic() + ms;
    this.armPauseTimer(ms);
    // Kept for a restart, never awaited: a slow /data never holds the queue.
    this.saveState();
    return ms;
  }

  /** Only to refresh the status when the pause ends (a finite delay). */
  armPauseTimer(ms) {
    if (this.closed) return;
    if (this.pauseTimer !== undefined) this.timers.clearTimeout(this.pauseTimer);
    this.pauseTimer = this.timers.setTimeout(() => {
      this.pauseTimer = undefined;
      // Sending is possible again: the 5xx that started the pause is over.
      if (this.lastError?.kind === 'pause_started') this.lastError = undefined;
      this.publishStatus();
    }, ms);
  }

  rememberEcho(text) {
    const key = oneLine(text, MAX_EVENT_TEXT);
    if (!key) return;
    this.echoes.push({ key, at: this.monotonic() });
    if (this.echoes.length > ECHO_KEEP) this.echoes.shift();
  }

  // --- Scene action and button -------------------------------------------------

  async sceneSend(fields = {}) {
    try {
      await this.send(fields.text, SCENE_DEADLINE);
    } catch (err) {
      // The scene log shows the message; the scene goes on.
      throw new Error(err instanceof SendFailure ? err.message : 'Nothing sent', { cause: err });
    }
    return undefined;
  }

  async testMessage(fields = {}) {
    // The Gladys Plus state as last read (connection, onWebhookUpdated): no
    // extra request before the message, which must fit the button's delay.
    const inbound = T.inbound(this.inboundState());
    const text = typeof fields.text === 'string' && fields.text.trim() ? fields.text : T.testText;
    let result;
    try {
      await this.send(text, TEST_DEADLINE);
      result = T.testSent;
    } catch (err) {
      if (err?.failure?.kind === 'blocked') result = T.blocker(err.failure.reason);
      else if (err?.failure?.fingerprint && err.failure.reason === CODES.CERTIFICATE) {
        result = T.certificate(err.failure.fingerprint);
      } else if (err?.failure?.fingerprint && err.failure.reason === CODES.CERTIFICATE_TYPED) {
        result = T.certificateTyped(err.failure.fingerprint);
      } else if (err instanceof SendFailure) result = err.text;
      else result = T.failure({ kind: 'not_sent', reason: 'unreachable' });
    }
    this.publishStatus();
    return T.join(result, inbound);
  }

  // --- Chat -> Gladys ----------------------------------------------------------

  warn(message) {
    const mono = this.monotonic();
    if (this.lastWarn !== undefined && mono - this.lastWarn < WARN_EVERY) return;
    this.lastWarn = mono;
    this.logger.warn(message);
  }

  /** A request relayed by Gladys Plus. Never answers anything (fire_and_forget). */
  async handleWebhook(request) {
    if (this.closed) return undefined;
    const mono = this.monotonic();
    this.inboundTimes = this.inboundTimes.filter((t) => mono - t < 60_000);
    if (this.inboundTimes.length >= INBOUND_PER_MINUTE) {
      this.warn(`Chat request ignored: more than ${INBOUND_PER_MINUTE} a minute`);
      return undefined;
    }
    this.inboundTimes.push(mono);
    if (!this.configRead) {
      this.warn('Chat request ignored: configuration not read yet');
      return undefined;
    }
    const result = inboundEvent(request, {
      tokens: this.config.tokens ?? [],
      wallNow: this.now(),
      maxSkew: INBOUND_MAX_SKEW,
    });
    if (!result.ok) {
      this.warn(`Chat request ignored: ${result.reason}`);
      return undefined;
    }
    if (result.postId !== null) {
      if (this.seenPosts.includes(result.postId)) return undefined;
      this.seenPosts.push(result.postId);
      if (this.seenPosts.length > SEEN_POSTS) this.seenPosts.shift();
    }
    this.echoes = this.echoes.filter((e) => mono - e.at < ECHO_WINDOW);
    if (this.echoes.some((e) => e.key === result.text)) {
      this.warn('Chat request ignored: echo of a message sent by Gladys');
      return undefined;
    }
    try {
      await this.gladys.publishSceneEvent(SCENE_TRIGGERS.COMMAND, result.data);
      this.logger.info('Chat command relayed to the scenes');
    } catch (err) {
      this.logger.warn(`Scene event refused (${err?.status ?? 'error'})`);
    }
    return undefined;
  }
}
