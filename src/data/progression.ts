/** Upgrade paths, shelter numbers and general balance constants. */
import { config } from '../config.js';

export type Cost = Record<string, number>;

export interface UpgradeDef {
  max: number;
  /** cost to go from `level` to `level + 1` */
  cost: (level: number) => Cost;
  desc: string;
}

export const UPGRADES: Record<string, UpgradeDef> = {
  shelter: { max: 5, desc: 'More shelter HP, better storm resistance, bigger bag.', cost: (l) => ({ wood: 8 * l, stone: 8 * l, cloth: 3 * l, ...(l >= 2 ? { iron_ingot: l } : {}) }) },
  door: { max: 5, desc: 'Reinforced door: raiders need more firepower to break in.', cost: (l) => ({ iron_ingot: 3 * l, scrap: 10 * l }) },
  vault: { max: 5, desc: 'Vault capacity. Vault items are safe from raids.', cost: (l) => ({ iron_ingot: 2 * l, scrap: 15 * l, circuit: l >= 3 ? 1 : 0 }) },
  power_bank: { max: 3, desc: 'Power storage (50 per level).', cost: (l) => ({ battery: 2 * l, circuit: 1, scrap: 10 * l }) },
  turret: { max: 3, desc: 'All turrets: +4 damage and +20 HP per level.', cost: (l) => ({ iron_ingot: 4 * l, circuit: 2 * l, wire: 4 * l }) },
  robot: { max: 3, desc: 'Companion: bigger bag, better scavenging, tougher defense.', cost: (l) => ({ circuit: 2 * l, battery: 2 * l, iron_ingot: 3 * l }) },
};

export const VAULT_CAPACITY = [0, 30, 60, 100, 150, 220];
export const shelterMaxHp = (lvl: number) => 100 + 50 * (lvl - 1);
export const doorMaxHp = (lvl: number) => 60 * lvl;
export const powerCapacity = (lvl: number) => 50 * lvl;
export const bagCapacity = (playerLevel: number, shelterLevel: number) => 25 + 2 * shelterLevel + Math.floor(playerLevel / 2);
export const robotBag = (lvl: number) => [0, 12, 18, 25][lvl] ?? 12;
export const turretDamage = (lvl: number) => 8 + 4 * lvl; // base turret level 1 => 12
export const turretHp = (lvl: number) => 20 + 20 * lvl;

/** New scavengers start with FULL bars and nothing else: no shelter, no buildings, no items. */
export const PLAYER = {
  baseMaxHp: 100,
  maxBar: 100,
  startEnergy: 100,
  startFood: 100,
  startWater: 100,
};
/** Basic shelter, built from what you can gather by hand and with stone tools. */
export const SHELTER_BUILD_COST: Cost = { wood: 12, stone: 10, cloth: 6 };
export const maxHpFor = (level: number) => PLAYER.baseMaxHp + 5 * (level - 1);
export const xpForNext = (level: number) => Math.floor(100 * Math.pow(level, 1.5));

export interface MissionLength {
  id: 'quick' | 'standard' | 'deep';
  /** in config.missionUnit: seconds (test mode) or minutes */
  duration: number;
  energy: number;
  food: number;
  water: number;
  rolls: number;
  encounters: number;
  xp: number;
}
export const MISSION_LENGTHS: Record<string, MissionLength> = {
  quick: { id: 'quick', duration: 5, energy: 10, food: 6, water: 8, rolls: 3, encounters: 1, xp: 15 },
  standard: { id: 'standard', duration: 15, energy: 20, food: 12, water: 15, rolls: 6, encounters: 2, xp: 40 },
  deep: { id: 'deep', duration: 30, energy: 35, food: 20, water: 25, rolls: 10, encounters: 3, xp: 80 },
};

export const MIN = 60_000;

export const missionMs = (l: MissionLength) => l.duration * config.missionUnitMs;
export const missionLabel = (l: MissionLength) => `${l.duration} ${config.missionUnit === 'seconds' ? 'sec' : 'min'}`;
/** Human-friendly remaining time: seconds when short, minutes otherwise. */
export const fmtLeft = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.ceil(ms / 1000))} sec` : `${Math.ceil(ms / MIN)} min`);
