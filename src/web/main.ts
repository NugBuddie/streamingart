import { bootstrap, startTicker } from '../runtime.js';
import { startWeb } from './server.js';

const ctx = bootstrap();
startTicker(ctx);
startWeb(ctx);
