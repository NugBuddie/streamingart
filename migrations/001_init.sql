-- Void Scavengers :: initial schema (SQLite 3)
-- Conventions: ms-epoch INTEGER timestamps, JSON stored as TEXT, item ids are TEXT keys into src/data/items.ts.

-- =====================================================================
-- Singleton / config tables  (CHECK (id = 1) => exactly one row)
-- =====================================================================
CREATE TABLE economy_stats (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  loot_multiplier          REAL    NOT NULL DEFAULT 1.0,   -- global loot knob
  vc_drop_rate             REAL    NOT NULL DEFAULT 0.03,  -- per mission, scaled by danger
  vc_daily_mission_cap     INTEGER NOT NULL DEFAULT 40,    -- max VC a player can mint from missions per 24h
  vc_value                 REAL    NOT NULL DEFAULT 10,    -- 1 Void Coin == this many "value" units
  merchant_scam_rate       REAL    NOT NULL DEFAULT 0.25,
  crew_base_size           INTEGER NOT NULL DEFAULT 5,
  crew_max_size            INTEGER NOT NULL DEFAULT 10,
  crew_expand_base_cost    INTEGER NOT NULL DEFAULT 40,    -- cost of slot 6; +step for each further slot
  crew_expand_step_cost    INTEGER NOT NULL DEFAULT 20,
  raid_energy_cost         INTEGER NOT NULL DEFAULT 15,
  raid_shield_minutes      INTEGER NOT NULL DEFAULT 60,    -- shield granted to a raided shelter
  raid_cooldown_minutes    INTEGER NOT NULL DEFAULT 360,   -- same attacker -> same target
  newbie_protect_minutes   INTEGER NOT NULL DEFAULT 180,
  energy_regen_minutes     INTEGER NOT NULL DEFAULT 3,     -- minutes per +1 energy
  total_vc_minted          INTEGER NOT NULL DEFAULT 0,
  total_vc_burned          INTEGER NOT NULL DEFAULT 0,
  updated_at               INTEGER NOT NULL DEFAULT 0
);
INSERT INTO economy_stats (id) VALUES (1);

CREATE TABLE world_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  storm_interval_minutes   INTEGER NOT NULL DEFAULT 240,
  merchant_slot_minutes    INTEGER NOT NULL DEFAULT 60,    -- merchant roams on this cadence
  merchant_city_rate       REAL    NOT NULL DEFAULT 1.0,   -- multiplier on city.merchant_chance
  merchant_shelter_rate    REAL    NOT NULL DEFAULT 0.04,  -- per player per slot
  merchant_stay_minutes    INTEGER NOT NULL DEFAULT 45,
  monster_tick_minutes     INTEGER NOT NULL DEFAULT 30,
  monster_attack_rate      REAL    NOT NULL DEFAULT 1.0,   -- multiplier on city.monster_rate*0.5
  max_catchup_slots        INTEGER NOT NULL DEFAULT 4,     -- cap on slots replayed after downtime
  last_tick_at             INTEGER NOT NULL DEFAULT 0
);
INSERT INTO world_state (id) VALUES (1);

-- One cursor per background "watcher" (storm / monster / merchant). Slots <= cursor are DONE.
CREATE TABLE watcher_cursors (
  name       TEXT PRIMARY KEY,
  cursor     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Global, idempotent world events (storms). event_key is UNIQUE => a storm can never apply twice.
CREATE TABLE world_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key  TEXT    NOT NULL UNIQUE,         -- e.g. 'storm:123456'
  kind       TEXT    NOT NULL,
  slot       INTEGER NOT NULL,
  payload    TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_world_events_kind_slot ON world_events (kind, slot);

-- =====================================================================
-- World
-- =====================================================================
CREATE TABLE cities (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  region          TEXT NOT NULL,
  archetype       TEXT NOT NULL,
  danger          INTEGER NOT NULL CHECK (danger BETWEEN 1 AND 5),
  radiation       REAL NOT NULL DEFAULT 0,
  storm_factor    REAL NOT NULL DEFAULT 1,
  bandit_chance   REAL NOT NULL,
  monster_rate    REAL NOT NULL,
  merchant_chance REAL NOT NULL
);
CREATE INDEX idx_cities_region ON cities (region);

-- =====================================================================
-- Players & ownership
-- =====================================================================
CREATE TABLE players (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id         TEXT UNIQUE,                       -- NULL for web-only dev accounts
  name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city_id            TEXT NOT NULL REFERENCES cities(id),
  home_city_id       TEXT NOT NULL REFERENCES cities(id),
  level              INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp                 INTEGER NOT NULL DEFAULT 0,
  hp                 INTEGER NOT NULL CHECK (hp >= 0),
  max_hp             INTEGER NOT NULL,
  energy             INTEGER NOT NULL CHECK (energy >= 0),
  max_energy         INTEGER NOT NULL DEFAULT 100,
  food               INTEGER NOT NULL CHECK (food >= 0),
  max_food           INTEGER NOT NULL DEFAULT 100,
  water              INTEGER NOT NULL CHECK (water >= 0),
  max_water          INTEGER NOT NULL DEFAULT 100,
  void_coins         INTEGER NOT NULL DEFAULT 0 CHECK (void_coins >= 0),  -- cache; ledger is source of truth
  karma              INTEGER NOT NULL DEFAULT 0,        -- <= -3 => criminal (hostile; can ambush)
  raid_shield_until  INTEGER NOT NULL DEFAULT 0,
  protected_until    INTEGER NOT NULL DEFAULT 0,        -- new player protection
  last_energy_at     INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL
);
CREATE INDEX idx_players_city ON players (city_id);
CREATE INDEX idx_players_home_city ON players (home_city_id);

-- Stackable items carried (NOT protected from raids).
CREATE TABLE player_inventory (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id   TEXT    NOT NULL,
  quantity  INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (player_id, item_id)
);

-- Weapons & tools: individual instances with durability.
CREATE TABLE player_equipment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id        TEXT    NOT NULL,
  durability     INTEGER NOT NULL CHECK (durability >= 0),
  max_durability INTEGER NOT NULL,
  equipped       INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  location       TEXT    NOT NULL DEFAULT 'bag' CHECK (location IN ('bag', 'vault')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_player_equipment_player ON player_equipment (player_id, location);

-- Vault: safe from raids, limited capacity (see shelters.vault_level).
CREATE TABLE vault_contents (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id   TEXT    NOT NULL,
  quantity  INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (player_id, item_id)
);

-- =====================================================================
-- Shelter
-- =====================================================================
CREATE TABLE shelters (
  player_id    INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  city_id      TEXT    NOT NULL REFERENCES cities(id),
  level        INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  hp           INTEGER NOT NULL CHECK (hp >= 0),
  max_hp       INTEGER NOT NULL,
  door_level   INTEGER NOT NULL DEFAULT 1 CHECK (door_level BETWEEN 1 AND 5),
  door_hp      INTEGER NOT NULL CHECK (door_hp >= 0),
  vault_level  INTEGER NOT NULL DEFAULT 1 CHECK (vault_level BETWEEN 1 AND 5),
  power_charge INTEGER NOT NULL DEFAULT 0 CHECK (power_charge >= 0),
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_shelters_city ON shelters (city_id);

-- Stations, turrets, traps, planters. Composite PK like land_buildings in the reference design.
CREATE TABLE shelter_structures (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  structure TEXT    NOT NULL,
  level     INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  quantity  INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  PRIMARY KEY (player_id, structure)
);

CREATE TABLE planters (
  player_id         INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot              INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 6),
  crop_id           TEXT    NOT NULL,
  planted_at        INTEGER NOT NULL,
  ready_at          INTEGER NOT NULL,           -- if watered on time
  needs_water_at    INTEGER NOT NULL,           -- halfway: crop pauses until watered again
  second_watered_at INTEGER,
  PRIMARY KEY (player_id, slot)
);

CREATE TABLE robots (
  player_id      INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  level          INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  mode           TEXT    NOT NULL DEFAULT 'mission' CHECK (mode IN ('mission', 'home')),
  durability     INTEGER NOT NULL CHECK (durability >= 0),
  max_durability INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

-- =====================================================================
-- Missions
-- =====================================================================
CREATE TABLE missions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  city_id     TEXT    NOT NULL REFERENCES cities(id),
  length      TEXT    NOT NULL CHECK (length IN ('quick', 'standard', 'deep')),
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
  started_at  INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  resolved_at INTEGER,
  energy_cost INTEGER NOT NULL,
  pen_food    REAL    NOT NULL DEFAULT 0,   -- fraction of food requirement the player could not cover
  pen_water   REAL    NOT NULL DEFAULT 0,
  crew_size   INTEGER NOT NULL DEFAULT 1,
  seed        INTEGER NOT NULL              -- RNG seed => resolution is deterministic & replay-safe
);
CREATE UNIQUE INDEX ux_missions_one_active ON missions (player_id) WHERE status = 'active';
CREATE INDEX idx_missions_status_ends ON missions (status, ends_at);
CREATE INDEX idx_missions_player ON missions (player_id, started_at);

-- =====================================================================
-- Append-only logs / ledgers
-- =====================================================================
CREATE TABLE mission_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL UNIQUE REFERENCES missions(id),   -- UNIQUE => resolved at most once
  player_id  INTEGER NOT NULL REFERENCES players(id),
  city_id    TEXT    NOT NULL,
  outcome    TEXT    NOT NULL,
  loot_json  TEXT    NOT NULL,
  events_json TEXT   NOT NULL,
  hp_lost    INTEGER NOT NULL DEFAULT 0,
  vc_found   INTEGER NOT NULL DEFAULT 0,
  xp_gained  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mission_log_player_time ON mission_log (player_id, created_at);

CREATE TABLE attack_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL CHECK (kind IN ('raid', 'ambush')),
  attacker_id        INTEGER NOT NULL REFERENCES players(id),
  defender_id        INTEGER NOT NULL REFERENCES players(id),
  city_id            TEXT    NOT NULL,
  outcome            TEXT    NOT NULL CHECK (outcome IN ('success', 'failed', 'defeated')),
  turrets_destroyed  INTEGER NOT NULL DEFAULT 0,
  door_broken        INTEGER NOT NULL DEFAULT 0,
  loot_json          TEXT    NOT NULL DEFAULT '{}',
  attacker_hp_lost   INTEGER NOT NULL DEFAULT 0,
  details            TEXT    NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_attack_log_defender_time ON attack_log (defender_id, created_at);
CREATE INDEX idx_attack_log_attacker_time ON attack_log (attacker_id, created_at);

CREATE TABLE monster_attack_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key     TEXT    NOT NULL UNIQUE,   -- 'monster:<slot>:<player>' / 'mission:<id>:<n>' => idempotent
  player_id     INTEGER NOT NULL REFERENCES players(id),
  context       TEXT    NOT NULL CHECK (context IN ('mission', 'shelter')),
  city_id       TEXT    NOT NULL,
  monster_id    TEXT    NOT NULL,
  outcome       TEXT    NOT NULL,          -- killed_by_turret | killed_by_player | repelled | breached | fled | player_down
  shelter_damage INTEGER NOT NULL DEFAULT 0,
  loot_json     TEXT    NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_monster_attack_player_time ON monster_attack_log (player_id, created_at);

CREATE TABLE shelter_event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('storm', 'monster', 'raid', 'repair', 'upgrade')),
  delta_hp   INTEGER NOT NULL DEFAULT 0,
  event_key  TEXT    NOT NULL,
  details    TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (player_id, event_key)            -- a storm hits a shelter once
);
CREATE INDEX idx_shelter_event_player_time ON shelter_event_log (player_id, created_at);

CREATE TABLE craft_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    INTEGER NOT NULL REFERENCES players(id),
  recipe_id    TEXT    NOT NULL,
  quantity     INTEGER NOT NULL,
  inputs_json  TEXT    NOT NULL,
  output_json  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_craft_log_player_time ON craft_log (player_id, created_at);

CREATE TABLE upgrade_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  target     TEXT    NOT NULL,
  from_level INTEGER NOT NULL,
  to_level   INTEGER NOT NULL,
  cost_json  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_upgrade_log_player_time ON upgrade_log (player_id, created_at);

-- Append-only Void Coin ledger. idempotency_key makes every credit/debit exactly-once.
CREATE TABLE void_coin_transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id        INTEGER NOT NULL REFERENCES players(id),
  delta            INTEGER NOT NULL CHECK (delta <> 0),
  balance_after    INTEGER NOT NULL CHECK (balance_after >= 0),
  reason           TEXT    NOT NULL,        -- mission_drop | merchant_sell | merchant_buy | crew_expand | ...
  ref              TEXT,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_vc_tx_player_time ON void_coin_transactions (player_id, created_at);
CREATE INDEX idx_vc_tx_reason_time ON void_coin_transactions (reason, created_at);

-- Resource spending (item sinks): repairs, planting water, upgrades, trades. Analytics only.
CREATE TABLE player_spend_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  category   TEXT    NOT NULL,              -- craft | upgrade | repair | farm | trade | ...
  item_id    TEXT    NOT NULL,
  quantity   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_spend_log_player_time ON player_spend_log (player_id, created_at);

-- Outbox: the Discord bot DMs undelivered rows; the web client lists them.
CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  read_at      INTEGER
);
CREATE INDEX idx_notifications_player ON notifications (player_id, created_at);
CREATE INDEX idx_notifications_pending ON notifications (delivered_at, attempts);

-- =====================================================================
-- Wandering merchant
-- =====================================================================
-- A visit is deterministic per (city, slot) or (player, slot): event_key UNIQUE => created once.
CREATE TABLE merchant_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key  TEXT    NOT NULL UNIQUE,         -- 'merchant:city:<city>:<slot>' | 'merchant:shelter:<pid>:<slot>' | 'merchant:mission:<id>'
  kind       TEXT    NOT NULL CHECK (kind IN ('city', 'shelter', 'mission')),
  city_id    TEXT    REFERENCES cities(id),
  player_id  INTEGER REFERENCES players(id),  -- set for shelter/mission visits (private)
  slot       INTEGER NOT NULL,
  starts_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'expired'))
);
CREATE INDEX idx_merchant_visits_status_exp ON merchant_visits (status, expires_at);
CREATE INDEX idx_merchant_visits_city ON merchant_visits (city_id, status);

CREATE TABLE merchant_offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id      INTEGER NOT NULL REFERENCES merchant_visits(id) ON DELETE CASCADE,
  gives_item    TEXT,
  gives_qty     INTEGER NOT NULL DEFAULT 0,
  gives_vc      INTEGER NOT NULL DEFAULT 0,
  wants_item    TEXT,
  wants_qty     INTEGER NOT NULL DEFAULT 0,
  wants_vc      INTEGER NOT NULL DEFAULT 0,
  stock         INTEGER NOT NULL DEFAULT 5 CHECK (stock >= 0),
  ratio         REAL    NOT NULL,             -- value received by player / value given by player
  fairness      TEXT    NOT NULL CHECK (fairness IN ('good', 'fair', 'poor', 'scam')),
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'expired')),
  expires_at    INTEGER NOT NULL,
  CHECK ((gives_item IS NOT NULL AND gives_qty > 0) OR gives_vc > 0),
  CHECK ((wants_item IS NOT NULL AND wants_qty > 0) OR wants_vc > 0)
);
CREATE INDEX idx_merchant_offers_status_exp ON merchant_offers (status, expires_at);
CREATE INDEX idx_merchant_offers_visit ON merchant_offers (visit_id);

-- One purchase of each offer per player.
CREATE TABLE merchant_trades (
  offer_id   INTEGER NOT NULL REFERENCES merchant_offers(id),
  player_id  INTEGER NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (offer_id, player_id)
);

-- =====================================================================
-- Crews
-- =====================================================================
CREATE TABLE crews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  tag         TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(tag) BETWEEN 2 AND 5),
  owner_id    INTEGER NOT NULL REFERENCES players(id),
  max_members INTEGER NOT NULL DEFAULT 5 CHECK (max_members BETWEEN 5 AND 10),
  created_at  INTEGER NOT NULL
);

CREATE TABLE crew_members (
  crew_id   INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,  -- one crew per player
  role      TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, player_id)
);
CREATE INDEX idx_crew_members_player ON crew_members (player_id);

CREATE TABLE crew_invites (
  crew_id    INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invited_by INTEGER NOT NULL REFERENCES players(id),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, player_id)
);
CREATE INDEX idx_crew_invites_player_exp ON crew_invites (player_id, expires_at);

-- =====================================================================
-- Web access
-- =====================================================================
-- One-time codes issued by /weblogin in Discord; exchanged for a session token on the website.
CREATE TABLE web_link_codes (
  code       TEXT PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,                -- sha256 of the bearer token
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_web_sessions_exp ON web_sessions (expires_at);
