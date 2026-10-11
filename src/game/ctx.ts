import type { DB } from '../db/index.js';

/** Everything a game action needs. `now` is injectable so tests can fast-forward time. */
export interface Ctx {
  db: DB;
  now(): number;
}

/** A user-facing rule violation ("not enough scrap"). Never a bug. */
export class GameError extends Error {}
export const fail = (msg: string): never => { throw new GameError(msg); };

/** Standard shape returned by every action; Discord renders it as an embed, the web client as cards. */
export interface Result {
  title: string;
  lines: string[];
  data?: unknown;
}
export const result = (title: string, lines: string[], data?: unknown): Result => ({ title, lines, data });
