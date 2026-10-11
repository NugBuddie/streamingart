/** Roof-planter crops. Growth 20-60 real minutes. Each crop needs 2 clean waters: at planting and mid-growth. */
export interface CropDef {
  id: string; // also the harvested item id
  seed: string;
  growMinutes: number;
  yield: [number, number];
}

export const CROPS: Record<string, CropDef> = Object.fromEntries(
  (
    [
      { id: 'potato', seed: 'seed_potato', growMinutes: 20, yield: [2, 4] },
      { id: 'carrot', seed: 'seed_carrot', growMinutes: 20, yield: [2, 4] },
      { id: 'cabbage', seed: 'seed_cabbage', growMinutes: 30, yield: [2, 3] },
      { id: 'tomato', seed: 'seed_tomato', growMinutes: 35, yield: [2, 4] },
      { id: 'corn', seed: 'seed_corn', growMinutes: 45, yield: [2, 3] },
      { id: 'pepper', seed: 'seed_pepper', growMinutes: 50, yield: [2, 3] },
      { id: 'berries', seed: 'seed_berries', growMinutes: 60, yield: [3, 5] },
    ] as CropDef[]
  ).map((c) => [c.id, c]),
);

export const MAX_PLANTERS = 6;
export const cropBySeed = (seed: string) => Object.values(CROPS).find((c) => c.seed === seed);
