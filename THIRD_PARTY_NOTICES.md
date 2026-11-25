# Third-party notices

The protocol of this integration (`src/synology.js`, `src/inbound.js`) follows the official Synology help
"Using Integration in Synology Chat" (kb.synology.com, read on 2026-11-25): the incoming webhook (a JSON
`payload` parameter in a POST), the fields of the outgoing webhooks, slash commands and bots. No code of
Synology nor of any other project is copied or ported. Synology and Synology Chat are trademarks of Synology
Inc.

The transport (`src/http.js`), the `/data` store (`src/store.js`) and the fingerprint parser come from
gladys-egauge and gladys-sunpower-pvs (Apache-2.0, same author). The test servers and clocks in `test/kit/`
come from gladys-testkit (Apache-2.0, same author).

Runtime dependency: `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
