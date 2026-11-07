// Original, locally synthesized mini tracks. No recordings or remote assets.
// Chart and audio events share this exact musical clock.
const LEAD_IN = 2.4;
const TAIL = 2.1;
const SAMPLE_RATE = 32000;
const bufferCache = new Map();
const loopBufferCache = new WeakMap();
const FADE_IN = 0.025;
const FADE_OUT = 0.025;
const MAX_MUSIC_SOURCES = 3;
const MAX_SFX_SOURCES = 8;

export const TRACKS = Object.freeze([
  { id: 'neon-circuit', title: 'Neon Circuit', subtitle: '午夜城市的电流', bpm: 128, beats: 64, genre: 'SYNTHWAVE', accent: '#c6fa58', color2: '#ec4899', seed: 1731, difficulty: [2, 5, 8], root: 45, voice: 'sawtooth', character: 'synth' },
  { id: 'blue-hour', title: 'Blue Hour', subtitle: '天色未暗，节拍微醺', bpm: 104, beats: 64, genre: 'LO-FI HOUSE', accent: '#60a5fa', color2: '#22d3ee', seed: 2847, difficulty: [1, 3, 6], root: 50, voice: 'sine', character: 'lofi' },
  { id: 'pixel-bloom', title: 'Pixel Bloom', subtitle: '在像素花园里升级', bpm: 144, beats: 80, genre: 'CHIPTUNE', accent: '#f472b6', color2: '#fb923c', seed: 3961, difficulty: [3, 6, 9], root: 48, voice: 'square', character: 'chip' },
  { id: 'solar-drift', title: 'Solar Drift', subtitle: '驶向金色的地平线', bpm: 118, beats: 64, genre: 'FUTURE FUNK', accent: '#fbbf24', color2: '#fb7185', seed: 4073, difficulty: [2, 4, 7], root: 43, voice: 'triangle', character: 'funk' },
  { id: 'afterglow', title: 'Afterglow', subtitle: '让余温继续发光', bpm: 112, beats: 64, genre: 'DREAM POP', accent: '#bda7ff', color2: '#2dd4bf', seed: 5189, difficulty: [1, 4, 7], root: 45, voice: 'triangle', character: 'dream' },
  { id: 'terminal-velocity', title: 'Terminal Velocity', subtitle: '突破最后一道音障', bpm: 156, beats: 80, genre: 'DRUM & BASS', accent: '#dce8d3', color2: '#f97316', seed: 6203, difficulty: [4, 7, 10], root: 41, voice: 'sawtooth', character: 'dnb' },
].map(track => Object.freeze({
  ...track,
  difficulty: Object.freeze(track.difficulty),
  duration: LEAD_IN + track.beats * 60 / track.bpm + TAIL,
})));

function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function frequency(midi) { return 440 * 2 ** ((midi - 69) / 12); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function beatSeconds(track) { return 60 / track.bpm; }
function eventTime(track, step) { return LEAD_IN + step * beatSeconds(track) / 4; }

function loopBuffer(context, buffer, loopStart, loopEnd) {
  if (loopBufferCache.has(buffer)) return loopBufferCache.get(buffer);
  const result = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const start = Math.round(loopStart * buffer.sampleRate);
  const end = Math.min(buffer.length, Math.ceil(loopEnd * buffer.sampleRate));
  const fade = Math.min(Math.round(buffer.sampleRate * 0.006), Math.floor((end - start) / 2));
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = result.getChannelData(channel);
    data.set(buffer.getChannelData(channel));
    // The gameplay buffer retains its original attacks and ending. Only the
    // menu loop gets a six-millisecond seam envelope, without moving any beat.
    for (let i = 0; i < fade; i++) {
      const amount = Math.sin(i / Math.max(1, fade - 1) * Math.PI / 2);
      data[start + i] *= amount;
      data[end - 1 - i] *= amount;
    }
    if (end < data.length) data[end] = 0;
  }
  loopBufferCache.set(buffer, result);
  return result;
}

// Three density layers use the same rhythm in every game mode. Every chart
// event is accompanied by a musical attack in the rendered backing track.
function rhythmLayer(track, step) {
  const barStep = step % 16;
  const bar = Math.floor(step / 16);
  if (barStep % 4 === 0) return 0;
  if (barStep % 4 === 2) {
    if (track.character === 'lofi' || track.character === 'dream') {
      return [2, 10, 14].includes(barStep) ? 1 : 2;
    }
    return 1;
  }
  if ((barStep === 7 || barStep === 15) && bar % 2 === 1) return 2;
  if (track.character === 'dnb' && [3, 11].includes(barStep)) return 2;
  if (track.character === 'chip' && bar % 4 === 3 && [1, 5, 9, 13].includes(barStep)) return 2;
  return 3;
}

export function createChart(track, mode = 'keys', difficulty = 'normal') {
  if (!track || !Number.isFinite(track.bpm) || !Number.isFinite(track.beats)) {
    throw new TypeError('A valid track is required to create a chart.');
  }
  if (!['keys', 'drum', 'orbit'].includes(mode)) throw new RangeError(`Unknown game mode: ${mode}`);
  const density = { easy: 0, normal: 1, hard: 2 }[difficulty];
  if (density === undefined) throw new RangeError(`Unknown difficulty: ${difficulty}`);
  const random = randomFrom(track.seed + (mode === 'drum' ? 91 : mode === 'orbit' ? 173 : 0));
  const notes = [];
  let previousLane = -1;
  for (let step = 0; step < track.beats * 4; step++) {
    const layer = rhythmLayer(track, step);
    if (layer > density) continue;
    // Breathing room at the end of each two-bar phrase on beginner charts.
    if (density === 0 && step % 32 === 28) continue;
    const time = eventTime(track, step);
    if (time > track.duration - 1) continue;
    let lane = 0;
    if (mode === 'keys') {
      lane = Math.floor(random() * 4);
      if (lane === previousLane) lane = (lane + (step % 3) + 1) % 4;
    } else if (mode === 'drum') {
      // Downbeats are warm kick hits; backbeats/offbeats are bright rim hits.
      lane = step % 8 === 4 || step % 4 !== 0 ? 1 : 0;
    }
    notes.push({ id: `${mode}-${difficulty}-${step}`, time, lane, kind: 'tap', duration: 0 });
    previousLane = lane;
  }
  return notes;
}

function envelope(context, destination, time, duration, level, attack = 0.005, release = 0.08) {
  const gain = context.createGain();
  const end = time + Math.max(0.025, duration);
  const peak = Math.max(0.00001, level);
  gain.gain.setValueAtTime(0.00001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + Math.min(attack, duration / 3));
  gain.gain.setValueAtTime(peak * 0.76, Math.max(time + attack, end - release));
  gain.gain.exponentialRampToValueAtTime(0.00001, end);
  gain.connect(destination);
  return { gain, end };
}

function tone(context, destination, midi, time, duration, level, type = 'triangle', options = {}) {
  const { gain, end } = envelope(context, destination, time, duration, level, options.attack ?? 0.006, options.release ?? duration * 0.7);
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency(midi), time);
  oscillator.detune.value = options.detune || 0;
  if (options.filter) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(options.filter, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(180, options.filter * 0.38), end);
    filter.Q.value = 0.7;
    oscillator.connect(filter);
    filter.connect(gain);
  } else oscillator.connect(gain);
  oscillator.start(time);
  oscillator.stop(end + 0.01);
}

function makeNoise(context, duration, seed) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const output = buffer.getChannelData(0);
  const random = randomFrom(seed);
  for (let i = 0; i < output.length; i++) output[i] = random() * 2 - 1;
  return buffer;
}

function noiseHit(context, destination, noise, time, duration, level, cutoff, type = 'highpass') {
  const { gain, end } = envelope(context, destination, time, duration, level, 0.001, duration * 0.95);
  const source = context.createBufferSource();
  source.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = cutoff;
  filter.Q.value = 0.65;
  source.connect(filter);
  filter.connect(gain);
  source.start(time);
  source.stop(end + 0.01);
}

function kick(context, destination, time, level = 0.55, character = 'synth') {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(character === 'dnb' ? 165 : 135, time);
  oscillator.frequency.exponentialRampToValueAtTime(43, time + 0.12);
  gain.gain.setValueAtTime(0.00001, time);
  gain.gain.exponentialRampToValueAtTime(level, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.00001, time + 0.27);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(time);
  oscillator.stop(time + 0.29);
}

function snare(context, destination, noise, time, level, character) {
  noiseHit(context, destination, noise, time, character === 'lofi' ? 0.13 : 0.18, level, 1500, 'highpass');
  tone(context, destination, character === 'chip' ? 53 : 50, time, 0.105, level * 0.7, 'triangle');
}

function makeReverb(context, seed) {
  const duration = 1.35;
  const impulse = context.createBuffer(2, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const random = randomFrom(seed);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      data[i] = (random() * 2 - 1) * (1 - i / data.length) ** 3;
    }
  }
  const convolver = context.createConvolver();
  convolver.buffer = impulse;
  return convolver;
}

async function renderTrack(track) {
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('This browser does not support Web Audio rendering.');
  const context = new OfflineContext(2, Math.ceil(track.duration * SAMPLE_RATE), SAMPLE_RATE);
  const beat = beatSeconds(track);
  const musicEnd = LEAD_IN + track.beats * beat;
  const master = context.createGain();
  master.gain.setValueAtTime(0.00001, 0);
  master.gain.linearRampToValueAtTime(0.72, 0.45);
  master.gain.setValueAtTime(0.72, musicEnd - beat * 0.2);
  master.gain.linearRampToValueAtTime(0.00001, track.duration - 0.05);
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -15;
  compressor.knee.value = 16;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  master.connect(compressor);
  compressor.connect(context.destination);

  const drums = context.createGain();
  drums.gain.value = track.character === 'lofi' ? 0.75 : 0.9;
  drums.connect(master);
  const melodic = context.createGain();
  melodic.gain.value = 0.75;
  melodic.connect(master);
  const ambient = context.createGain();
  ambient.gain.value = 0.55;
  ambient.connect(master);
  const reverb = makeReverb(context, track.seed + 413);
  const wet = context.createGain();
  wet.gain.value = track.character === 'dream' ? 0.29 : 0.13;
  melodic.connect(reverb);
  ambient.connect(reverb);
  reverb.connect(wet);
  wet.connect(master);

  // A quiet tempo pickup and an opening chord make the lead-in intentional.
  const noise = makeNoise(context, 0.5, track.seed);
  for (let i = 4; i >= 1; i--) {
    const at = LEAD_IN - i * beat;
    if (at >= 0.1) noiseHit(context, drums, noise, at, 0.035, 0.07, 6500);
  }
  [0, 3, 7, 10].forEach((interval, index) => {
    tone(context, ambient, track.root + 12 + interval, 0.05, LEAD_IN + 0.1, 0.027, 'sine', { attack: 0.4, release: 0.7, detune: index % 2 ? 4 : -4 });
  });

  // Each original miniature has a four-chord progression, an eight-note hook,
  // evolving orchestration and a closing cadence rather than a single loop.
  const progressions = {
    synth: [0, -5, 3, -7], lofi: [0, 5, 3, -2], chip: [0, 3, -5, -2],
    funk: [0, 5, -2, 3], dream: [0, 3, -5, -7], dnb: [0, -2, 3, -5],
  };
  const hooks = {
    synth: [0, 7, 10, 12, 7, 3, 10, 7], lofi: [7, 10, 14, 10, 5, 3, 7, 0],
    chip: [0, 12, 7, 15, 12, 7, 3, 10], funk: [7, 10, 7, 3, 0, 12, 10, 7],
    dream: [12, 7, 10, 3, 7, 14, 10, 7], dnb: [0, 7, 12, 10, 7, 3, 7, 15],
  };
  const progression = progressions[track.character];
  const hook = hooks[track.character];
  const totalBars = track.beats / 4;
  for (let bar = 0; bar < totalBars; bar++) {
    const base = track.root + progression[Math.floor(bar / 2) % 4];
    const start = LEAD_IN + bar * beat * 4;
    const isBreak = bar >= 8 && bar < 10 && track.character !== 'dnb';
    const isFinal = bar >= totalBars - 2;
    const padLevel = track.character === 'chip' ? 0.018 : 0.032;
    const chord = track.character === 'funk' || track.character === 'lofi' ? [0, 3, 7, 10, 14] : [0, 3, 7, 10];
    chord.forEach((interval, index) => {
      tone(context, ambient, base + 12 + interval, start, beat * 4.35, padLevel, track.character === 'synth' ? 'sawtooth' : 'triangle', {
        attack: track.character === 'funk' ? 0.018 : 0.15,
        release: beat * 1.2,
        filter: track.character === 'synth' ? 1300 : 2100,
        detune: index % 2 ? 5 : -5,
      });
    });

    for (let within = 0; within < 16; within++) {
      const step = bar * 16 + within;
      const time = eventTime(track, step);
      const layer = rhythmLayer(track, step);
      const downbeat = within % 4 === 0;
      const backbeat = within === 4 || within === 12;
      const velocity = isBreak ? 0.72 : 1;

      // Four-to-the-floor, swung-feeling funk placement and breakbeat patterns
      // give each song a distinct groove without moving chart attack times.
      let hasKick = downbeat;
      if (track.character === 'dnb') hasKick = [0, 6, 10].includes(within);
      if (track.character === 'lofi') hasKick = [0, 8, 10].includes(within);
      if (track.character === 'dream') hasKick = [0, 8].includes(within);
      if (track.character === 'funk') hasKick = [0, 6, 8, 14].includes(within);
      if (hasKick) kick(context, drums, time, (isBreak ? 0.33 : 0.52), track.character);
      if (backbeat) snare(context, drums, noise, time, 0.16 * velocity, track.character);
      if (within % 2 === 0 || layer === 2) {
        noiseHit(context, drums, noise, time, within === 14 ? 0.11 : 0.035, (within % 4 === 2 ? 0.082 : 0.045) * velocity, track.character === 'lofi' ? 5000 : 7200);
      }

      if (downbeat || (track.character === 'funk' && [6, 14].includes(within)) || (track.character === 'dnb' && within === 10)) {
        const bassMidi = base + (within === 12 && bar % 2 ? 7 : 0);
        tone(context, melodic, bassMidi, time, beat * (track.character === 'dream' ? 1.7 : 0.72), isBreak ? 0.065 : 0.13, track.character === 'dnb' ? 'sawtooth' : 'triangle', { filter: track.character === 'dnb' ? 700 : 1000 });
        tone(context, melodic, bassMidi - 12, time, beat * 0.8, 0.055, 'sine');
      }

      if (layer <= 2) {
        const hookIndex = (Math.floor(within / 2) + (bar % 2) * 3) % hook.length;
        let melodyMidi = base + 24 + hook[hookIndex];
        if (bar >= 4 && bar < 8) melodyMidi += 12;
        if (isFinal && within === 0) melodyMidi = track.root + 36;
        const isSoft = layer === 2 || isBreak;
        const voiceLevel = track.voice === 'square' ? 0.033 : track.voice === 'sawtooth' ? 0.037 : 0.078;
        tone(context, melodic, melodyMidi, time, beat * (track.character === 'dream' ? 0.72 : 0.42), voiceLevel * (isSoft ? 0.65 : 1), track.voice, {
          filter: track.character === 'lofi' ? 2800 : track.character === 'synth' ? 4300 : 6500,
          release: beat * 0.3,
        });
        // Sparse bell harmonics and echoes widen the sound while keeping the
        // transient on the exact time used by the chart.
        if (within % 4 === 0 && (track.character === 'dream' || track.character === 'lofi')) {
          tone(context, melodic, melodyMidi + 12, time, beat * 1.1, 0.022, 'sine');
        }
        if (layer === 0 && bar >= 4 && !isBreak) {
          tone(context, ambient, melodyMidi, time + beat * 0.75, beat * 0.5, voiceLevel * 0.18, 'sine');
        }
      }
    }
    if (bar % 4 === 3 && !isBreak) {
      noiseHit(context, drums, noise, start + beat * 3.75, 0.15, 0.07, 3200, 'bandpass');
    }
  }
  // A tonic resolving chord gives every selectable excerpt a proper ending.
  [0, 3, 7, 12].forEach(interval => {
    tone(context, ambient, track.root + 24 + interval, musicEnd, TAIL - 0.08, 0.045, 'triangle', { attack: 0.018, release: TAIL - 0.15, filter: 2400 });
  });
  return context.startRendering();
}

export class RhythmAudio {
  constructor() {
    this.context = null;
    this.track = null;
    this.buffer = null;
    this.source = null;
    this.output = null;
    this.musicGain = null;
    this.sfxGain = null;
    this._volume = 0.72;
    this._sfxVolume = 0.8;
    this._position = 0;
    this._offset = 0;
    this._scheduledAt = 0;
    this._playing = false;
    this._looping = false;
    this._loadVersion = 0;
    this._transportVersion = 0;
    this._destroyed = false;
    this._destroyPromise = null;
    this._musicSources = new Map();
    this._sfxSources = new Map();
    this._lastHits = new Map();
  }

  get duration() { return this.track?.duration || 0; }
  get playing() { return this._playing; }
  get status() {
    return {
      contextState: this._destroyed ? 'destroyed' : this.context?.state || 'uninitialized',
      playing: this._playing && this.context?.state === 'running',
      looping: this._playing && this._looping,
      musicVolume: this._volume,
      sfxVolume: this._sfxVolume,
      activeSources: this._musicSources.size + this._sfxSources.size,
    };
  }

  async unlock() {
    if (this._destroyed) throw new Error('This audio player has been destroyed.');
    if (!this.context || this.context.state === 'closed') {
      this._clearVoices();
      const AudioContextType = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextType) throw new Error('This browser does not support Web Audio.');
      this.context = new AudioContextType({ latencyHint: 'interactive' });
      this.output = this.context.createGain();
      this.output.gain.value = 1;
      this.output.connect(this.context.destination);
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = this._volume;
      this.musicGain.connect(this.output);
      this.sfxGain = this.context.createGain();
      this.sfxGain.gain.value = this._sfxVolume;
      this.sfxGain.connect(this.output);
    }
    const context = this.context;
    if (context.state !== 'running') await context.resume();
    if (this._destroyed || this.context !== context) throw new Error('This audio player has been destroyed.');
    if (context.state !== 'running') {
      const error = new Error('Audio is waiting for a user gesture.');
      error.name = 'NotAllowedError';
      throw error;
    }
    return context;
  }

  async load(track) {
    if (this._destroyed) throw new Error('This audio player has been destroyed.');
    if (!track || !Number.isFinite(track.duration)) throw new TypeError('A valid track is required.');
    const version = ++this._loadVersion;
    const key = `${track.id}:${track.seed}:${track.bpm}:${track.beats}`;
    if (!bufferCache.has(key)) {
      const rendering = renderTrack(track).catch(error => {
        bufferCache.delete(key);
        throw error;
      });
      bufferCache.set(key, rendering);
    }
    const buffer = await bufferCache.get(key);
    // Rapid song selection cannot replace the newest selection with a stale
    // render result. Rendering itself does not unlock or play any audio.
    if (!this._destroyed && version === this._loadVersion) {
      this.stop();
      this.track = track;
      this.buffer = buffer;
    }
    return buffer;
  }

  play(offset = 0, delay = 0, options = {}) {
    if (this._destroyed) throw new Error('This audio player has been destroyed.');
    if (!this.context || !this.output) throw new Error('Call unlock() before playing audio.');
    if (!this.buffer) throw new Error('Call load(track) before playing audio.');
    if (this.context.state !== 'running') {
      const error = new Error('Resume the audio context with unlock() before playing.');
      error.name = 'NotAllowedError';
      throw error;
    }
    ++this._transportVersion;
    this._stopSource();
    this._stopSfx();
    this._looping = Boolean(options?.loop);
    const loopStart = LEAD_IN;
    const loopEnd = LEAD_IN + this.track.beats * beatSeconds(this.track);
    const requestedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    this._offset = this._looping
      ? clamp(requestedOffset, loopStart, loopEnd - 0.001)
      : clamp(requestedOffset, 0, Math.max(0, this.duration - 0.001));
    this._position = this._offset;
    const startDelay = Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 0;
    this._scheduledAt = this.context.currentTime + startDelay;
    const source = this.context.createBufferSource();
    source.buffer = this._looping ? loopBuffer(this.context, this.buffer, loopStart, loopEnd) : this.buffer;
    source.loop = this._looping;
    if (this._looping) {
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;
    }
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, this._scheduledAt);
    gain.gain.linearRampToValueAtTime(1, this._scheduledAt + FADE_IN);
    source.connect(gain);
    gain.connect(this.musicGain);
    const voice = { source, gain, scheduledAt: this._scheduledAt, cleanupTimer: null };
    this._musicSources.set(source, voice);
    source.onended = () => {
      if (this.source === source) {
        this._position = this.duration;
        this._playing = false;
        this._looping = false;
        this.source = null;
      }
      this._releaseVoice(this._musicSources, voice);
    };
    this.source = source;
    this._playing = true;
    source.start(this._scheduledAt, this._offset);
    // Rapid menu changes may briefly overlap fade tails, never accumulate them.
    while (this._musicSources.size > MAX_MUSIC_SOURCES) {
      this._retireMusic(this._musicSources.values().next().value, true);
    }
    return this._offset;
  }

  now() {
    if (!this._playing || !this.context) return this._position;
    const elapsed = this.context.currentTime - this._scheduledAt;
    // Negative values are reserved for a scheduled countdown, including a
    // resumed song. When it begins, the clock resumes at the requested offset.
    if (elapsed < 0) return elapsed;
    if (this._looping && this.track) {
      const loopDuration = this.track.beats * beatSeconds(this.track);
      return LEAD_IN + ((this._offset - LEAD_IN + elapsed) % loopDuration);
    }
    return Math.min(this.duration, this._offset + elapsed);
  }

  pause() {
    ++this._transportVersion;
    this._position = this._playing && this.context.currentTime < this._scheduledAt
      ? this._offset : clamp(this.now(), 0, this.duration);
    this._stopSource();
    this._stopSfx();
    return this._position;
  }

  async resume(delay = 0) {
    const version = ++this._transportVersion;
    const position = this._position;
    const looping = this._looping;
    await this.unlock();
    // A pause, new playback, or disposal that happened while resume was pending
    // owns the transport; do not resurrect this old playback request.
    if (this._destroyed || version !== this._transportVersion) return false;
    this.play(position, delay, { loop: looping });
    return true;
  }

  _releaseVoice(collection, voice) {
    if (!voice || !collection.has(voice.source)) return;
    collection.delete(voice.source);
    clearTimeout(voice.cleanupTimer);
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  _retireMusic(voice, immediate = false) {
    if (!voice || !this._musicSources.has(voice.source)) return;
    const context = this.context;
    const time = context?.currentTime || 0;
    const fade = !immediate && context?.state === 'running' && voice.scheduledAt <= time;
    if (fade) {
      const param = voice.gain.gain;
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
      else {
        const value = param.value;
        param.cancelScheduledValues(time);
        param.setValueAtTime(value, time);
      }
      param.linearRampToValueAtTime(0, time + FADE_OUT);
      try { voice.source.stop(time + FADE_OUT); } catch { /* Source already ended. */ }
      // Also free the graph if a backgrounded context stops its audio clock
      // before the scheduled onended event can run.
      clearTimeout(voice.cleanupTimer);
      voice.cleanupTimer = setTimeout(() => this._releaseVoice(this._musicSources, voice), (FADE_OUT + 0.04) * 1000);
    } else {
      try { voice.source.stop(); } catch { /* Source already ended. */ }
      this._releaseVoice(this._musicSources, voice);
    }
  }

  _stopSfx() {
    for (const voice of [...this._sfxSources.values()]) {
      try { voice.source.stop(); } catch { /* Source already ended. */ }
      this._releaseVoice(this._sfxSources, voice);
    }
    this._lastHits.clear();
  }

  _clearVoices() {
    this._stopSfx();
    for (const voice of [...this._musicSources.values()]) this._retireMusic(voice, true);
    this.source = null;
    this._playing = false;
  }

  _stopSource() {
    const source = this.source;
    this.source = null;
    this._playing = false;
    if (source) this._retireMusic(this._musicSources.get(source));
  }

  stop() {
    ++this._transportVersion;
    this._stopSource();
    this._stopSfx();
    this._position = 0;
    this._offset = 0;
    this._looping = false;
  }

  destroy() {
    if (this._destroyed) return this._destroyPromise;
    this._destroyed = true;
    ++this._loadVersion;
    this.stop();
    const context = this.context;
    this.track = null;
    this.buffer = null;
    // Shared rendered buffers survive disposal. Closing this instance's live
    // context releases its hardware resources and any short feedback voices.
    // Callers may await disposal, but fire-and-forget cleanup is also safe.
    const finish = async () => {
      this._clearVoices();
      this.musicGain?.disconnect();
      this.sfxGain?.disconnect();
      this.output?.disconnect();
      this.musicGain = null;
      this.sfxGain = null;
      this.output = null;
      this.context = null;
      if (context && context.state !== 'closed') {
        try { await context.close(); } catch { /* Already closed externally. */ }
      }
    };
    this._destroyPromise = context?.state === 'running' && this._musicSources.size
      ? new Promise(resolve => setTimeout(resolve, (FADE_OUT + 0.01) * 1000)).then(finish)
      : finish();
    return this._destroyPromise;
  }

  setVolume(value) {
    this._volume = clamp(Number.isFinite(Number(value)) ? Number(value) : 0.72, 0, 1);
    if (this.musicGain && this.context) this.musicGain.gain.setTargetAtTime(this._volume, this.context.currentTime, 0.015);
  }

  setSfxVolume(value) {
    this._sfxVolume = clamp(Number.isFinite(Number(value)) ? Number(value) : 0.8, 0, 1);
    if (this.sfxGain && this.context) this.sfxGain.gain.setTargetAtTime(this._sfxVolume, this.context.currentTime, 0.01);
    if (this._sfxVolume === 0) this._stopSfx();
  }

  hit(lane = 0) {
    if (this._destroyed || !this.context || this.context.state !== 'running' || !this.sfxGain || this._sfxVolume === 0) return;
    lane = Number.isInteger(lane) ? Math.abs(lane) % 4 : 0;
    const time = this.context.currentTime;
    if (time - (this._lastHits.get(lane) ?? -Infinity) < 0.018) return;
    this._lastHits.set(lane, time);
    while (this._sfxSources.size >= MAX_SFX_SOURCES) {
      const oldest = this._sfxSources.values().next().value;
      try { oldest.source.stop(); } catch { /* Source already ended. */ }
      this._releaseVoice(this._sfxSources, oldest);
    }
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime([180, 330, 440, 550][Math.abs(lane) % 4], time);
    oscillator.frequency.exponentialRampToValueAtTime(75, time + 0.035);
    gain.gain.setValueAtTime(0.00001, time);
    gain.gain.exponentialRampToValueAtTime(0.055, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.00001, time + 0.045);
    oscillator.connect(gain);
    gain.connect(this.sfxGain);
    const voice = { source: oscillator, gain, cleanupTimer: null };
    this._sfxSources.set(oscillator, voice);
    oscillator.onended = () => this._releaseVoice(this._sfxSources, voice);
    oscillator.start(time);
    oscillator.stop(time + 0.05);
    voice.cleanupTimer = setTimeout(() => this._releaseVoice(this._sfxSources, voice), 120);
  }
}
