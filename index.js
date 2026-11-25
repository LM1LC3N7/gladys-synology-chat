// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js), every handler registered
// BEFORE connect(); the work is in the ChatApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { ChatApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new ChatApp({ gladys });
registerHandlers(gladys, app, logger);

logger.info('Starting the Synology Chat integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'error'})`);
  process.exit(1);
});
