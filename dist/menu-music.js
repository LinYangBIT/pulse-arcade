import { RhythmAudio, TRACKS } from './audio.js';

// One quiet music loop for the lobby. Preview/game/hidden states own the audio
// focus; pending renders may never steal it back after a transition.
export class MenuMusic {
  constructor({ createAudio = () => new RhythmAudio(), onState = () => {} } = {}) {
    this.createAudio = createAudio;
    this.onState = onState;
    this.audio = null;
    this.enabled = true;
    this.volume = .65;
    this.blocked = false;
    this.version = 0;
    this.pending = null;
    this.disposed = false;
  }
  get wanted() { return !this.disposed && this.enabled && this.volume > 0 && !this.blocked; }
  get status() { return this.audio?.status || { contextState: 'uninitialized', playing: false }; }
  configure({ enabled, volume, blocked }) {
    this.enabled = enabled;
    this.volume = volume;
    this.blocked = blocked;
    this.audio?.setVolume(volume * .3);
    if (!this.wanted) this.stop();
    else void this.start();
  }
  start() {
    if (!this.wanted) return Promise.resolve();
    this.audio ||= this.createAudio();
    const audio = this.audio;
    audio.setVolume(this.volume * .3);
    audio.setSfxVolume(0);
    // Always retry resume inside a real gesture, even if autoplay's first
    // resume Promise is still pending. Do not queue multiple music sources.
    const unlocked = audio.unlock();
    if (this.pending || audio.playing) {
      return unlocked.then(() => this.onState()).catch(() => this.onState());
    }
    const version = this.version;
    const current = () => version === this.version && this.wanted;
    const pending = (async () => {
      await unlocked;
      if (!current()) return;
      if (!audio.buffer) await audio.load(TRACKS[1]);
      if (!current()) return;
      audio.play(2.4, 0, { loop: true });
    })().catch(() => {
      // Autoplay restrictions are retried by the next genuine gesture.
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
      this.onState();
    });
    this.pending = pending;
    return pending;
  }
  stop() {
    ++this.version;
    this.pending = null;
    this.audio?.pause();
    this.onState();
  }
  destroy() {
    this.disposed = true;
    this.stop();
    return this.audio?.destroy();
  }
}
