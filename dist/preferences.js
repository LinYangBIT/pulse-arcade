export const DEFAULT_SETTINGS = Object.freeze({ volume: .65, sfxVolume: .7, musicEnabled: true, speed: 1, offset: 0, reducedMotion: false });
const number = (v, fallback, min, max) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
export function normalizeSettings(raw, reducedMotion = false) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    volume: number(value.volume, .65, 0, 1),
    sfxVolume: number(value.sfxVolume, .7, 0, 1),
    musicEnabled: typeof value.musicEnabled === 'boolean' ? value.musicEnabled : true,
    speed: [.8, 1, 1.3, 1.6].includes(value.speed) ? value.speed : 1,
    offset: number(value.offset, 0, -200, 200),
    reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : reducedMotion,
  };
}
