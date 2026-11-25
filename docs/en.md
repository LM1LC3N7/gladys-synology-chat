# Synology Chat for Gladys Assistant

Unofficial external integration, not affiliated with Synology. It does two things:

- **Gladys → chat**: your scenes post a message in a Synology Chat channel, through an _incoming webhook_ of the
  NAS;
- **chat → Gladys**: a message typed in Synology Chat (trigger word of an _outgoing webhook_, slash command or
  message to a bot) starts a Gladys scene. This direction goes through the **Gladys Plus** webhooks: without
  Gladys Plus, only sending works, and the status of the integration says so.

Written after the official Synology help "Using Integration in Synology Chat". It has **never been tested with a
real NAS**: only against a fake server that follows this help. Your feedback is welcome.

## 1. Sending messages from scenes

1. In Synology Chat, click your profile picture > **Integration** > **Incoming Webhooks** > **Create**, pick the
   channel, then copy the **Webhook URL**. It looks like
   `https://nas:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22…%22`.
2. In Gladys, on the integration page, paste it in **Incoming webhook URL**. This URL lets anyone who knows it
   post in the channel: it is kept by Gladys in its database, never shown again, sent only to your NAS, and the
   integration writes it in no log nor status.
3. Click **Send a test message**.
4. In a scene, add the action **Send a Synology Chat message** and write the text; scene variables (`{{…}}`)
   are allowed.

Sending rules:

- At most 2000 characters (beyond, the text is cut and ends with "…"); control characters are removed; links
  follow the Synology Chat syntax (`<https://example.com|click here>`).
- One message at a time, at least one second between two; at most 10 messages waiting. A message that could not
  leave within 15 seconds is dropped ("Nothing sent").
- When the NAS answers HTTP 429 or 5xx, no message is sent for 1 minute, then 2, 4… up to 1 hour when it happens
  again (longer when the NAS asks for it with `Retry-After`, 6 hours at most). This pause is kept in `/data` and
  survives a restart. A message accepted resets it.
- The integration never sends a message twice. When the NAS does not answer after receiving the request, the
  scene action fails with "Message sent, without confirmation": look at the channel before sending it again.
- A redirection of the NAS is never followed (the URL holds the token): use the address and port Synology Chat
  shows.

### Certificate of the NAS

The URL normally starts with `https://`. Before writing a single byte (the path of the request holds the token),
the integration checks the certificate the NAS shows:

- **certificate signed by an authority** (a free certificate DSM obtained for your domain name) and valid for the name of the URL:
  nothing to do, leave **Certificate fingerprint** empty;
- **self-signed certificate** (the default of a NAS reached by its IP address): the first try fails with
  "Nothing sent", and the status shows the **SHA-256 fingerprint** the NAS presented. Check it in DSM
  (**Control Panel > Security > Certificate**, certificate details), then copy it in **Certificate
  fingerprint**. From then on, only this certificate is accepted.

A fingerprint typed is the only reference: when the NAS shows another certificate (renewed, or another
machine), nothing is sent and the status shows the new fingerprint, to check then type. The integration never
learns a certificate by itself.

**Allow HTTP** (off by default) accepts an `http://` URL (port 5000): the token and the messages then cross your
network in clear.

## 2. Starting a scene from the chat (Gladys Plus)

1. Link Gladys Plus to your Gladys and paste your Open API key in the **Gladys Plus webhooks** block of the
   integration page: Gladys shows a public URL for the webhook "Synology Chat outgoing webhook".
2. In Synology Chat > **Integration**, create an **outgoing webhook** (a channel and/or trigger words), a **slash
   command** or a **bot**, with this URL as its outgoing URL.
3. Copy the **token** Synology Chat shows for this webhook (or command, or bot) in **Outgoing webhook token(s)**
   (up to 5, separated by spaces). It is kept by Gladys in its database, never shown again, never sent anywhere.
4. In a scene, pick the trigger **Synology Chat command received**.

The trigger can filter on the **command** (the message without the trigger word, spaces collapsed), the
**trigger word**, the **user name** and the **channel**. Filters are exact, case included: with the trigger
word `gladys`, the message `gladys lights off` gives the command `lights off`. Variables: whole message,
command, trigger word, user name and id, channel and its id, source (`channel` for a channel outgoing webhook,
`direct` for a slash command or a bot).

Security and limits:

- A request whose form field `token` is not one of the tokens typed is ignored; with no token typed, **every**
  request is ignored. The token is never read from the URL.
- Gladys **never** answers in the chat by itself: the webhook answers empty, and nothing is sent in reaction to
  a received message. When a scene started by a command sends a message that starts with the trigger word, that
  message, if it comes back within a minute through the outgoing webhook, is recognised and ignored (no loop).
- At most 20 requests a minute; the same message (`post_id`) is handled once while the integration runs; a
  message dated more than 10 minutes away from the clock of Gladys is ignored.
- Bot messages with buttons (interactive actions) are not read.

## Status

The integration page shows: ready to send, or what blocks (URL missing or unreadable, `http://` without the
option, invalid fingerprint, certificate to confirm with its fingerprint, pause of the NAS, last failure), then
the state of the chat commands (active, without Gladys Plus, token missing or unreadable). The last failure
clears with the first message accepted, or when the URL, the fingerprint or the HTTP option change.

## Data kept

`/data/synology-chat-state.json` only keeps the end of the pause the NAS asked for and its level. Never the URL,
a token nor a message. A file that cannot be read is never overwritten.
