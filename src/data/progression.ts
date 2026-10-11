/** Upgrade paths, shelter numbers and general balance constants. */
export type Cost = Record<string, number>;

export interface UpgradeDef {
  max: number;
  /** cost to go from `level` to `level + 1` */
  cost: (level: number) => Cost;
  desc: string;
}

export const UPGRADES: Record<string, UpgradeDef> = {
  shelter: { max: 5, desc: 'More shelter HP, better storm resistance, bigger bag.', cost: (l) => ({ scrap: 20 * l, wood: 8 * l, iron_ingot: 2 * l }) },
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

export const PLAYER = {
  baseMaxHp: 100,
  maxBar: 100,
  startEnergy: 100,
  startFood: 60,
  startWater: 60,
  startItems: { scrap: 15, wood: 6, cloth: 4, canned_food: 2, clean_water: 2 } as Cost,
};
export const maxHpFor = (level: number) => PLAYER.baseMaxHp + 5 * (level - 1);
export const xpForNext = (level: number) => Math.floor(100 * Math.pow(level, 1.5));

export interface MissionLength {
  id: 'quick' | 'standard' | 'deep';
  minutes: number;
  energy: number;
  food: number;
  water: number;
  rolls: number;
  encounters: number;
  xp: number;
}
export const MISSION_LENGTHS: Record<string, MissionLength> = {
  quick: { id: 'quick', minutes: 5, energy: 10, food: 6, water: 8, rolls: 3, encounters: 1, xp: 15 },
  standard: { id: 'standard', minutes: 15, energy: 20, food: 12, water: 15, rolls: 6, encounters: 2, xp: 40 },
  deep: { id: 'deep', minutes: 30, energy: 35, food: 20, water: 25, rolls: 10, encounters: 3, xp: 80 },
};

export const MIN = 60_000;
