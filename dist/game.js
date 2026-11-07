import { createChart } from './audio.js';

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const mix = (a, b, p) => a + (b - a) * p;
const TAU = Math.PI * 2;
const COLORS = ['#59e7e1', '#8aa4ff', '#c191ff', '#ff87b5'];
const KEYS = ['D', 'F', 'J', 'K'];
const PERFECT_WINDOW = 0.07;
const GOOD_WINDOW = 0.15;
const ON_TIME_WINDOW = 0.025;
const TIME_EPSILON = 1e-7;

function rounded(ctx, x, y, w, h, r = 8) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A small, audio-clock-driven rhythm engine shared by all three play styles. */
export class RhythmGame {
  constructor({ canvas, audio, track, mode = 'keys', difficulty = 'normal', settings = {}, onUpdate, onFinish, onPause, onError }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas 2D is unavailable.');
    this.audio = audio;
    this.track = track;
    this.mode = mode;
    this.difficulty = difficulty;
    this.settings = { speed: 1, offset: 0, volume: 0.65, reducedMotion: false, ...settings };
    this.onUpdate = onUpdate || (() => {});
    this.onFinish = onFinish || (() => {});
    this.onPause = onPause || (() => {});
    this.onError = onError || (() => {});
    this.notes = createChart(track, mode, difficulty).map((note) => ({ ...note, result: null }));
    this.notes.sort((a, b) => a.time - b.time);
    this.duration = Number(track.duration) || 40;
    this.state = 'ready';
    this.elapsed = 0;
    this.resumeOffset = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfect = 0;
    this.good = 0;
    this.miss = 0;
    this.judgement = '';
    this.judgementAt = -100;
    this.judgementLane = 0;
    this.offsetMs = null;
    this.offsetDirection = null;
    this.timing = { early: 0, onTime: 0, late: 0, meanMs: 0, stdDevMs: 0, samples: 0 };
    this.timingM2 = 0;
    this.particles = [];
    this.flashes = [-100, -100, -100, -100];
    this.missCursor = 0;
    this.raf = 0;
    this.lastEmit = -Infinity;
    this.destroyed = false;
    this.operationVersion = 0;
    this.path = [{ x: 0, y: 0 }];
    const angles = [0, 0, -Math.PI / 3, 0, Math.PI / 3, Math.PI / 3, 0, -Math.PI / 3];
    for (let i = 0; i < this.notes.length + 1; i++) {
      const previous = this.path[this.path.length - 1];
      const angle = angles[i % angles.length];
      this.path.push({ x: previous.x + Math.cos(angle), y: previous.y + Math.sin(angle) });
    }
    this.keyHandler = (event) => this.handleKey(event);
    this.blurHandler = () => this.pause();
    this.visibilityHandler = () => { if (document.hidden) this.pause(); };
    this.pointerHandler = (event) => this.handlePointer(event);
    this.previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('blur', this.blurHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    canvas.addEventListener('pointerdown', this.pointerHandler);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.draw(0, null);
  }

  async start() {
    if (this.destroyed || !['ready', 'error'].includes(this.state)) return;
    this.state = 'loading';
    this.draw(0, null);
    try {
      await this.audio.unlock();
      if (this.destroyed) return;
      await this.audio.load(this.track);
      if (this.destroyed) return;
      this.audio.setVolume(this.settings.volume);
      this.duration = this.audio.duration || this.duration;
      this.state = 'running';
      this.audio.play(0, 2);
      this.resumeOffset = 0;
      this.emit(true);
      this.loop();
      if (document.hidden) this.pause();
    } catch (error) {
      if (!this.destroyed) this.state = 'error';
      throw error;
    }
  }

  pause() {
    if (this.destroyed || !['running', 'resuming'].includes(this.state)) return;
    ++this.operationVersion;
    if (this.state === 'running') {
      const current = this.audio.now();
      const position = this.audio.pause();
      this.elapsed = Math.max(0, Number.isFinite(position) ? position : current < 0 ? this.resumeOffset : current);
    }
    this.resumeOffset = this.elapsed;
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onPause(true);
    this.emit(true);
    this.draw(this.chartTime(this.elapsed), null);
  }

  async resume() {
    if (this.destroyed || this.state !== 'paused') return false;
    const operation = ++this.operationVersion;
    this.state = 'resuming';
    this.emit(true);
    try {
      // A mobile browser may suspend its AudioContext while the page is hidden.
      // Do not schedule a source or hide the pause panel until it is running.
      await this.audio.unlock();
      if (this.destroyed || operation !== this.operationVersion || this.state !== 'resuming') return false;
      if (document.hidden) { this.pause(); return false; }
      this.resumeOffset = this.elapsed;
      this.audio.play(this.elapsed, 1);
      this.state = 'running';
      this.onPause(false);
      this.emit(true);
      this.loop();
      return true;
    } catch (error) {
      if (this.destroyed || operation !== this.operationVersion || this.state !== 'resuming') return false;
      this.audio.pause();
      this.state = 'paused';
      this.onPause(true);
      this.emit(true);
      this.draw(this.chartTime(this.elapsed), null);
      this.onError(error);
      return false;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    ++this.operationVersion;
    this.state = 'destroyed';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('blur', this.blurHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.canvas.removeEventListener('pointerdown', this.pointerHandler);
    this.canvas.style.touchAction = this.previousTouchAction;
    this.audio.stop();
    this.particles.length = 0;
  }

  chartTime(time) {
    // A positive offset delays both visual arrival and the accepted input window.
    return time - Number(this.settings.offset || 0) / 1000;
  }

  handleKey(event) {
    const tag = event.target?.tagName;
    if (event.altKey || event.ctrlKey || event.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || event.target?.isContentEditable) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      if (event.repeat) return;
      if (this.state === 'paused') this.resume();
      else this.pause();
      return;
    }
    // Space/Enter must retain their normal button activation while paused.
    // During play, focused touch buttons still allow all gameplay key bindings.
    if (this.state !== 'running') return;
    let lane = -1;
    if (this.mode === 'keys') lane = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'].indexOf(event.code);
    else if (this.mode === 'drum') {
      if (['KeyF', 'KeyJ'].includes(event.code)) lane = 0;
      if (['KeyD', 'KeyK'].includes(event.code)) lane = 1;
    } else if (event.code === 'Space' || /^Key[A-Z]$/.test(event.code)) lane = 0;
    if (lane === -1) return;
    event.preventDefault();
    if (!event.repeat) this.input(lane);
  }

  handlePointer(event) {
    if (event.button > 0 || this.state !== 'running') return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * this.width;
    const y = (event.clientY - rect.top) / rect.height * this.height;
    if (x < 0 || x > this.width || y < 0 || y > this.height) return;
    let lane = 0;
    if (this.mode === 'keys') {
      const g = this.keyGeometry();
      const depth = clamp((y - g.topY) / (g.lineY - g.topY));
      const width = mix(g.topWidth, g.bottomWidth, depth);
      const left = (this.width - width) / 2;
      if (x < left || x >= left + width) return;
      lane = Math.floor((x - left) / (width / 4));
    } else if (this.mode === 'drum') lane = x < this.width / 2 ? 0 : 1;
    this.input(lane);
  }

  input(lane = 0) {
    if (this.destroyed || this.state !== 'running') return false;
    const rawTime = this.audio.now();
    if (rawTime < 0) return false;
    const time = this.chartTime(rawTime);
    lane = this.mode === 'orbit' ? 0 : Number(lane);
    if (!Number.isInteger(lane) || lane < 0 || lane >= (this.mode === 'keys' ? 4 : this.mode === 'drum' ? 2 : 1)) return false;
    this.flashes[lane] = time;
    this.processMisses(time);
    let candidate = null;
    let smallest = GOOD_WINDOW + TIME_EPSILON;
    for (let i = this.missCursor; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time > time + GOOD_WINDOW + TIME_EPSILON) break;
      if (note.result || (this.mode !== 'orbit' && note.lane !== lane)) continue;
      const delta = Math.abs(time - note.time);
      if (delta < smallest) { candidate = note; smallest = delta; }
    }
    if (!candidate) return false;
    const result = smallest <= PERFECT_WINDOW + TIME_EPSILON ? 'perfect' : 'good';
    candidate.result = result;
    this[result]++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.judgement = result.toUpperCase();
    this.judgementAt = time;
    this.judgementLane = lane;
    this.recordTiming(time - candidate.time);
    this.audio.hit?.(lane);
    this.burst(lane, time, candidate);
    this.elapsed = rawTime;
    this.emit(true);
    return true;
  }

  processMisses(time) {
    while (this.missCursor < this.notes.length) {
      const note = this.notes[this.missCursor];
      if (note.result) { this.missCursor++; continue; }
      if (time - note.time <= GOOD_WINDOW + TIME_EPSILON) break;
      note.result = 'miss';
      this.miss++;
      this.combo = 0;
      this.judgement = 'MISS';
      this.judgementAt = time;
      this.judgementLane = note.lane;
      this.offsetMs = null;
      this.offsetDirection = null;
      this.missCursor++;
    }
  }

  recordTiming(errorSeconds) {
    const milliseconds = errorSeconds * 1000;
    this.offsetMs = Math.round(milliseconds);
    const timing = this.timing;
    this.offsetDirection = errorSeconds < -ON_TIME_WINDOW - TIME_EPSILON ? 'early'
      : errorSeconds > ON_TIME_WINDOW + TIME_EPSILON ? 'late' : 'onTime';
    timing[this.offsetDirection]++;
    timing.samples++;
    // Welford's algorithm keeps signed bias separate from timing consistency.
    const delta = milliseconds - timing.meanMs;
    timing.meanMs += delta / timing.samples;
    this.timingM2 += delta * (milliseconds - timing.meanMs);
    timing.stdDevMs = Math.sqrt(Math.max(0, this.timingM2 / timing.samples));
  }

  get score() {
    return Math.round((this.perfect + this.good * 0.7) / Math.max(1, this.notes.length) * 1000000);
  }

  get accuracy() {
    const judged = this.perfect + this.good + this.miss;
    return judged ? (this.perfect + this.good * 0.7) / judged * 100 : 100;
  }

  emit(force = false) {
    const wall = performance.now();
    if (!force && wall - this.lastEmit < 65) return;
    this.lastEmit = wall;
    this.onUpdate({
      score: this.score, combo: this.combo, maxCombo: this.maxCombo,
      accuracy: this.accuracy, progress: clamp(this.elapsed / this.duration),
      judgement: this.judgement, remaining: Math.max(0, this.duration - this.elapsed),
      paused: this.state === 'paused' || this.state === 'resuming',
      offsetMs: this.offsetMs, timing: { ...this.timing },
    });
  }

  finish() {
    if (this.destroyed || this.state === 'finished') return;
    for (const note of this.notes) {
      if (!note.result) { note.result = 'miss'; this.miss++; }
    }
    this.state = 'finished';
    this.elapsed = this.duration;
    this.audio.stop();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit(true);
    const accuracy = this.accuracy;
    const grade = accuracy >= 100 ? 'SS' : accuracy >= 97 ? 'S' : accuracy >= 90 ? 'A' : accuracy >= 80 ? 'B' : accuracy >= 70 ? 'C' : 'D';
    this.onFinish({
      score: this.score, maxCombo: this.maxCombo, accuracy,
      perfect: this.perfect, good: this.good, miss: this.miss,
      total: this.notes.length, grade, mode: this.mode,
      trackId: this.track.id, difficulty: this.difficulty,
      timing: { ...this.timing },
    });
  }

  loop() {
    this.raf = 0;
    if (this.destroyed || this.state !== 'running') return;
    let countdown = null;
    if (this.state === 'running') {
      const raw = this.audio.now();
      countdown = raw < 0 ? Math.ceil(-raw) : null;
      this.elapsed = raw < 0 ? this.resumeOffset : Math.max(0, raw);
      if (raw >= 0) {
        this.processMisses(this.chartTime(raw));
        if (raw >= this.duration) {
          this.draw(this.chartTime(this.duration), null);
          this.finish();
          return;
        }
      }
      this.emit();
    }
    if (this.destroyed || this.state !== 'running') return;
    this.draw(this.chartTime(this.elapsed), countdown);
    if (!this.destroyed && this.state === 'running') this.raf = requestAnimationFrame(() => this.loop());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || this.canvas.clientWidth || 960);
    this.height = Math.max(1, rect.height || this.canvas.clientHeight || 520);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pixelWidth = Math.round(this.width * this.dpr);
    const pixelHeight = Math.round(this.height * this.dpr);
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.state !== 'running') this.draw(this.chartTime(this.elapsed), null);
  }

  text(label, x, y, size = 12, color = '#9ba4b9', align = 'center', weight = 500) {
    const c = this.ctx;
    c.font = `${weight} ${size}px "Inter", "PingFang SC", system-ui, sans-serif`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(label, x, y);
  }

  draw(time, countdown) {
    if (this.destroyed || !this.width) return;
    const c = this.ctx;
    const w = this.width, h = this.height;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.shadowBlur = 0;
    c.fillStyle = '#080d16';
    c.fillRect(0, 0, w, h);
    const glow = c.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, Math.max(w, h) * 0.6);
    glow.addColorStop(0, this.mode === 'drum' ? '#241523' : this.mode === 'orbit' ? '#162033' : '#111b29');
    glow.addColorStop(1, '#080d16');
    c.fillStyle = glow;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#ffffff04';
    c.lineWidth = 1;
    const shift = this.settings.reducedMotion ? 0 : (Math.max(time, 0) * 6) % 48;
    for (let x = w % 48; x < w; x += 48) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = shift; y < h; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    if (this.mode === 'drum') this.drawDrum(time);
    else if (this.mode === 'orbit') this.drawOrbit(time);
    else this.drawKeys(time);
    this.drawParticles(time);
    this.drawJudgement(time);
    if (countdown !== null) {
      c.fillStyle = '#070c1680'; c.fillRect(0, 0, w, h);
      this.text(String(countdown), w / 2, h * 0.43, Math.min(86, w * 0.15), '#e7fffc', 'center', 750);
      this.text(this.resumeOffset > 0 ? '准备继续' : '跟上节拍', w / 2, h * 0.43 + 70, 14, '#b4c1d3');
    }
    if (this.state === 'loading') {
      c.fillStyle = '#070c16c0'; c.fillRect(0, 0, w, h);
      this.text('正在准备音乐…', w / 2, h / 2, 17, '#dbe6f5');
    }
  }

  keyGeometry() {
    const w = this.width, h = this.height;
    const bottomWidth = Math.min(w * 0.78, 600);
    return { topY: h * 0.09, lineY: h - Math.max(46, Math.min(78, h * 0.17)), topWidth: bottomWidth * 0.64, bottomWidth, bottomLeft: (w - bottomWidth) / 2 };
  }

  keyPoint(lane, depth) {
    const g = this.keyGeometry();
    const width = mix(g.topWidth, g.bottomWidth, depth);
    return { x: this.width / 2 - width / 2 + width / 4 * (lane + 0.5), y: mix(g.topY, g.lineY, depth), laneWidth: width / 4 };
  }

  drawKeys(time) {
    const c = this.ctx, w = this.width, h = this.height, g = this.keyGeometry();
    const speed = clamp(Number(this.settings.speed) || 1, 0.5, 2.5);
    const travel = 2.15 / speed;
    const leftTop = (w - g.topWidth) / 2;
    c.beginPath(); c.moveTo(leftTop, g.topY); c.lineTo(leftTop + g.topWidth, g.topY);
    c.lineTo(g.bottomLeft + g.bottomWidth + 8, g.lineY + 45); c.lineTo(g.bottomLeft - 8, g.lineY + 45); c.closePath();
    const field = c.createLinearGradient(0, g.topY, 0, g.lineY);
    field.addColorStop(0, '#0b111a08'); field.addColorStop(1, '#101b2ddd');
    c.fillStyle = field; c.fill();
    for (let i = 0; i <= 4; i++) {
      c.strokeStyle = i === 0 || i === 4 ? '#8ed3e928' : '#9bb5d315';
      c.beginPath(); c.moveTo(leftTop + g.topWidth / 4 * i, g.topY);
      c.lineTo(g.bottomLeft + g.bottomWidth / 4 * i, g.lineY + 42); c.stroke();
    }
    for (let lane = 0; lane < 4; lane++) {
      const p = this.keyPoint(lane, 1), active = clamp(1 - (time - this.flashes[lane]) / 0.18);
      if (active > 0) {
        const beam = c.createLinearGradient(0, g.lineY - h * 0.42, 0, g.lineY);
        beam.addColorStop(0, '#00000000'); beam.addColorStop(1, COLORS[lane] + '45');
        c.globalAlpha = active; c.fillStyle = beam;
        c.fillRect(p.x - p.laneWidth / 2 + 2, g.lineY - h * 0.42, p.laneWidth - 4, h * 0.42); c.globalAlpha = 1;
      }
      c.fillStyle = active ? COLORS[lane] + '35' : '#172333';
      rounded(c, p.x - p.laneWidth * 0.38, g.lineY + 15, p.laneWidth * 0.76, 31, 6); c.fill();
      c.strokeStyle = active ? COLORS[lane] : '#60718635'; c.stroke();
      this.text(KEYS[lane], p.x, g.lineY + 30, 12, active ? '#ffffff' : '#8090a6', 'center', 700);
    }
    c.strokeStyle = '#b5fff3'; c.shadowColor = '#56e9c9'; c.shadowBlur = 14; c.lineWidth = 2;
    c.beginPath(); c.moveTo(g.bottomLeft, g.lineY); c.lineTo(g.bottomLeft + g.bottomWidth, g.lineY); c.stroke();
    c.shadowBlur = 0; c.lineWidth = 1;
    for (const note of this.notes) {
      if (note.result || note.time - time > travel || time - note.time > 0.15) continue;
      const depth = clamp(1 - (note.time - time) / travel, 0, 1.07);
      const p = this.keyPoint(note.lane, depth);
      const width = p.laneWidth * 0.76, height = 9 + depth * 7;
      c.globalAlpha = clamp(depth * 5);
      c.shadowColor = COLORS[note.lane]; c.shadowBlur = this.settings.reducedMotion ? 0 : 12;
      const gradient = c.createLinearGradient(0, p.y - height, 0, p.y + height);
      gradient.addColorStop(0, '#f2ffff'); gradient.addColorStop(0.3, COLORS[note.lane]); gradient.addColorStop(1, COLORS[note.lane] + '85');
      c.fillStyle = gradient; rounded(c, p.x - width / 2, p.y - height / 2, width, height, 4); c.fill();
      c.shadowBlur = 0; c.globalAlpha = 1;
    }
    if (w > 650) {
      this.text('FOUR LANES', 28, 29, 10, '#62778b', 'left', 700);
      this.text('D · F · J · K', w - 28, h - 26, 11, '#62778b', 'right');
    }
  }

  drumGeometry() {
    return { x: Math.max(76, this.width * 0.16), y: this.height * 0.48, radius: Math.min(38, this.width * 0.075), right: this.width + 36 };
  }

  drawDrum(time) {
    const c = this.ctx, w = this.width, h = this.height, g = this.drumGeometry();
    const travel = (w < 500 ? (this.difficulty === 'hard' ? 1.05 : 1.65) : 2.45) / clamp(Number(this.settings.speed) || 1, 0.5, 2.5);
    const subdivision = this.difficulty === 'hard' ? 4 : this.difficulty === 'normal' ? 2 : 1;
    const noteRadius = Math.max(8, Math.min(g.radius * 0.71, (g.right - g.x) * 60 / this.track.bpm / subdivision / travel * 0.42));
    const railHeight = g.radius * 2.8;
    const laneGradient = c.createLinearGradient(g.x, 0, w, 0);
    laneGradient.addColorStop(0, '#3a263139'); laneGradient.addColorStop(1, '#1d243600');
    c.fillStyle = laneGradient; c.fillRect(0, g.y - railHeight / 2, w, railHeight);
    c.strokeStyle = '#b7c5d722'; c.lineWidth = 1;
    for (const y of [g.y - railHeight / 2, g.y + railHeight / 2]) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    c.setLineDash([3, 11]); c.strokeStyle = '#a4adc918';
    c.beginPath(); c.moveTo(g.x, g.y); c.lineTo(w, g.y); c.stroke(); c.setLineDash([]);
    const flash = Math.max(...this.flashes.map((t) => clamp(1 - (time - t) / 0.22)));
    c.beginPath(); c.arc(g.x, g.y, g.radius + 10 + flash * 5, 0, TAU);
    c.strokeStyle = '#ffb1c0' + (flash > 0 ? 'c0' : '35'); c.lineWidth = 2; c.stroke();
    c.beginPath(); c.arc(g.x, g.y, g.radius, 0, TAU);
    c.fillStyle = '#131926'; c.fill(); c.strokeStyle = flash > 0 ? '#fff1f3' : '#d7e0ee'; c.lineWidth = 3; c.stroke();
    c.beginPath(); c.arc(g.x, g.y, g.radius - 9, 0, TAU); c.strokeStyle = '#69758870'; c.lineWidth = 1; c.stroke();
    this.text('✦', g.x, g.y, 22, '#d2d9e8');
    for (const note of this.notes) {
      if (note.result || note.time - time > travel || time - note.time > 0.15) continue;
      const p = 1 - (note.time - time) / travel;
      const x = mix(g.right, g.x, p), radius = noteRadius;
      const color = note.lane === 0 ? '#ff7798' : '#68d7f0';
      c.shadowColor = color; c.shadowBlur = this.settings.reducedMotion ? 0 : 16;
      c.beginPath(); c.arc(x, g.y, radius, 0, TAU); c.fillStyle = color; c.fill(); c.shadowBlur = 0;
      c.beginPath(); c.arc(x, g.y, radius - 5, 0, TAU); c.strokeStyle = '#ffffffa0'; c.lineWidth = 1.5; c.stroke();
      this.text(note.lane === 0 ? '●' : '○', x, g.y, 15, '#102333', 'center', 700);
    }
    c.lineWidth = 1;
    this.text('TWO COLORS. ONE RHYTHM.', w / 2, h * 0.19, 10, '#7b7f96', 'center', 700);
    this.text('F / J  ·  红色', w * 0.38, h * 0.78, w < 450 ? 11 : 13, '#ee9bb0');
    this.text('D / K  ·  蓝色', w * 0.65, h * 0.78, w < 450 ? 11 : 13, '#8bcddd');
    if (w > 650) this.text('PULSE DRUM', 28, 29, 10, '#7d6e85', 'left', 700);
  }

  orbitGeometry(time) {
    let index = 0;
    while (index < this.notes.length && this.notes[index].time <= time) index++;
    const previousTime = index > 0 ? this.notes[index - 1].time : 0;
    const nextTime = index < this.notes.length ? this.notes[index].time : previousTime + 0.5;
    const progress = clamp((time - previousTime) / Math.max(0.05, nextTime - previousTime));
    const anchor = this.path[index];
    const previous = index ? this.path[index - 1] : { x: anchor.x - 1, y: anchor.y };
    const next = this.path[index + 1] || { x: anchor.x + 1, y: anchor.y };
    let startAngle = Math.atan2(previous.y - anchor.y, previous.x - anchor.x);
    let endAngle = Math.atan2(next.y - anchor.y, next.x - anchor.x);
    while (endAngle <= startAngle) endAngle += TAU;
    const angle = mix(startAngle, endAngle, progress);
    const scale = Math.min(this.width / 850, this.height / 420);
    const step = Math.max(43, Math.min(90, 80 * scale));
    const originX = this.width * (this.width < 500 ? 0.35 : 0.34);
    const originY = this.height * 0.54;
    // Follow the last completed tile over this beat. The camera is continuous
    // when the planets swap pivots, instead of jumping a whole tile each beat.
    const cameraFrom = index ? this.path[index - 1] : anchor;
    const easing = progress * progress * (3 - 2 * progress);
    const camera = { x: mix(cameraFrom.x, anchor.x, easing), y: mix(cameraFrom.y, anchor.y, easing) };
    const project = (point) => ({ x: originX + (point.x - camera.x) * step, y: originY + (point.y - camera.y) * step });
    return { index, progress, anchor, step, project, pivot: project(anchor), angle };
  }

  drawOrbit(time) {
    const c = this.ctx, w = this.width, h = this.height;
    const g = this.orbitGeometry(time), start = Math.max(0, g.index - 4), end = Math.min(this.path.length - 1, g.index + 10);
    c.lineWidth = 2;
    c.strokeStyle = '#86a4b927'; c.beginPath();
    for (let i = start; i <= end; i++) {
      const p = g.project(this.path[i]);
      if (i === start) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
    }
    c.stroke();
    for (let i = start; i <= end; i++) {
      const p = g.project(this.path[i]), next = i === g.index + 1, current = i === g.index;
      const result = i > 0 ? this.notes[i - 1]?.result : 'perfect';
      const size = g.step * 0.39;
      c.globalAlpha = i < g.index ? 0.3 : clamp(1 - (i - g.index) * 0.075, 0.2, 1);
      c.fillStyle = current ? '#b1f6e32b' : next ? '#233a49' : '#182332';
      rounded(c, p.x - size / 2, p.y - size / 2, size, size, 7); c.fill();
      c.strokeStyle = result === 'miss' ? '#f5808d' : current ? '#b1f6e3' : next ? '#81c7cf' : '#718aa745';
      c.lineWidth = next ? 1.7 : 1; c.stroke();
      if (next) {
        c.globalAlpha = 0.8;
        const ring = size / 2 + 7 + (1 - g.progress) * 14;
        c.beginPath(); c.arc(p.x, p.y, ring, 0, TAU); c.strokeStyle = '#abf3de45'; c.stroke();
      }
      c.globalAlpha = 1;
    }
    c.beginPath(); c.arc(g.pivot.x, g.pivot.y, g.step, 0, TAU);
    c.strokeStyle = '#bdcfff12'; c.setLineDash([2, 8]); c.stroke(); c.setLineDash([]);
    const moving = { x: g.pivot.x + Math.cos(g.angle) * g.step, y: g.pivot.y + Math.sin(g.angle) * g.step };
    const stars = [g.pivot, moving];
    stars.forEach((p, i) => {
      const color = (g.index + i) % 2 ? '#ff9e84' : '#85f7d3';
      const halo = c.createRadialGradient(p.x, p.y, 2, p.x, p.y, 28);
      halo.addColorStop(0, color + '70'); halo.addColorStop(1, color + '00');
      c.fillStyle = halo; c.fillRect(p.x - 28, p.y - 28, 56, 56);
      c.shadowColor = color; c.shadowBlur = this.settings.reducedMotion ? 0 : 17;
      c.beginPath(); c.arc(p.x, p.y, 8.5, 0, TAU); c.fillStyle = color; c.fill(); c.shadowBlur = 0;
      c.beginPath(); c.arc(p.x - 2, p.y - 2, 2.5, 0, TAU); c.fillStyle = '#ffffffc0'; c.fill();
    });
    if (!this.settings.reducedMotion) {
      c.beginPath(); c.arc(g.pivot.x, g.pivot.y, g.step, g.angle - 0.37, g.angle);
      c.strokeStyle = (g.index % 2 ? '#85f7d3' : '#ff9e84') + '65'; c.lineWidth = 4; c.stroke();
    }
    c.lineWidth = 1;
    this.text('FOLLOW THE ORBIT', w / 2, h * 0.17, 10, '#7b92a4', 'center', 700);
    this.text('空格 / 点击任意位置', w / 2, h * 0.84, 12, '#9baec0');
    if (w > 650) this.text('ORBITAL FLOW', 28, 29, 10, '#6e8397', 'left', 700);
  }

  burst(lane, time, note) {
    if (this.settings.reducedMotion) return;
    let origin;
    if (this.mode === 'keys') origin = this.keyPoint(lane, 1);
    else if (this.mode === 'drum') origin = this.drumGeometry();
    else {
      const geometry = this.orbitGeometry(time);
      const destination = note ? this.path[this.notes.indexOf(note) + 1] : geometry.anchor;
      origin = geometry.project(destination);
    }
    const color = this.mode === 'drum' ? (lane ? '#68d7f0' : '#ff7798') : this.mode === 'orbit' ? '#a9f5dc' : COLORS[lane];
    for (let i = 0; i < 13; i++) {
      const angle = i / 13 * TAU + (this.combo % 5) * 0.12;
      const speed = 45 + (i % 4) * 22;
      this.particles.push({ x: origin.x, y: origin.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 25, time, color, radius: 1.5 + (i % 3) * 0.7 });
    }
    if (this.particles.length > 180) this.particles.splice(0, this.particles.length - 180);
  }

  drawParticles(time) {
    const c = this.ctx;
    this.particles = this.particles.filter((particle) => time - particle.time < 0.55);
    for (const p of this.particles) {
      const age = Math.max(0, time - p.time);
      c.globalAlpha = clamp(1 - age / 0.55);
      c.fillStyle = p.color;
      c.beginPath(); c.arc(p.x + p.vx * age, p.y + p.vy * age + age * age * 45, p.radius, 0, TAU); c.fill();
    }
    c.globalAlpha = 1;
  }

  drawJudgement(time) {
    const age = time - this.judgementAt;
    if (!this.judgement || age < 0 || age > 0.65) return;
    const c = this.ctx, w = this.width, h = this.height;
    c.globalAlpha = clamp((0.65 - age) / 0.2);
    const color = this.judgement === 'PERFECT' ? '#b7f9df' : this.judgement === 'GOOD' ? '#9dcaff' : '#ff91aa';
    const y = this.mode === 'keys' ? h * 0.42 : h * 0.29;
    const compact = h < 260;
    const lift = this.settings.reducedMotion ? 0 : Math.min(age * 12, 5);
    this.text(this.judgement, w / 2, y - lift, compact || w < 450 ? 18 : 22, color, 'center', 750);
    let detail = '错过节拍';
    if (this.offsetMs !== null) {
      detail = this.offsetDirection === 'onTime'
        ? `正拍 · ${this.offsetMs > 0 ? '+' : ''}${this.offsetMs} ms`
        : `${this.offsetMs < 0 ? '提前' : '偏晚'} ${Math.abs(this.offsetMs)} ms`;
    }
    this.text(detail, w / 2, y + (compact ? 20 : 25) - lift, compact ? 10 : 11, '#bacbdd');
    if (this.combo > 1) {
      const milestone = this.combo % 25 === 0;
      this.text(`${this.combo} COMBO${milestone ? ' ✦' : ''}`, w / 2, y + (compact ? 39 : 49) - lift, milestone ? 15 : 12, milestone ? '#e3ffb0' : '#c4d0e1', 'center', 650);
    }
    c.globalAlpha = 1;
  }
}
