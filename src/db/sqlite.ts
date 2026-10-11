/**
 * Thin adapter over Node's built-in `node:sqlite` (Node >= 22.5, including 24).
 * Exposes the small subset of the better-sqlite3 API the game uses, so there is NO native module to compile
 * (no Visual Studio / node-gyp needed on Windows).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface RunInfo { changes: number; lastInsertRowid: number | bigint }

export class Statement {
  constructor(private s: StatementSync) {}
  run(...p: unknown[]): RunInfo { return this.s.run(...(p as any[])) as RunInfo; }
  get(...p: unknown[]): any { return this.s.get(...(p as any[])); }
  all(...p: unknown[]): any[] { return this.s.all(...(p as any[])); }
}

export class Database {
  private db: DatabaseSync;
  private depth = 0;
  constructor(file: string) { this.db = new DatabaseSync(file); }

  prepare(sql: string): Statement { return new Statement(this.db.prepare(sql)); }
  exec(sql: string): void { this.db.exec(sql); }
  pragma(p: string): void { this.db.exec(`PRAGMA ${p}`); }
  close(): void { this.db.close(); }

  /** Returns a callable that runs `fn` atomically. Nested calls become SAVEPOINTs. `.immediate()` takes the write lock up front. */
  transaction<A extends unknown[], R>(fn: (...a: A) => R) {
    const run = (mode: 'DEFERRED' | 'IMMEDIATE', args: A): R => {
      const outer = this.depth === 0;
      const sp = `sp_${this.depth}`;
      this.db.exec(outer ? `BEGIN ${mode}` : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.depth--;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.depth--;
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
    const f = ((...args: A) => run('DEFERRED', args)) as ((...a: A) => R) & { immediate: (...a: A) => R };
    f.immediate = (...args: A) => run('IMMEDIATE', args);
    return f;
  }
}
export type DB = Database;
