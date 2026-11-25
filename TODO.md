# TODO — Synology Chat v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 22 and 24,
  Docker build), `npm audit --omit=dev`, `npm run mutants` (one at a time,
  under `memcap`), the store validator, then README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — send and receive** (2026-11-25): scene action "Send a
      Synology Chat message" (incoming webhook, queue, gap, deadline, pause
      after 429/5xx kept in /data), certificate checked before any byte
      (authority, or typed SHA-256 fingerprint), scene trigger "Synology Chat
      command received" through the Gladys Plus webhook (token checked, never
      a reply, duplicates, echoes and floods dropped), test button, docs en/fr.
      Tested against fake servers on the loopback interface only, never with a
      real NAS.
- [ ] **Milestone 2 — real NAS** (testers with DSM 7 and Synology Chat). To check first:
  - the content type and the exact fields of an outgoing webhook, a slash
    command and a bot (the help lists the fields, not the encoding: a form is
    assumed, JSON is read too);
  - the unit of `timestamp` (ms assumed, seconds accepted);
  - the error codes of `SYNO.Chat.External` (not documented): which one means a
    revoked token, and whether a rate limit exists (shown as "refused (code N)"
    for now, never taken for a refused token);
  - whether a message posted by the incoming webhook can fire an outgoing
    webhook of the same channel, and with which text: the echo guard needs
    the exact text back within a minute (60 messages remembered); otherwise
    only the limit of 20 requests a minute slows a loop (said in the docs).

## Decisions

- **Version 0.1.0** set by hand in package.json, the lock, the manifest and
  `docker_image` (`ghcr.io/lm1lc3n7/gladys-synology-chat:0.1.0`).
- **Manifest**: `type: "provider"` (no device), `categories: ["notifications"]`,
  `gladys_version: ">=5.1.0"` (scene declarations and webhooks), no
  `countries`, no `keywords`.
- **Not a communication channel** (`type: "communication"`): that type routes
  every received message to the brain, which answers in the chat; the brief
  forbids any automatic answer. Scenes only, by trigger and action.
- **Webhook `fire_and_forget`**: Gladys Plus answers an empty 200, which
  Synology Chat does not post: no reply can leave, whatever the handler does.
- **Token required** for the inbound direction (none typed: every request
  ignored); read from the body only; compared in constant time; up to 5
  (outgoing webhook, slash command, bots).
- **Certificate**: a typed fingerprint is the authority (even a certificate
  signed by an authority is refused if it differs); without one, only a
  certificate signed by an authority for the URL name. No "trust" button: the
  fingerprint shown in the status is copied by the user after checking it in
  DSM. `rejectUnauthorized: false` only in the options of each request, the
  result decided by `checkPeer` before the request is written.
- **HTTP** only with the `allow_http` option (off by default): the URL holds the token.
- **No retry of a message**: a message sent without a readable answer is
  reported "sent, without confirmation" (a retry could post it twice).
- **Pause** on 429/5xx: 1 min doubled up to 1 h, `Retry-After` up to 6 h; in
  /data (wall-clock end, ignored when further than 6 h); every path waits, the
  test button included.
- **Not kept**: the `post_id` already seen (memory only, 500), the echoes
  (memory, one minute): a restart forgets them, the 10-minute freshness window
  still applies.
- **Message length** capped at 2000 characters (the limit of Synology Chat is
  not documented); `file_url` (the NAS downloads a file) left out of v1.
- **Never awaited on the path of a message** (r1): the write of /data and
  `setConnectionStatus` (the queue and the ack never wait for them; a pause is
  held in memory first). A new URL or fingerprint lifts the pause.
- **Mutants** (`scripts/mutants.json`): every one killed. The pause check at
  enqueue (`send`) has no mutant: the same check runs in `pump` before every
  request (an equivalent mutant), kept for an immediate answer.

## Next patch

- Review minors: see `_lots/lot25/reviews/synology-chat-r2.md` (m7 test du bouton sans attente du statut, m8 pause posée sur la nouvelle cible par une réponse de l ancienne).
