import test from 'node:test';
import assert from 'node:assert/strict';
import { RhythmGame } from '../dist/game.js';
import { TRACKS, createChart } from '../dist/audio.js';

// The renderer is intentionally silent here. Input, chart generation, judgement,
// lifecycle callbacks, and the entire RhythmGame control flow are real.
function drawingContext() {
  const context = {};
  for (const name of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'fill', 'stroke', 'fillRect', 'fillText', 'setTransform', 'setLineDash']) {
    context[name] = () => {};
  }
  context.createLinearGradient = context.createRadialGradient = () => ({ addColorStop() {} });
  return context;
}

class EventSurface {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
    if (this.listeners.get(type)?.size === 0) this.listeners.delete(type);
  }
  dispatch(type, properties = {}) {
    const event = { type, target: this, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    return event;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

function browserEnvironment() {
  const names = ['window', 'document', 'performance', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const env = { seconds: 0, rafId: 0, frames: new Map(), observers: [], window: new EventSurface(), document: new EventSurface() };
  env.window.devicePixelRatio = 2;
  env.document.hidden = false;
  const globals = {
    window: env.window,
    document: env.document,
    performance: { now: () => env.seconds * 1000 },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; env.observers.push(this); }
      observe(target) { this.target = target; this.connected = true; }
      disconnect() { this.connected = false; }
    },
    requestAnimationFrame(callback) { const id = ++env.rafId; env.frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { env.frames.delete(id); },
  };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  env.frame = () => {
    const pending = [...env.frames.values()];
    env.frames.clear();
    for (const callback of pending) callback(env.seconds * 1000);
  };
  env.advance = (seconds) => { env.seconds += seconds; env.frame(); };
  env.restore = () => {
    for (const name of names) {
      if (originals.get(name)) Object.defineProperty(globalThis, name, originals.get(name));
      else delete globalThis[name];
    }
  };
  return env;
}

class ClockAudio {
  constructor(env) { this.env = env; this.offset = 0; this.startAt = 0; this.playing = false; this.stopCalls = 0; this.hits = []; this.unlockCalls = 0; this.playCalls = []; }
  async unlock() { this.unlockCalls++; if (this.unlockHook) await this.unlockHook(); this.unlocked = true; }
  async load(track) { assert.equal(this.unlocked, true); this.track = track; }
  setVolume(value) { this.volume = value; }
  get duration() { return this.track?.duration || 0; }
  play(offset = 0, delay = 0) {
    assert.ok(this.track, 'play must follow load');
    this.playCalls.push({ offset, delay });
    this.offset = offset;
    this.startAt = this.env.seconds + delay;
    this.playing = true;
  }
  now() {
    if (!this.playing) return this.offset;
    if (this.env.seconds < this.startAt) return this.env.seconds - this.startAt;
    return this.offset + this.env.seconds - this.startAt;
  }
  pause() {
    const current = this.now();
    this.offset = current < 0 ? this.offset : current;
    this.playing = false;
    return this.offset;
  }
  stop() { this.stopCalls++; this.playing = false; this.offset = 0; }
  hit(lane) { this.hits.push(lane); }
  seekMusic(seconds) {
    assert.equal(this.playing, true, 'seeking requires active playback');
    this.env.seconds = this.startAt + seconds - this.offset;
  }
}

function harness(t, options = {}) {
  const env = browserEnvironment();
  const canvas = new EventSurface();
  const context = drawingContext();
  canvas.style = { touchAction: 'pan-y' };
  canvas.getContext = () => context;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 });
  const audio = new ClockAudio(env);
  const updates = [], results = [], pauses = [], errors = [];
  const track = options.track || TRACKS[0];
  const mode = options.mode || 'keys';
  const difficulty = options.difficulty || 'normal';
  let game;
  t.after(() => { game?.destroy(); env.restore(); });
  game = new RhythmGame({ canvas, audio, track, mode, difficulty, settings: options.settings || {},
    onUpdate: (value) => updates.push(value), onFinish: (value) => results.push(value), onPause: (value) => pauses.push(value), onError: (error) => errors.push(error),
  });
  const chart = createChart(track, mode, difficulty);
  const finish = () => { audio.seekMusic(track.duration + 0.01); env.frame(); };
  const hit = (note, delay = 0) => { audio.seekMusic(note.time + delay); const accepted = game.input(note.lane); env.frame(); return accepted; };
  return { env, canvas, audio, game, chart, track, updates, results, pauses, errors, finish, hit, latest: () => updates.at(-1) };
}

for (const [index, mode] of ['keys', 'drum', 'orbit'].entries()) {
  test(`${mode}: public start/input/finish flow gives a perfect full chart exactly 1,000,000 points`, { concurrency: false }, async (t) => {
    const h = harness(t, { mode, track: TRACKS[index], difficulty: 'hard' });
    await h.game.start();
    assert.equal(h.audio.now(), -2, 'first start includes a two-second countdown');
    assert.equal(h.game.input(h.chart[0].lane), false, 'countdown input cannot score');
    for (const note of h.chart) assert.equal(h.hit(note), true, `note ${note.id} should be playable`);
    h.finish();
    assert.equal(h.results.length, 1);
    const { timing, ...result } = h.results[0];
    assert.equal(timing.samples, h.chart.length);
    assert.equal(timing.onTime, h.chart.length);
    assert.equal(timing.early + timing.late, 0);
    assert.ok(Math.abs(timing.meanMs) < 1e-8);
    assert.ok(timing.stdDevMs < 1e-8);
    assert.deepEqual(result, {
      score: 1000000, maxCombo: h.chart.length, accuracy: 100,
      perfect: h.chart.length, good: 0, miss: 0, total: h.chart.length,
      grade: 'SS', mode, trackId: h.track.id, difficulty: 'hard',
    });
    assert.equal(h.latest().progress, 1);
    assert.equal(h.latest().remaining, 0);
    assert.equal(h.audio.playing, false);
    assert.equal(h.env.frames.size, 0, 'finishing stops animation frames');
    assert.equal(h.game.input(0), false, 'finished charts cannot receive more score');
    h.env.advance(5);
    assert.equal(h.results.length, 1, 'completion callback fires once');
  });
}

test('wrong lanes, out-of-window spam, repeated notes, and invalid lanes never add score', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  h.audio.seekMusic(0.2);
  for (let i = 0; i < 20; i++) assert.equal(h.game.input(i % 4), false);
  assert.equal(h.latest().score, 0);
  const first = h.chart[0];
  h.audio.seekMusic(first.time);
  assert.equal(h.game.input((first.lane + 1) % 4), false);
  assert.equal(h.latest().score, 0);
  assert.equal(h.game.input(first.lane), true);
  const earned = h.latest().score;
  assert.ok(earned > 0);
  assert.equal(h.game.input(first.lane), false);
  assert.equal(h.game.input(4), false);
  assert.equal(h.game.input(-1), false);
  assert.equal(h.latest().score, earned);
  assert.equal(h.audio.hits.length, 1, 'hit sound only follows successful note judgement');
  h.finish();
  assert.equal(h.results[0].perfect, 1);
  assert.equal(h.results[0].miss, h.chart.length - 1);
  assert.equal(h.results[0].score, earned);
});

test('a late missed note breaks the combo and reduces final accuracy', { concurrency: false }, async (t) => {
  const h = harness(t);
  await h.game.start();
  assert.equal(h.hit(h.chart[0]), true);
  assert.equal(h.hit(h.chart[1]), true);
  assert.equal(h.latest().combo, 2);
  h.audio.seekMusic(h.chart[2].time + 0.151);
  h.env.frame();
  assert.equal(h.latest().combo, 0);
  assert.equal(h.latest().maxCombo, 2);
  assert.equal(h.latest().judgement, 'MISS');
  assert.ok(h.latest().accuracy < 100);
  h.finish();
  assert.equal(h.results[0].perfect, 2);
  assert.equal(h.results[0].miss, h.chart.length - 2);
  assert.equal(h.results[0].maxCombo, 2);
});

test('a 100 ms timing error is GOOD and scores less than a perfect note', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  assert.equal(h.hit(h.chart[0], 0.1), true);
  assert.equal(h.latest().judgement, 'GOOD');
  assert.equal(h.latest().combo, 1);
  assert.equal(h.latest().accuracy, 70);
  h.finish();
  assert.equal(h.results[0].good, 1);
  assert.equal(h.results[0].perfect, 0);
  assert.equal(h.results[0].score, Math.round(0.7 / h.chart.length * 1000000));
});

test('positive offset delays the public accepted input window', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy', settings: { offset: 200 } });
  await h.game.start();
  const first = h.chart[0];
  h.audio.seekMusic(first.time);
  assert.equal(h.game.input(first.lane), false, 'unadjusted note time is now 200 ms too early');
  assert.equal(h.latest().score, 0);
  assert.equal(h.hit(first, 0.2), true, 'the note is perfect 200 ms after its original time');
  assert.equal(h.latest().judgement, 'PERFECT');
  assert.equal(h.latest().accuracy, 100);
  for (const note of h.chart.slice(1)) assert.equal(h.hit(note, 0.2), true);
  h.finish();
  assert.equal(h.results[0].score, 1000000);
  assert.equal(h.results[0].miss, 0);
});

test('pausing during countdown and mid-song preserves notes and resumes with a fresh countdown', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  h.env.advance(0.5);
  h.game.pause();
  assert.equal(h.latest().paused, true);
  h.env.advance(20);
  assert.equal(h.latest().score, 0);
  assert.equal(h.latest().progress, 0);
  await h.game.resume();
  assert.equal(h.audio.now(), -1);
  assert.equal(h.game.input(h.chart[0].lane), false);
  assert.equal(h.hit(h.chart[0]), true);

  h.audio.seekMusic((h.chart[0].time + h.chart[1].time) / 2);
  h.env.frame();
  h.game.pause();
  const frozen = { ...h.latest() };
  h.env.advance(120);
  assert.equal(h.latest().progress, frozen.progress);
  assert.equal(h.latest().combo, 1);
  assert.equal(h.latest().accuracy, 100);
  assert.equal(h.game.input(h.chart[1].lane), false);
  await h.game.resume();
  assert.equal(h.audio.now(), -1);
  h.env.advance(0.5);
  assert.equal(h.latest().progress, frozen.progress, 'countdown keeps the original song position');
  assert.equal(h.game.input(h.chart[1].lane), false);
  for (const note of h.chart.slice(1)) assert.equal(h.hit(note), true);
  h.finish();
  assert.deepEqual(h.pauses, [true, false, true, false]);
  assert.equal(h.results[0].score, 1000000);
  assert.equal(h.results[0].miss, 0, 'wall-clock time spent paused does not produce missed notes');
});

test('keyboard repeats are ignored; blur and page hiding automatically pause', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  const first = h.chart[0];
  h.audio.seekMusic(first.time);
  const code = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'][first.lane];
  h.env.window.dispatch('keydown', { code, repeat: true });
  assert.equal(h.latest().score, 0);
  h.env.window.dispatch('keydown', { code, target: { tagName: 'BUTTON' } });
  assert.ok(h.latest().score > 0);
  h.env.window.dispatch('blur');
  assert.equal(h.latest().paused, true);
  await h.game.resume();
  h.env.document.hidden = true;
  h.env.document.dispatch('visibilitychange');
  assert.equal(h.latest().paused, true);
  assert.deepEqual(h.pauses, [true, false, true]);
});

test('destroy stops sound, removes every event handler and observer, and cancels animation', { concurrency: false }, async (t) => {
  const h = harness(t);
  await h.game.start();
  assert.ok(h.env.window.listenerCount > 0);
  assert.ok(h.env.document.listenerCount > 0);
  assert.ok(h.canvas.listenerCount > 0);
  assert.ok(h.env.frames.size > 0);
  h.game.destroy();
  assert.equal(h.audio.playing, false);
  assert.equal(h.audio.stopCalls, 1);
  assert.equal(h.env.window.listenerCount, 0);
  assert.equal(h.env.document.listenerCount, 0);
  assert.equal(h.canvas.listenerCount, 0);
  assert.ok(h.env.observers.every((observer) => !observer.connected));
  assert.equal(h.env.frames.size, 0);
  assert.equal(h.canvas.style.touchAction, 'pan-y');
  const updatesBefore = h.updates.length;
  h.env.window.dispatch('keydown', { code: 'KeyD' });
  h.env.window.dispatch('blur');
  h.env.document.dispatch('visibilitychange');
  h.canvas.dispatch('pointerdown', { button: 0, clientX: 300, clientY: 300 });
  h.env.advance(10);
  assert.equal(h.game.input(0), false);
  assert.equal(h.updates.length, updatesBefore);
  h.game.destroy();
  assert.equal(h.audio.stopCalls, 1, 'destroy is idempotent');
});

test('all 54 charts have unique notes, valid lanes, chronological timings, and a safe audio tail', () => {
  let chartCount = 0;
  for (const track of TRACKS) {
    assert.ok(Number.isFinite(track.duration) && track.duration > 0);
    for (const mode of ['keys', 'drum', 'orbit']) {
      let previousCount = 0;
      for (const difficulty of ['easy', 'normal', 'hard']) {
        const notes = createChart(track, mode, difficulty);
        chartCount++;
        assert.ok(notes.length > 0, `${track.id}/${mode}/${difficulty} must be playable`);
        assert.ok(notes.length >= previousCount, 'difficulty increases chart density');
        previousCount = notes.length;
        assert.equal(new Set(notes.map((note) => note.id)).size, notes.length);
        let previousTime = -Infinity;
        for (const note of notes) {
          assert.ok(Number.isFinite(note.time) && note.time >= 2.4);
          assert.ok(note.time >= previousTime, 'notes remain chronological');
          assert.ok(note.time <= track.duration - 2, 'every note leaves at least two seconds before the audio ends');
          assert.ok(Number.isInteger(note.lane) && note.lane >= 0 && note.lane < ({ keys: 4, drum: 2, orbit: 1 }[mode]));
          assert.equal(note.kind, 'tap');
          assert.equal(note.duration, 0);
          previousTime = note.time;
        }
      }
    }
  }
  assert.equal(chartCount, 54);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('resume waits for audio unlock, coalesces repeated clicks, and schedules only one countdown', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  assert.equal(h.hit(h.chart[0]), true);
  h.game.pause();
  assert.equal(h.env.frames.size, 0, 'a paused game has no animation loop');
  const pausedProgress = h.latest().progress;
  const gate = deferred();
  h.audio.unlockHook = () => gate.promise;
  const resume = h.game.resume();
  assert.equal(h.game.state, 'resuming');
  assert.equal(h.latest().paused, true, 'the pause panel remains until audio is ready');
  assert.equal(await h.game.resume(), false);
  assert.equal(h.audio.playCalls.length, 1);
  assert.equal(h.game.input(h.chart[1].lane), false);
  h.env.advance(30);
  assert.equal(h.latest().progress, pausedProgress);
  assert.equal(h.env.frames.size, 0);
  gate.resolve();
  assert.equal(await resume, true);
  assert.equal(h.audio.playCalls.length, 2);
  assert.equal(h.audio.playCalls[1].delay, 1);
  assert.equal(h.audio.now(), -1);
  assert.equal(h.env.frames.size, 1);
  for (const note of h.chart.slice(1)) assert.equal(h.hit(note), true);
  h.finish();
  assert.equal(h.results[0].score, 1000000);
  assert.equal(h.results[0].miss, 0);
});

test('losing focus cancels a pending resume, and a later deliberate resume can retry', { concurrency: false }, async (t) => {
  const h = harness(t);
  await h.game.start();
  h.game.pause();
  const gate = deferred();
  h.audio.unlockHook = () => gate.promise;
  const pending = h.game.resume();
  h.env.window.dispatch('blur');
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.game.state, 'paused');
  assert.equal(h.audio.playCalls.length, 1);
  assert.equal(h.env.frames.size, 0);
  assert.equal(h.errors.length, 0);
  h.audio.unlockHook = null;
  assert.equal(await h.game.resume(), true);
  assert.equal(h.audio.playCalls.length, 2);
});

test('a page hidden while audio is unlocking never begins background playback', { concurrency: false }, async (t) => {
  const h = harness(t);
  await h.game.start();
  h.game.pause();
  const gate = deferred();
  h.audio.unlockHook = () => gate.promise;
  const pending = h.game.resume();
  h.env.document.hidden = true;
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.latest().paused, true);
  assert.equal(h.audio.playCalls.length, 1);
  assert.equal(h.env.frames.size, 0);
});

test('destroying while unlock is pending prevents a stale source, callbacks, or animation restart', { concurrency: false }, async (t) => {
  const h = harness(t);
  await h.game.start();
  h.game.pause();
  const gate = deferred();
  h.audio.unlockHook = () => gate.promise;
  const pending = h.game.resume();
  h.game.destroy();
  const updateCount = h.updates.length;
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.game.state, 'destroyed');
  assert.equal(h.audio.playCalls.length, 1);
  assert.equal(h.updates.length, updateCount);
  assert.equal(h.errors.length, 0);
  assert.equal(h.env.frames.size, 0);
  assert.equal(h.env.window.listenerCount, 0);
});

test('a failed audio unlock reports an error, retains the chart, and allows a successful retry', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  assert.equal(h.hit(h.chart[0]), true);
  h.game.pause();
  const failure = new Error('Audio device unavailable');
  h.audio.unlockHook = async () => { throw failure; };
  assert.equal(await h.game.resume(), false);
  assert.deepEqual(h.errors, [failure]);
  assert.equal(h.latest().paused, true);
  assert.equal(h.latest().combo, 1);
  assert.equal(h.audio.playCalls.length, 1);
  assert.equal(h.env.frames.size, 0);
  h.audio.unlockHook = null;
  assert.equal(await h.game.resume(), true);
  for (const note of h.chart.slice(1)) assert.equal(h.hit(note), true);
  h.finish();
  assert.equal(h.results[0].score, 1000000);
  assert.equal(h.results[0].miss, 0);
});

test('signed timing feedback distinguishes bias from consistency and excludes misses', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  const errors = [-0.06, 0, 0.06, 0.12];
  let firstSnapshot;
  for (const [index, error] of errors.entries()) {
    assert.equal(h.hit(h.chart[index], error), true);
    assert.equal(h.latest().offsetMs, Math.round(error * 1000));
    if (index === 0) firstSnapshot = h.latest().timing;
  }
  const timing = h.latest().timing;
  assert.equal(timing.early, 1);
  assert.equal(timing.onTime, 1);
  assert.equal(timing.late, 2);
  assert.equal(timing.samples, 4);
  assert.ok(Math.abs(timing.meanMs - 30) < 1e-7);
  assert.ok(Math.abs(timing.stdDevMs - Math.sqrt(4500)) < 1e-7);
  assert.equal(firstSnapshot.samples, 1, 'callback snapshots cannot be changed by later hits');
  h.audio.seekMusic(h.chart[4].time + 0.151);
  h.env.frame();
  assert.equal(h.latest().judgement, 'MISS');
  assert.equal(h.latest().offsetMs, null, 'a miss cannot display the preceding hit offset');
  assert.deepEqual(h.latest().timing, timing);
  h.finish();
  assert.deepEqual(h.results[0].timing, timing);
  assert.equal(h.results[0].perfect, 3);
  assert.equal(h.results[0].good, 1);
  assert.equal(h.results[0].score, Math.round(3.7 / h.chart.length * 1000000), 'timing diagnostics do not change scoring');
});

test('25 ms on-time boundaries leave the original 70/150 ms scoring windows intact', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  for (const [index, error] of [-0.025, 0.025, -0.07, 0.07, -0.15, 0.15].entries()) {
    assert.equal(h.hit(h.chart[index], error), true);
    assert.equal(h.latest().judgement, index < 4 ? 'PERFECT' : 'GOOD');
  }
  const timing = h.latest().timing;
  assert.deepEqual([timing.early, timing.onTime, timing.late, timing.samples], [2, 2, 2, 6]);
  h.audio.seekMusic(h.chart[6].time + 0.1501);
  assert.equal(h.game.input(h.chart[6].lane), false);
  h.finish();
  assert.equal(h.results[0].perfect, 4);
  assert.equal(h.results[0].good, 2);
});

test('Space and Enter keep native paused-button activation while focused buttons accept gameplay keys', { concurrency: false }, async (t) => {
  const h = harness(t, { mode: 'orbit', difficulty: 'easy' });
  await h.game.start();
  h.game.pause();
  const button = { tagName: 'BUTTON' };
  for (const code of ['Space', 'Enter']) {
    const event = h.env.window.dispatch('keydown', { code, target: button });
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(h.latest().score, 0);
  await h.game.resume();
  h.audio.seekMusic(h.chart[0].time);
  const event = h.env.window.dispatch('keydown', { code: 'Space', target: button });
  assert.equal(event.defaultPrevented, true);
  assert.ok(h.latest().score > 0);
});

test('canvas touches map to the visible perspective lane and ignore the margins', { concurrency: false }, async (t) => {
  const h = harness(t, { difficulty: 'easy' });
  await h.game.start();
  const note = h.chart.find((item) => item.lane === 0);
  h.audio.seekMusic(note.time);
  h.canvas.dispatch('pointerdown', { button: 0, clientX: 5, clientY: 80 });
  assert.equal(h.latest().score, 0, 'the blank margin is not the outer lane');
  const visiblePoint = h.game.keyPoint(note.lane, 0.1);
  h.canvas.dispatch('pointerdown', { button: 0, clientX: visiblePoint.x, clientY: visiblePoint.y });
  assert.equal(h.latest().timing.samples, 1);
  assert.equal(h.latest().judgement, 'PERFECT');
  const score = h.latest().score;
  h.canvas.dispatch('pointerdown', { button: 2, clientX: visiblePoint.x, clientY: visiblePoint.y });
  assert.equal(h.latest().score, score);
});

test('drum canvas halves and orbit canvas taps trigger the same scoring as keyboard inputs', { concurrency: false }, async (t) => {
  for (const mode of ['drum', 'orbit']) {
    await t.test(mode, async (child) => {
      const h = harness(child, { mode, difficulty: 'easy' });
      await h.game.start();
      for (const note of h.chart.slice(0, 2)) {
        h.audio.seekMusic(note.time);
        h.canvas.dispatch('pointerdown', { button: 0, clientX: note.lane ? 850 : 50, clientY: 200 });
      }
      assert.equal(h.latest().combo, 2);
      assert.equal(h.latest().timing.samples, 2);
    });
  }
});

test('orbit camera and both planet colors remain visually continuous across beat boundaries', { concurrency: false }, async (t) => {
  const h = harness(t, { mode: 'orbit' });
  const positionByColor = (geometry) => {
    const moving = { x: geometry.pivot.x + Math.cos(geometry.angle) * geometry.step, y: geometry.pivot.y + Math.sin(geometry.angle) * geometry.step };
    return geometry.index % 2 ? [moving, geometry.pivot] : [geometry.pivot, moving];
  };
  for (const note of h.chart.slice(0, 10)) {
    const before = h.game.orbitGeometry(note.time - 1e-6);
    const after = h.game.orbitGeometry(note.time + 1e-6);
    const landmark = { x: 3, y: 1 };
    const a = before.project(landmark), b = after.project(landmark);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.01, 'the path must not jump by a whole tile');
    const oldStars = positionByColor(before), newStars = positionByColor(after);
    for (let i = 0; i < 2; i++) assert.ok(Math.hypot(oldStars[i].x - newStars[i].x, oldStars[i].y - newStars[i].y) < 0.02);
  }
});
