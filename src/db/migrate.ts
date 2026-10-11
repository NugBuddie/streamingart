import { config } from '../config.js';
import { openDb, migrate } from './index.js';

const db = openDb(config.dbPath);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
db.close();
