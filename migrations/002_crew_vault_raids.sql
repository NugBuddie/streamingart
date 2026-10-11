-- Crew vault, member permissions and crew raids (vs monsters, vs rival crews, vs abandoned buildings).

-- Per-member permissions granted by the leader (the owner always has both).
ALTER TABLE crew_members ADD COLUMN can_vault INTEGER NOT NULL DEFAULT 0 CHECK (can_vault IN (0, 1)); -- open vault, withdraw & reward
ALTER TABLE crew_members ADD COLUMN can_raid  INTEGER NOT NULL DEFAULT 0 CHECK (can_raid  IN (0, 1)); -- start / launch crew raids
ALTER TABLE crews ADD COLUMN raid_shield_until INTEGER NOT NULL DEFAULT 0;  -- after being raided by a rival crew

ALTER TABLE economy_stats ADD COLUMN crew_raid_min_members     INTEGER NOT NULL DEFAULT 2;
ALTER TABLE economy_stats ADD COLUMN crew_raid_max_members     INTEGER NOT NULL DEFAULT 8;
ALTER TABLE economy_stats ADD COLUMN crew_raid_recruit_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE economy_stats ADD COLUMN crew_raid_shield_minutes  INTEGER NOT NULL DEFAULT 120;
ALTER TABLE economy_stats ADD COLUMN crew_raid_cooldown_minutes INTEGER NOT NULL DEFAULT 720;  -- same crew vs same crew
ALTER TABLE economy_stats ADD COLUMN crew_newbie_protect_minutes INTEGER NOT NULL DEFAULT 1440; -- new crews can't be raided for 24h

-- Shared stash (stackable items). Only leader / permitted members can take items out; anyone in the crew can deposit.
CREATE TABLE crew_vault (
  crew_id  INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  item_id  TEXT    NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (crew_id, item_id)
);

-- Append-only audit trail of every movement in/out of the crew vault.
CREATE TABLE crew_vault_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id    INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  player_id  INTEGER REFERENCES players(id),           -- who did it (NULL = system, e.g. raid loot)
  kind       TEXT    NOT NULL CHECK (kind IN ('deposit', 'reward', 'raid_loot', 'raid_stolen')),
  item_id    TEXT    NOT NULL,
  quantity   INTEGER NOT NULL,
  target_id  INTEGER REFERENCES players(id),           -- reward recipient
  ref        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_crew_vault_log_crew_time ON crew_vault_log (crew_id, created_at);

-- A crew raid: one recruiting lobby per crew, then launched exactly once.
CREATE TABLE crew_raids (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id     INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('monster', 'building', 'crew')),
  target      TEXT    NOT NULL,                        -- monster id | building id | defending crew id
  city_id     TEXT    NOT NULL REFERENCES cities(id),
  starter_id  INTEGER NOT NULL REFERENCES players(id),
  status      TEXT    NOT NULL DEFAULT 'recruiting' CHECK (status IN ('recruiting', 'resolved', 'cancelled')),
  seed        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX ux_crew_raids_one_open ON crew_raids (crew_id) WHERE status = 'recruiting';
CREATE INDEX idx_crew_raids_status_exp ON crew_raids (status, expires_at);

-- Participants and what each one paid (so a cancelled raid can refund exactly).
CREATE TABLE crew_raid_members (
  raid_id     INTEGER NOT NULL REFERENCES crew_raids(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  energy_paid INTEGER NOT NULL,
  food_paid   INTEGER NOT NULL,
  water_paid  INTEGER NOT NULL,
  pen_food    REAL    NOT NULL DEFAULT 0,
  pen_water   REAL    NOT NULL DEFAULT 0,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (raid_id, player_id)
);
CREATE INDEX idx_crew_raid_members_player ON crew_raid_members (player_id);

CREATE TABLE crew_raid_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_id     INTEGER NOT NULL UNIQUE REFERENCES crew_raids(id),   -- UNIQUE => resolved at most once
  crew_id     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  target      TEXT    NOT NULL,
  defender_crew_id INTEGER,
  city_id     TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (outcome IN ('victory', 'defeat')),
  loot_json   TEXT    NOT NULL,
  events_json TEXT    NOT NULL,
  members_json TEXT   NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_crew_raid_log_crew_time ON crew_raid_log (crew_id, created_at);
CREATE INDEX idx_crew_raid_log_defender ON crew_raid_log (defender_crew_id, created_at);
