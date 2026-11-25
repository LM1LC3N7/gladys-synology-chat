# Synology Chat for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for Synology Chat: scenes post
messages in a channel (incoming webhook of the NAS), and a message typed in the chat (outgoing webhook, slash
command or bot) starts a scene, through the Gladys Plus webhooks.

Unofficial, not affiliated with Synology. Written after the official help "Using Integration in Synology
Chat"; **never tested with a real NAS yet**.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Decisions and next steps: [TODO.md](TODO.md). Rules for
  contributors: [CLAUDE.md](CLAUDE.md).

## How it works

- Scene action "Send a Synology Chat message": a form POST (`payload={"text": …}`) to the incoming webhook URL,
  one at a time, one second apart, at most 10 waiting, each dropped when not started within 15 s. A 429 or 5xx
  pauses every send (1 min doubled up to 1 h, `Retry-After` honoured up to 6 h), kept in `/data`. A message is
  never sent twice; one sent without a readable answer is reported "sent, without confirmation".
- The certificate of the NAS is checked before a byte is written: signed by an authority for the name of the
  URL, or the SHA-256 fingerprint the user typed (self-signed). Never learned by itself.
- Scene trigger "Synology Chat command received": the Gladys Plus webhook `chat` (fire and forget) receives
  what Synology Chat posts; only a request carrying one of the tokens typed fires the event. Never a reply in
  the chat; duplicates, echoes of our own messages and floods dropped.
- No device, no polling, no cloud other than the Gladys Plus relay for the incoming direction.

## Development

```bash
npm install
npm test          # node --test, against the SDK's fake Gladys and local fake servers
npm run lint
npm run format:check
npm run mutants   # mutation check of the guards (scripts/mutants.json), one at a time
npm run cover     # regenerates cover.png
```

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
