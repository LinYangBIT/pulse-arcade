import test from 'node:test';
import assert from 'node:assert/strict';
import { RhythmAudio, TRACKS } from '../dist/audio.js';

// Exercise the production transport and graph ownership. The Web Audio API is
// mocked; these tests do not claim to measure audible mix or browser policy.
class Param {
  constructor(value = 0) { this.value = value; this.calls = []; }
  record(method, value, time) { this.calls.push({ method, value, time }); this.value = value; }
  setValueAtTime(v, t) { this.record('set', v, t); }
  linearRampToValueAtTime(v, t) { this.record('linear', v, t); }
  exponentialRampToValueAtTime(v, t) { this.record('exponential', v, t); }
  setTargetAtTime(v, t) { this.record('target', v, t); }
  cancelScheduledValues(t) { this.calls.push({ method: 'cancel', time: t }); }
  cancelAndHoldAtTime(t) { this.calls.push({ method: 'hold', time: t }); }
}

class Node {
  constructor() {
    this.connections = [];
    this.disconnections = 0;
    for (const name of ['gain', 'frequency', 'detune', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new Param();
  }
  connect(target) { this.connections.push(target); }
  disconnect() { this.disconnections++; this.connections = []; }
}

class Source extends Node {
  constructor(context) { super(); this.context = context; this.startArgs = null; this.stopTimes = []; this.loop = false; this.ended = false; }
  start(time = 0, offset = 0) { this.startArgs = [time, offset]; }
  stop(time = this.context.currentTime) { this.stopTimes.push(time); }
  end() { if (!this.ended) { this.ended = true; this.onended?.(); } }
}

function environment(t) {
  const originals = new Map(['AudioContext', 'OfflineAudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const env = { contexts: [], renderRequests: [], deferRendering: false, resume: null };
  class Context {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 32000; this.destination = new Node(); this.sources = []; this.closeCalls = 0; this.resumeCalls = 0; env.contexts.push(this); }
    createGain() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createDynamicsCompressor() { return new Node(); }
    createConvolver() { return new Node(); }
    createBufferSource() { const source = new Source(this); this.sources.push(source); return source; }
    createOscillator() { return this.createBufferSource(); }
    createBuffer(channels, length, sampleRate) {
      const data = new Map();
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
        getChannelData(channel) { if (!data.has(channel)) data.set(channel, new Float32Array(length)); return data.get(channel); } };
    }
    async resume() { this.resumeCalls++; if (env.resume) return env.resume(this); this.state = 'running'; }
    async close() { this.closeCalls++; this.state = 'closed'; }
    advance(seconds) {
      if (this.state === 'running') this.currentTime += seconds;
      for (const source of this.sources) {
        if (source.ended) continue;
        const stopped = source.stopTimes.length && source.stopTimes.at(-1) <= this.currentTime;
        const naturalEnd = source.buffer && source.startArgs && !source.loop
          && source.startArgs[0] + source.buffer.duration - source.startArgs[1] <= this.currentTime;
        if (stopped || naturalEnd) source.end();
      }
    }
  }
  class OfflineContext extends Context {
    constructor(channels, length, sampleRate) { super(); this.renderBuffer = this.createBuffer(channels, length, sampleRate); }
    startRendering() {
      const buffer = this.renderBuffer;
      if (!env.deferRendering) return Promise.resolve(buffer);
      return new Promise((resolve, reject) => env.renderRequests.push({ resolve: () => resolve(buffer), reject }));
    }
  }
  globalThis.AudioContext = Context;
  globalThis.OfflineAudioContext = OfflineContext;
  const players = [];
  env.player = () => { const audio = new RhythmAudio(); players.push(audio); return audio; };
  t.after(async () => {
    await Promise.all(players.map(audio => audio.destroy()));
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return env;
}

let trackSerial = 0;
function track() { return { ...TRACKS[0], id: `audio-test-${++trackSerial}` }; }
async function ready(env, song = track()) {
  const audio = env.player();
  await audio.unlock();
  await audio.load(song);
  return audio;
}

test('music and SFX volumes remain independent, including saved mute before unlock', { concurrency: false }, async t => {
  const env = environment(t), audio = env.player();
  audio.setVolume(0);
  audio.setSfxVolume(0.6);
  await audio.unlock();
  await audio.load(track());
  audio.play();
  const source = audio.source;
  const voiceGain = source.connections[0];
  assert.equal(voiceGain.connections[0], audio.musicGain);
  assert.equal(audio.musicGain.gain.value, 0);
  audio.hit(0);
  const hit = audio.context.sources.at(-1);
  assert.equal(hit.connections[0].connections[0], audio.sfxGain);
  assert.equal(audio.sfxGain.gain.value, 0.6);
  audio.setSfxVolume(0);
  assert.equal(hit.disconnections, 1);
  assert.equal(audio.status.activeSources, 1);
  audio.setVolume(0.4);
  assert.equal(audio.sfxGain.gain.value, 0);
  audio.hit(1);
  assert.equal(audio.status.activeSources, 1, 'muted SFX do not allocate a source');
  assert.deepEqual(audio.status, { contextState: 'running', playing: true, looping: false, musicVolume: 0.4, sfxVolume: 0, activeSources: 1 });
});

test('loop playback repeats the complete chart bars and reports a wrapped audio clock', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  const song = audio.track, barDuration = song.beats * 60 / song.bpm;
  audio.buffer.getChannelData(0).fill(0.5);
  audio.play(0, 0, { loop: true });
  const menuBuffer = audio.source.buffer;
  assert.equal(audio.source.loop, true);
  assert.equal(audio.source.loopStart, 2.4);
  assert.equal(audio.source.loopEnd, 2.4 + barDuration);
  assert.equal(audio.source.startArgs[1], 2.4, 'intro is omitted from a bar loop');
  const seamStart = Math.round(2.4 * menuBuffer.sampleRate);
  const seamEnd = Math.ceil((2.4 + barDuration) * menuBuffer.sampleRate);
  assert.equal(menuBuffer.getChannelData(0)[seamStart], 0);
  assert.equal(menuBuffer.getChannelData(0)[seamEnd - 1], 0);
  assert.equal(audio.buffer.getChannelData(0)[seamStart], 0.5, 'seam smoothing never modifies gameplay audio');
  audio.context.advance(barDuration * 2 + 0.5);
  assert.ok(Math.abs(audio.now() - 2.9) < 1e-8);
  assert.equal(audio.status.looping, true);
  audio.pause();
  audio.context.advance(10);
  await audio.resume();
  assert.equal(audio.source.loop, true, 'resume retains loop intent');
  assert.equal(audio.source.buffer, menuBuffer, 'the loop variant is cached');
  assert.ok(Math.abs(audio.now() - 2.9) < 1e-8);
});

test('non-loop playback retains countdown, offset, completion and fade behavior', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  audio.play(4, 2);
  const source = audio.source;
  const ramp = source.connections[0].gain.calls.find(call => call.method === 'linear');
  assert.equal(source.loop, false);
  assert.deepEqual(source.startArgs, [2, 4]);
  assert.equal(audio.now(), -2);
  assert.ok(ramp.time > 2 && ramp.time < 2.1);
  audio.context.advance(2.5);
  assert.equal(audio.now(), 4.5);
  audio.context.advance(audio.duration);
  assert.equal(audio.now(), audio.duration);
  assert.equal(audio.status.playing, false);
  assert.equal(audio.status.activeSources, 0);
});

test('rapid switching bounds fade tails and never leaves old loop sources running', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  for (let i = 0; i < 30; i++) {
    audio.play(2.4 + i / 100, 0, { loop: true });
    assert.ok(audio.status.activeSources <= 3);
  }
  const sources = audio.context.sources;
  assert.equal(sources.filter(source => source.stopTimes.length === 0).length, 1);
  audio.context.advance(0.1);
  assert.equal(audio.status.activeSources, 1);
  assert.ok(sources.slice(0, -1).every(source => source.disconnections === 1));
});

test('pause freezes position, fades music, removes all SFX and bounds hit concurrency', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  audio.play(3);
  const context = audio.context;
  for (let round = 0; round < 4; round++) {
    context.currentTime += 0.019;
    for (let lane = 0; lane < 4; lane++) audio.hit(lane);
    assert.ok(audio.status.activeSources <= 9, 'one music source plus at most eight effects');
  }
  const currentSource = audio.source;
  const fadeParam = currentSource.connections[0].gain;
  const pausedAt = audio.pause();
  assert.ok(pausedAt > 3);
  assert.equal(audio.status.activeSources, 1, 'only the brief music fade may remain');
  assert.equal(audio.status.playing, false);
  assert.equal(fadeParam.calls.at(-1).value, 0);
  assert.ok(currentSource.stopTimes.at(-1) > context.currentTime);
  context.advance(4);
  assert.equal(audio.now(), pausedAt);
  assert.equal(audio.status.activeSources, 0);
});

test('resume restores suspended contexts; failed unlock cannot claim playback', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  audio.play(5);
  audio.pause();
  audio.context.state = 'suspended';
  assert.equal(await audio.resume(1), true);
  assert.equal(audio.context.resumeCalls, 1);
  assert.equal(audio.context.state, 'running');
  assert.equal(audio.now(), -1);
  audio.pause();
  audio.context.state = 'suspended';
  env.resume = async () => {};
  await assert.rejects(audio.resume(), { name: 'NotAllowedError' });
  assert.equal(audio.status.playing, false);
  assert.throws(() => audio.play(), { name: 'NotAllowedError' });
  env.resume = null;
  await audio.resume();
  assert.equal(audio.status.playing, true, 'a later real gesture may retry');
});

test('a pending resume cannot restart audio after the user stops it', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  audio.play(5);
  audio.pause();
  audio.context.state = 'suspended';
  let release;
  env.resume = context => new Promise(resolve => { release = () => { context.state = 'running'; resolve(); }; });
  const pending = audio.resume();
  audio.stop();
  release();
  assert.equal(await pending, false);
  assert.equal(audio.status.playing, false);
  assert.equal(audio.now(), 0);
});

test('destroy is idempotent, closes once and prevents late load assignment', { concurrency: false }, async t => {
  const env = environment(t), audio = env.player();
  await audio.unlock();
  const context = audio.context, song = track();
  env.deferRendering = true;
  const pending = audio.load(song);
  const disposal = audio.destroy();
  assert.equal(audio.destroy(), disposal);
  await disposal;
  env.renderRequests[0].resolve();
  const rendered = await pending;
  assert.equal(audio.context, null);
  assert.equal(audio.track, null);
  assert.equal(audio.buffer, null);
  assert.equal(audio.status.contextState, 'destroyed');
  assert.equal(audio.status.activeSources, 0);
  assert.equal(context.closeCalls, 1);
  await assert.rejects(audio.unlock(), /destroyed/);
  await assert.rejects(audio.load(song), /destroyed/);
  assert.throws(() => audio.play(), /destroyed/);
  const next = env.player();
  await next.load(song);
  assert.equal(next.buffer, rendered, 'disposal preserves the shared render cache');
  assert.equal(env.renderRequests.length, 1);
});

test('a slower earlier load cannot replace the last selected track', { concurrency: false }, async t => {
  const env = environment(t), audio = env.player();
  env.deferRendering = true;
  const first = track(), last = track();
  const firstLoad = audio.load(first), lastLoad = audio.load(last);
  env.renderRequests[1].resolve();
  await lastLoad;
  const lastBuffer = audio.buffer;
  env.renderRequests[0].resolve();
  await firstLoad;
  assert.equal(audio.track, last);
  assert.equal(audio.buffer, lastBuffer);
  assert.equal(audio.status.contextState, 'uninitialized', 'preloading never creates a live context');
});

test('destroying active playback releases music, effects and graph connections', { concurrency: false }, async t => {
  const env = environment(t), audio = await ready(env);
  audio.play(2.4, 0, { loop: true });
  audio.hit(0);
  const context = audio.context, music = audio.musicGain, effects = audio.sfxGain, output = audio.output;
  await audio.destroy();
  assert.equal(audio.status.activeSources, 0);
  assert.equal(context.closeCalls, 1);
  assert.equal(music.disconnections, 1);
  assert.equal(effects.disconnections, 1);
  assert.equal(output.disconnections, 1);
  assert.ok(context.sources.every(source => source.disconnections === 1));
});
