// Shared between tools/precompute-exposure.ts and its worker.
export interface ExpoParams {
  mapDir: string;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cell: number;
  rings: number[];
  nearRings: number; // the first nearRings rings use proximity rules (trees do not block)
  dirs: number;
  viewerRes: number;
  coverDist: number;
  coverDirs: number;
}

/** per target: sgN vgN srN vrN sgF vgF srF vrF (seen/valid x ground/roof viewers x near/far rings) */
export const COUNTS = 8;

export interface RowResult {
  j: number;
  groundZ: Float32Array;
  roofZ: Float32Array;
  flags: Uint8Array;
  coverG: Uint8Array;
  coverR: Uint8Array;
  cntG: Uint8Array; // nx * COUNTS
  cntR: Uint8Array;
}

export const F_GROUND = 1, F_WALK = 2, F_ROOF = 4, F_COVER_G = 8, F_COVER_R = 16, F_DECK = 32, F_OVERHEAD = 64;
/** walkable cell in a small component cut off from the rest by walls/cliffs (reach it with jets) */
export const F_POCKET = 128;
