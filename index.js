// Launcher for hosts that run `node index.js` (e.g. Pterodactyl/Apollo panels): runs the TypeScript sources via tsx.
import { register } from 'tsx/esm/api';

register();
await import('./src/index.ts');
