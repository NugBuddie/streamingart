import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { GameError, type Ctx } from '../game/ctx.js';
import { ACTIONS, run } from '../game/actions.js';
import { exchangeCode, issueSession, playerForToken, revokeSession } from '../game/auth.js';
import { playerByName } from '../game/store.js';
import { register } from '../game/players.js';
import { ITEMS } from '../data/items.js';
import { RECIPES } from '../data/recipes.js';
import { CITIES } from '../data/world.js';
import { CROPS } from '../data/crops.js';
import { MISSION_LENGTHS } from '../data/progression.js';
import { START_CITIES } from '../data/world.js';
import { log } from '../logger.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');

/** Tiny fixed-window limiter (per key). Enough to stop accidental hammering; put a reverse proxy in front for real abuse protection. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k); return true; }
    return ++h.n <= max;
  };
}

export function createApp(ctx: Ctx): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
  const authLimit = limiter(10, 60_000), apiLimit = limiter(120, 60_000);

  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };
  const tokenOf = (req: Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;

  // ---- public
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/catalog', (_req, res) => {
    res.json({ ok: true, items: ITEMS, recipes: RECIPES, cities: CITIES, crops: CROPS, devLogin: config.webDevLogin, missionLengths: Object.values(MISSION_LENGTHS), missionUnit: config.missionUnit === 'seconds' ? 'sec' : 'min', starters: START_CITIES });
  });

  // ---- auth
  app.post('/api/auth/exchange', wrap((req) => {
    if (!authLimit(req.ip ?? 'x')) throw new GameError('Too many attempts. Wait a minute.');
    const { token, playerId } = exchangeCode(ctx, String(req.body?.code ?? ''));
    log.info(`[web] login via Discord code → player #${playerId}`);
    return { ok: true, token, playerId };
  }));
  // Local development only: name-only login (creates a web-only scavenger on first use).
  app.post('/api/auth/dev-login', wrap((req) => {
    if (!config.webDevLogin) throw new GameError('Dev login is disabled. Use /weblogin in Discord.');
    if (!authLimit(req.ip ?? 'x')) throw new GameError('Too many attempts. Wait a minute.');
    const name = String(req.body?.name ?? '').trim();
    let p = playerByName(ctx, name);
    if (!p) { register(ctx, { name, city: req.body?.city }); p = playerByName(ctx, name)!; }
    log.info(`[web] dev login → ${p.name}`);
    return { ok: true, token: issueSession(ctx, p.id), playerId: p.id };
  }));
  app.post('/api/auth/logout', wrap((req) => { const t = tokenOf(req); if (t) revokeSession(ctx, t); return { ok: true }; }));

  // ---- game API: GET|POST /api/<group>/<action>  ==  Discord slash command equivalent
  app.all('/api/:group/:name', wrap((req) => {
    const key = `${req.params.group}/${req.params.name}`;
    const def = ACTIONS[key];
    if (!def || key === 'player/register') throw new GameError('Unknown endpoint.');
    if (req.method !== def.method) throw new GameError(`Use ${def.method} for ${key}.`);
    const pid = playerForToken(ctx, tokenOf(req));
    if (pid === undefined) { const e = new GameError('Not logged in.'); (e as any).status = 401; throw e; }
    if (!apiLimit(String(pid))) { const e = new GameError('Rate limit: slow down.'); (e as any).status = 429; throw e; }
    const args = { ...(def.method === 'GET' ? req.query : req.body) } as Record<string, unknown>;
    delete args.discordId; delete args.playerId; // clients may only target players by name
    const r = run(ctx, key, pid, args, 'web');
    return { ok: true, ...r };
  }));

  app.use(express.static(PUBLIC_DIR));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GameError) return res.status(err.status ?? 400).json({ ok: false, error: err.message });
    log.error(`[web] ${err?.stack ?? err}`);
    res.status(500).json({ ok: false, error: 'Internal error' });
  });
  return app;
}

export function startWeb(ctx: Ctx) {
  const app = createApp(ctx);
  return app.listen(config.webPort, () => log.info(`[web] http://localhost:${config.webPort}${config.webDevLogin ? ' (dev login enabled)' : ''}`));
}
