# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-25

### Added

- Scene action "Send a Synology Chat message": posts to the incoming webhook of
  the NAS, one message a second, at most 10 waiting, paused after a 429 or 5xx
  of the NAS (kept across restarts), never sent twice.
- Certificate of the NAS checked before any byte: signed by an authority, or
  the SHA-256 fingerprint typed by the user (self-signed), shown in the status.
- Scene trigger "Synology Chat command received", through the Gladys Plus
  webhooks: outgoing webhook, slash command or bot, token checked, never a reply
  in the chat, duplicates, echoes and floods dropped.
- "Send a test message" button; documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-synology-chat/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-synology-chat/releases/tag/v0.1.1
