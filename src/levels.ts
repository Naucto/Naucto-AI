/** A bounded tile-space platformer reference profile, not a proof about arbitrary Lua. */
export interface PlatformProfile {
  speed: number;
  jump: number;
  gravity: number;
  width: number;
  height: number;
}

export function platformReachable(solid: boolean[][], start: [number, number], goal: [number, number], profile: PlatformProfile) {
  const height = solid.length, width = solid[0]?.length ?? 0;
  if (!height || !width || solid.some(row => row.length !== width) || width > 128 || height > 64) throw new Error('Use a rectangular grid up to 128×64');
  if (Object.values(profile).some(value => !Number.isFinite(value)) || profile.speed <= 0 || profile.speed > 20 || profile.jump <= 0 || profile.jump > 30 || profile.gravity < 1 || profile.gravity > 100 || profile.width <= 0 || profile.width > 1 || profile.height <= 0 || profile.height > 2) throw new Error('Invalid movement profile');
  const clear = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x + profile.width > width || y + profile.height > height) return false;
    for (let ty = Math.floor(y); ty <= Math.floor(y + profile.height - 1e-6); ty++)
      for (let tx = Math.floor(x); tx <= Math.floor(x + profile.width - 1e-6); tx++) if (solid[ty]?.[tx]) return false;
    return true;
  };
  const supported = (x: number, y: number): boolean => clear(x, y) && !clear(x, y + 0.01);
  if (!supported(...start) || !supported(...goal)) return { reachable: false, reason: 'Start and goal must be clear, supported positions', profile: 'tile-platformer-v1' };
  const queue: [number, number][] = [start], seen = new Set([start.join(',')]);
  for (let at = 0; at < queue.length && at < 4096; at++) {
    const current = queue[at]!;
    if (Math.abs(current[0] - goal[0]) < 0.25 && Math.abs(current[1] - goal[1]) < 0.25) return { reachable: true, profile: 'tile-platformer-v1', explored: at + 1 };
    for (const direction of [-1, 0, 1]) for (const jumping of [false, true]) {
      if (!direction && !jumping) continue;
      let [x, y] = current, vy = jumping ? -profile.jump : 0;
      // Fine fixed steps avoid crossing entire tiles at the bounded velocities.
      const dt = 1 / 240;
      for (let tick = 0; tick < 960; tick++) {
        const nx = x + direction * profile.speed * dt;
        if (clear(nx, y)) x = nx;
        vy = Math.min(30, vy + profile.gravity * dt);
        const ny = y + vy * dt;
        if (clear(x, ny)) y = ny;
        else if (vy < 0) vy = 0;
        else {
          // Accept only an exact supported candidate that the solver can reproduce.
          const landingY = Math.floor(y + profile.height + 0.15) - profile.height;
          const candidateX = Math.round(x * 4) / 4;
          if (supported(candidateX, landingY)) {
            const key = `${candidateX},${landingY}`;
            if (!seen.has(key)) { seen.add(key); queue.push([candidateX, landingY]); }
          }
          if (jumping || tick > 240 || !clear(nx, y)) break;
        }
      }
    }
  }
  return { reachable: false, reason: queue.length >= 4096 ? 'Search budget exhausted (inconclusive)' : 'No path found under this bounded reference profile', profile: 'tile-platformer-v1', explored: queue.length };
}

/** Reproducible topology scaffold; caller resolves semantic roles to catalog tiles. */
export function draftLevel(width: number, height: number, seed: number, profile: 'top-down' | 'platformer') {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width > 128 || height > 64) throw new Error('Level size must be 8–128 by 8–64');
  let state = seed >>> 0 || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const grid = Array.from({ length: height }, () => Array<string>(width).fill('solid'));
  if (profile === 'top-down') {
    const stack: [number, number][] = [[1, 1]];
    grid[1]![1] = 'floor';
    while (stack.length) {
      const [x, y] = stack[stack.length - 1]!;
      const options = [[2,0],[-2,0],[0,2],[0,-2]].filter(([dx,dy]) => x + dx! > 0 && y + dy! > 0 && x + dx! < width - 1 && y + dy! < height - 1 && grid[y + dy!]![x + dx!] === 'solid');
      const next = options[Math.floor(random() * options.length)];
      if (!next) { stack.pop(); continue; }
      const [dx,dy] = next as [number,number];
      grid[y + dy / 2]![x + dx / 2] = 'floor'; grid[y + dy]![x + dx] = 'floor';
      stack.push([x + dx, y + dy]);
    }
  } else {
    for (let y = 0; y < height - 1; y++) grid[y]!.fill('empty');
    // A safe flat route remains; the scaffold's optional platforms add variation.
    for (let x = 5; x < width - 5; x += 7) {
      const y = height - 4 - Math.floor(random() * Math.min(3, height - 5));
      for (let dx = 0; dx < 3; dx++) grid[y]![x + dx] = 'solid';
    }
  }
  return { profile, seed, width, height, roles: grid, notice: 'Draft topology only. Resolve roles to confirmed catalog assets, preserve locked regions, and submit a tiles proposal. Gameplay validation needs the matching movement/collision profile.' };
}
