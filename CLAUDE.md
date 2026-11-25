# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Synology Chat: scenes post
messages through the incoming webhook of the NAS, and a message typed in the
chat (outgoing webhook, slash command, bot) starts a scene through the Gladys
Plus webhooks. A Node.js service (Node 22+, ESM, no build step) that runs in
its own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
(v0.16), its only runtime dependency (the HTTP client is `node:https`). The
protocol follows the official help "Using Integration in Synology Chat".
Decisions are recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run mutants                           # mutation run (scripts/mutants.json), under memcap
npm run cover                             # regenerates cover.png
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> ChatApp (shared with the tests)
src/app.js                        send queue, pause, certificate check, inbound events, status
src/http.js                       one POST to the NAS: certificate checked before any byte, bounded
src/synology.js                   message text, form body, answers of the NAS (pure)
src/inbound.js                    what Synology Chat posts -> scene event, token check (pure)
src/store.js                      /data/synology-chat-state.json (the pause only)
src/i18n.js                       every text the user reads (en, fr)
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: config_schema, action, webhook, scene trigger and action
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys, fake transport, local HTTPS servers (test/kit/)
scripts/mutants.mjs               mutation run of the guards
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Keys are forever.** The manifest keys users store (`config_schema`,
  the action, the webhook `chat`, the scene trigger `command_received` and its
  variables, the scene action `send_message`) are never renamed.
- **Secrets.** The incoming webhook URL (its token) and the outgoing tokens
  never go to a log, a status, an error message nor `/data`. A test checks it.
- **Never a reply.** Nothing is ever sent in reaction to a received message;
  the webhook stays `fire_and_forget`.
- **Certificate.** Never `rejectUnauthorized: false` outside the options of one
  request whose `checkPeer` decides before any byte is written.
- **Tests fail, never hang**: every wait is bounded (`within`, `drive`), and
  nothing is armed after `stop()`.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
  Never write "encrypted" about a stored value: Gladys keeps it in clear in
  its database.
- **Versions belong to the Release workflow** (Actions → Release), except the
  first one (0.1.0, set by hand). The User-Agent reads `package.json`. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
