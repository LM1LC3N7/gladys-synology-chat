// -----------------------------------------------------------------------------
// The SDK handlers, wired to the ChatApp (index.js calls it before connect();
// the tests call it on the SDK's fake Gladys).
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS, WEBHOOKS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Gladys -> chat: the scene action.
  gladys.onSceneAction(SCENE_ACTIONS.SEND, (fields) => app.sceneSend(fields));
  // Chat -> Gladys: the webhook relayed by Gladys Plus (never answered).
  gladys.onWebhook(WEBHOOKS.CHAT, (request) => app.handleWebhook(request));
  gladys.onWebhookUpdated((info) => app.webhooksUpdated(info));
  // The button of the Configuration screen.
  gladys.onAction(ACTIONS.TEST, (fields) => app.testMessage(fields));
  // The configuration saved by the user.
  gladys.onConfigUpdated((config) => app.start(config));
  gladys.on('connected', () =>
    app.onConnected().catch((err) => logger.error(`Start failed (${err?.name ?? 'error'})`)),
  );
  gladys.handleShutdown(() => app.stop());
}
