# ☢️ Void Scavengers (2999)

A multiplayer scavenger-survival game that runs as a **Discord bot** (primary) and a **browser client** (secondary) on **one shared game core and one SQLite database**.

Scavenge 50 cities, craft weapons and a shelter, farm on your roof, fight monsters/bandits/other scavengers, raid (and defend against) rival shelters, join a crew, and haggle with the Wandering Merchant for Void Coins.

---

## 1. Architecture

```
 Discord slash command ─┐                           ┌─ REST  /api/<group>/<action>  ◄─ browser (vanilla JS)
   src/bot/router.ts    │                           │   src/web/server.ts
                        ▼                           ▼
                 ┌──────────────────────────────────────────┐
                 │ src/game/actions.ts   (one action registry) │   ← the ONLY entry to game rules
                 └──────────────────────────────────────────┘
        players · missions · shelter · crafting · farming · crews · merchant · raids · world(tick)
                                   src/game/*.ts  (synchronous, transactional services)
                                           │
                       src/db  (node:sqlite, WAL, BEGIN IMMEDIATE) ── migrations/001_init.sql
                                           │
                         static content: src/data/*.ts (items, recipes, crops, 50 cities, monsters)
```

* **One rules layer.** Every action returns `{ title, lines[], data }`. Discord renders it as an embed, the web client as cards (and uses `data` for structured widgets). Rules are never duplicated.
* **Synchronous services + `BEGIN IMMEDIATE`.** Node's built-in `node:sqlite` (wrapped in `src/db/sqlite.ts`, no native add-on to compile) is synchronous, so each action is one atomic transaction (`tx()`); two processes (bot + web) can share the same DB file safely (WAL + `busy_timeout`).
* **Content in code, state in SQL.** Items/recipes/monsters/cities are TypeScript data (add one entry, no migration). Cities are upserted into the `cities` table at start so SQL can join on them. The DB stores only ids.
* **World ticker** (`src/game/world.ts`, every `TICK_SECONDS`, plus lazily on each action): storms, monster attacks on shelters, expiring merchants, resolving finished missions. It is **idempotent** (see §3), so it is safe to run in the bot process, the web process, or both.
* **Notifications outbox.** Raids/storms/monsters/finished missions are written to `notifications`; the bot DMs undelivered rows (3 attempts), the web client lists them.

## 2. Database (`migrations/001_init.sql`)

| Kind | Tables |
|---|---|
| Singletons (`CHECK (id = 1)`) | `economy_stats` (loot multiplier, VC drop rate/caps, VC value, scam rate, crew sizes/costs, raid rules, totals minted/burned), `world_state` (storm & merchant & monster cadence, catch-up cap) |
| Cursors / idempotent events | `watcher_cursors` (last processed slot per watcher), `world_events` (`event_key` UNIQUE) |
| Entities | `players`, `shelters`, `shelter_structures (player_id, structure)`, `planters (player_id, slot)`, `robots`, `player_inventory (player_id, item_id)`, `player_equipment` (instances w/ durability), `vault_contents`, `missions`, `cities`, `crews`, `crew_members`, `crew_invites`, `merchant_visits/offers/trades` |
| Append-only logs | `mission_log`, `attack_log`, `monster_attack_log`, `shelter_event_log`, `craft_log`, `upgrade_log`, `void_coin_transactions`, `player_spend_log`, `notifications` |
| Web | `web_link_codes`, `web_sessions` |

Notable constraints: partial unique index `ux_missions_one_active` (one active mission/player), `mission_log.mission_id UNIQUE`, `crew_members.player_id UNIQUE` (one crew each), `CHECK` on bars/levels/slots/crew size 5–10, `void_coin_transactions.idempotency_key UNIQUE`, `merchant_trades PK (offer_id, player_id)`, indexes on `(player_id, created_at)` for logs and `(status, expires_at)` for missions/merchant offers.

## 3. Integrity & idempotency

| Risk | Guard |
|---|---|
| Double mission payout | `UPDATE missions SET status … WHERE status='active' AND ends_at<=now` must change 1 row; `mission_log.mission_id UNIQUE`; RNG seeded from `missions.seed` ⇒ replay-identical |
| Double Void Coin credit/debit | `vcApply()` checks `idempotency_key` (e.g. `mission:42:drop`, `trade:7:3:pay`, `crew:2:expand:7`); balance can't go negative (`CHECK` + conditional UPDATE) |
| Storm hits twice | slot = `floor(now/interval)`; `world_events.event_key='storm:<slot>'`; per-shelter `UNIQUE(player_id,event_key)`; cursor + `max_catchup_slots` after downtime |
| Monster attack twice | `monster_attack_log.event_key = 'monster:<slot>:<player>'` UNIQUE, RNG seeded from that key |
| Merchant duplicated | visit rolled deterministically per `(city, slot)`; `merchant_visits.event_key` UNIQUE; offers generated only by the inserter; one purchase per `(offer, player)` |
| Race on stock/inventory | single-writer transactions; conditional `UPDATE … WHERE quantity >= ?` |

## 4. Gameplay summary (all numbers are tunable)

* **Bars:** HP, ⚡ energy (regens 1/3 min, half-speed when starving), 🍖 food, 💧 water.
* **Missions** (`quick` 5 min/10⚡, `standard` 15/20, `deep` 30/35): timed, resolved by the ticker or `/mission report`. They burn food+water; short supplies are auto-covered from safe pack items, any remaining shortfall cuts loot (up to −80 %), raises injury damage, and ≥120 % shortage makes you collapse (25 % loot). Bag size limits loot (robot adds space).
* **Encounters:** monsters (kill ⇒ meat/hide/bone…), bandits (rob you or drop loot), criminal players (karma ≤ −3) who can **ambush** you in the same city, and the merchant.
* **Combat:** best usable weapon is used automatically (bat, knife, spear, slingshot+pebbles, bow+arrows, rifle+bullets); durability wears and ammo is consumed; repair at the Repair Bench. **Ratchet**: +40 % salvage and bonus batteries/circuits.
* **Shelter:** workbench (start), repair bench, water purifier, power bank, furnace, stove, turrets (≤4, 1 power/shot), traps (≤8), planters (≤6). Upgrade shelter/door/vault/power bank/turret/robot. **Vault** items and Void Coins are raid-proof. **Storms** every 4 h (mild/strong/violent, scaled per city); repair with scrap.
* **Raids:** go to the target's home city, `/attack player`. Traps → turrets (+home robot) → door → loot ≤30 % of non-vault stacks. New-player protection (3 h), post-raid shield (1 h), per-target cooldown (6 h), karma penalty for raiding honest players.
* **Farming:** crops 20–60 min; needs clean water at planting **and** mid-growth (late watering delays harvest).
* **Water/food chain:** dirty → purifier (power) → clean water; stove turns 1–5 food crops into 20–50 food and brews tea/coffee/beer (more water than plain water).
* **Robot:** *mission* mode (+bag space, +5 %/lvl loot) or *home* mode (fights beside turrets, doubles auto-collected monster loot). Turret kills pay loot straight to your inventory.
* **Crews:** 5 → 10 members (Void-Coin expansion: 40, 60, 80, 100, 120), −3 % mission energy, +2 % loot, +5 % raid power per extra member; no friendly raids.
* **Economy:** Void Coins drop rarely on missions (capped 40/day), flow through the Wandering Merchant (cap 150/day earned), and are burned by crew expansion and merchant goods. Merchant offers carry an honest fairness label computed from item values: 🌟/✅ *Real deal*, 🟡 *Overpriced*, ⚠️ *Potential scam*.

## 5. Discord commands

`/register /status /inventory /use /equip /world /cities /players /travel` · `/mission start|report` · `/shelter view|upgrade|repair|charge|recharge` · `/defend` · `/vault view|deposit|withdraw` · `/craft list|make|repair` · `/planter list|plant|water|harvest` · `/robot view|mode|repair` · `/attack player` · `/crew create|invite|join|leave|kick|expand|info` · `/merchant view|trade` · `/voidcoins` · `/weblogin` · `/notifications`

## 6. Web client

Static SPA in `src/web/public` (no build step) over `GET|POST /api/<group>/<action>` (same names as the actions, e.g. `GET /api/player/status`, `POST /api/mission/start {"length":"quick"}`). Auth: run `/weblogin` in Discord → one-time 8-character code (10 min) → `POST /api/auth/exchange` → 30-day bearer token (only its SHA-256 is stored). For local development set `WEB_DEV_LOGIN=1` for name-only login. Discord OAuth2 can replace the code flow later by calling `issueSession()` after verifying the user (`src/game/auth.ts`).

## 7. Setup & deployment

Requires **Node.js 22.5 or newer** (Node 22, 24 and later all work; no Visual Studio / build tools needed).

```bash
npm install
cp .env.example .env        # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID (and DISCORD_GUILD_ID for instant command updates)
npm run migrate             # create/upgrade SQLite schema (also runs automatically on start)
npm run deploy-commands     # register slash commands with Discord
npm start                   # ticker + web + bot (bot skipped if no token)
# or separately:  npm run bot   |   npm run web
npm test                    # node:test suite (in-memory DB, fake clock)
npm run typecheck
```

Logging: Winston prints a live activity feed to the terminal (who did what, raids, ambushes, storms, monster attacks, finished missions, DMs) and writes JSON lines to `logs/void.log` (rotated, 5 × 5 MB). `LOG_LEVEL=debug` also shows read-only commands such as `/status`.

Environment: `LOG_LEVEL` (info), `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DB_PATH` (default `./data/void.db`), `WEB_PORT` (3000), `WEB_DEV_LOGIN` (0/1), `TICK_SECONDS` (30).

Discord setup: create an application → Bot → copy the token; invite with scopes `bot applications.commands` (no privileged intents needed). Players must allow DMs from server members to receive raid alerts.

Production notes: back up `data/void.db*` (SQLite online backup or `sqlite3 .backup`); `docker build -t void . && docker run -v void-data:/data --env-file .env -p 3000:3000 void`; put the web server behind HTTPS (Caddy/nginx) — tokens are bearer secrets. Never enable `WEB_DEV_LOGIN` on a public host. Tune the economy live: `UPDATE economy_stats SET loot_multiplier = 0.9 WHERE id = 1;` (takes effect immediately).

## 8. Extending

* **New city:** add a row to `CITY_ROWS` in `src/data/world.ts` (restart upserts it).
* **New item / recipe / crop / monster:** add one entry in `src/data/{items,recipes,crops,world}.ts`.
* **New command:** add an action in `src/game/actions.ts` (it instantly becomes a REST endpoint), then a builder in `src/bot/commands.ts` and a case in `src/bot/router.ts`.
* **Schema change:** add `migrations/002_*.sql`; they apply in order inside transactions.
