import { createHash, randomBytes, randomInt } from 'node:crypto';
import { type Ctx, fail, result, type Result } from './ctx.js';
import { MIN } from '../data/progression.js';
import { tx } from '../db/index.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike chars

/** Called from Discord (/weblogin): one-time 8-char code valid 10 min. */
export function createLinkCode(ctx: Ctx, pid: number): Result {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  ctx.db.prepare('DELETE FROM web_link_codes WHERE player_id = ?').run(pid);
  ctx.db.prepare('INSERT INTO web_link_codes (code,player_id,expires_at) VALUES (?,?,?)').run(code, pid, ctx.now() + 10 * MIN);
  return result('Web login code', [`Your one-time code: **${code}**`, 'Enter it on the website within 10 minutes. Never share it.'], { code });
}

/** Exchange a one-time code for a 30-day bearer token (only the sha256 is stored). */
export function exchangeCode(ctx: Ctx, code: string): { token: string; playerId: number } {
  return tx(ctx.db, () => {
    const row = ctx.db.prepare('SELECT * FROM web_link_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?').get(String(code).trim().toUpperCase(), ctx.now()) as any;
    if (!row) return fail('Invalid or expired code.');
    ctx.db.prepare('UPDATE web_link_codes SET used_at = ? WHERE code = ?').run(ctx.now(), row.code);
    return { token: issueSession(ctx, row.player_id), playerId: row.player_id as number };
  });
}

export function issueSession(ctx: Ctx, pid: number): string {
  const token = randomBytes(32).toString('hex');
  ctx.db.prepare('INSERT INTO web_sessions (token_hash,player_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha(token), pid, ctx.now(), ctx.now() + 30 * 24 * 60 * MIN);
  return token;
}

export function playerForToken(ctx: Ctx, token: string | undefined): number | undefined {
  if (!token) return undefined;
  const r = ctx.db.prepare('SELECT player_id FROM web_sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), ctx.now()) as any;
  return r?.player_id;
}
export const revokeSession = (ctx: Ctx, token: string) => ctx.db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha(token));
