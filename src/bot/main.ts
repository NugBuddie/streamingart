import { bootstrap, startTicker } from '../runtime.js';
import { startBot } from './index.js';

const ctx = bootstrap();
startTicker(ctx);
await startBot(ctx);
