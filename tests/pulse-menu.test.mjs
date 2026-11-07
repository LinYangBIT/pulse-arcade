import test from 'node:test';
import assert from 'node:assert/strict';
import { MenuMusic } from '../dist/menu-music.js';
import { normalizeSettings } from '../dist/preferences.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function audioFake() {
  return { playing: false, buffer: null, plays: 0, resumes: 0,
    async unlock() { this.resumes++; }, async load() { this.buffer = {}; },
    setVolume(v) { this.volume = v; }, setSfxVolume(v) { this.sfx = v; },
    play(...args) { this.plays++; this.playing = true; this.args = args; },
    pause() { this.playing = false; }, destroy() { this.destroyed = true; },
  };
}
test('music defaults on, old silent preferences stay silent, malformed settings recover', () => {
  assert.equal(normalizeSettings(null).musicEnabled, true);
  assert.equal(normalizeSettings({volume:0}).volume, 0);
  assert.equal(normalizeSettings({musicEnabled:false}).musicEnabled, false);
  assert.deepEqual(normalizeSettings({volume:'1',offset:NaN,speed:1.17,sfxVolume:9},true),
    {volume:.65,sfxVolume:1,musicEnabled:true,speed:1,offset:0,reducedMotion:true});
});
test('first gesture retries a pending autoplay resume and only starts one quiet loop', async () => {
  const audio = audioFake(), wait = deferred();
  audio.unlock = function() { this.resumes++; return wait.promise; };
  const menu = new MenuMusic({createAudio:()=>audio});
  const first = menu.start();
  const gesture = menu.start();
  assert.equal(audio.resumes, 2);
  wait.resolve(); await Promise.all([first,gesture]);
  assert.equal(audio.plays,1);
  assert.equal(audio.volume,.65*.3);
  assert.equal(audio.sfx,0);
  assert.deepEqual(audio.args,[2.4,0,{loop:true}]);
  await menu.start(); assert.equal(audio.plays,1);
});
test('starting a game while menu music renders cannot start a stale lobby track', async () => {
  const audio = audioFake(), wait = deferred();
  audio.load = async function() { await wait.promise; this.buffer = {}; };
  const menu = new MenuMusic({createAudio:()=>audio});
  const start = menu.start(); await Promise.resolve();
  menu.configure({enabled:true,volume:.65,blocked:true});
  wait.resolve(); await start;
  assert.equal(audio.plays,0);
  menu.configure({enabled:true,volume:.65,blocked:false});
  await menu.pending; assert.equal(audio.plays,1);
});
test('mute and hidden state stop the loop and destroy prevents future gestures from restarting', async () => {
  const audio = audioFake(), menu = new MenuMusic({createAudio:()=>audio});
  await menu.start();
  menu.configure({enabled:false,volume:.65,blocked:false});
  await menu.start(); assert.equal(audio.playing,false); assert.equal(audio.plays,1);
  menu.configure({enabled:true,volume:.65,blocked:true});
  await menu.start(); assert.equal(audio.plays,1);
  menu.configure({enabled:true,volume:.65,blocked:false}); await menu.pending;
  assert.equal(audio.plays,2);
  menu.destroy(); await menu.start();
  assert.equal(audio.destroyed,true); assert.equal(audio.plays,2);
});
test('autoplay rejection leaves the next gesture free to recover', async () => {
  const audio = audioFake(); audio.unlock = async function() { if(++this.resumes===1)throw new Error('blocked'); };
  const menu = new MenuMusic({createAudio:()=>audio});
  await menu.start(); assert.equal(audio.plays,0);
  await menu.start(); assert.equal(audio.plays,1);
});
