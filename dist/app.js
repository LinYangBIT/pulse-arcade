import { TRACKS, RhythmAudio } from './audio.js';
import { RhythmGame } from './game.js';
import { MenuMusic } from './menu-music.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './preferences.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ICONS = {
  headphones:'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/>',
  sliders:'<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  'arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-left':'<path d="M20 12H4m6-6-6 6 6 6"/>',
  'arrow-down':'<path d="M12 4v16m-6-6 6 6 6-6"/>',
  play:'<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke-width="0"/>',
  pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  heart:'<path d="M20.8 4.6a5.6 5.6 0 0 0-8 .1l-.8.8-.8-.8a5.6 5.6 0 0 0-8 8L12 22l8.8-9.3a5.6 5.6 0 0 0 0-8.1Z"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  trophy:'<path d="M8 3h8v7a4 4 0 0 1-8 0ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 14v6m-4 1h8"/>',
  music:'<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.play}</svg>`;
function hydrateIcons(root = document) { $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
const MODES = [
  {id:'keys',en:'4K FLOW',name:'四键下落',color:'#c6fa58',tag:'CLASSIC / 经典下落',description:'四条轨道，让每一次敲击都精准落点。',keys:['D','F','J','K'],level:2,help:'音符到达底部判定线时，按下对应的 D、F、J、K，或点按屏幕按钮。'},
  {id:'drum',en:'DUAL BEAT',name:'双键击鼓',color:'#ffaf80',tag:'GROOVE / 双色节拍',description:'红蓝交错，把节奏打进肌肉记忆。',keys:['D / K','F / J'],level:1,help:'音符到达圆形靶心时：红色按 F / J，蓝色按 D / K；也可以点按屏幕按钮。'},
  {id:'orbit',en:'ORBIT',name:'单键轨道',color:'#bda7ff',tag:'FOCUS / 单键心流',description:'沿着星轨前进，一颗心，一次敲击。',keys:['SPACE'],level:3,help:'跟随节拍，在星球抵达下一格时按空格，或点按屏幕按钮。先听，再按。'}
];
const DIFFICULTIES = [{id:'easy',name:'轻松',label:'EASY'},{id:'normal',name:'挑战',label:'NORMAL'},{id:'hard',name:'极限',label:'HARD'}];
const DEFAULTS = {...DEFAULT_SETTINGS,reducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches};
const getStorage = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(`pulse.${key}`)); return value ?? fallback; } catch { return fallback; } };
let storageWarned = false;
function saveStorage(key,value){try{localStorage.setItem(`pulse.${key}`,JSON.stringify(value));}catch{if(!storageWarned){storageWarned=true;toast('浏览器存储不可用，本次数据仅在当前页面保留。');}}}
const rawSettings = getStorage('settings',{});
const validNumber=(value,fallback,min,max)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
let settings=normalizeSettings(rawSettings,DEFAULTS.reducedMotion);
const rawFavorites=getStorage('favorites',[]);
let favorites=new Set(Array.isArray(rawFavorites)?rawFavorites.filter(id=>TRACKS.some(t=>t.id===id)):[]);
const rawRecords=getStorage('records',[]);
let records=Array.isArray(rawRecords)?rawRecords.filter(r=>r&&TRACKS.some(t=>t.id===r.trackId)&&MODES.some(m=>m.id===r.mode)&&DIFFICULTIES.some(d=>d.id===r.difficulty)&&Number.isFinite(r.score)&&r.score>=0&&r.score<=1000000&&Number.isFinite(r.accuracy)&&Number.isFinite(r.maxCombo)).map(r=>({...r,grade:['S','A','B','C','D','F','SS'].includes(r.grade)?r.grade:'D'})):[];
let totalPlays=validNumber(getStorage('totalPlays',records.length),records.length,0,10000000);
const lastSelection=getStorage('lastSelection',{});
let chosenTrack=TRACKS.find(t=>t.id===lastSelection?.trackId)||TRACKS[0],chosenMode=MODES.some(m=>m.id===lastSelection?.mode)?lastSelection.mode:'keys',chosenDifficulty=DIFFICULTIES.some(d=>d.id===lastSelection?.difficulty)?lastSelection.difficulty:'easy',filter='all';
let previewAudio=null,previewId=null,previewTimer=null,previewToken=0;
let game=null,gameAudio=null,gameStarting=false,lastResult=null;
let toastTimer;
let pageActive=true;
const menuMusic=new MenuMusic({onState:()=>renderMusicButtons()});
const musicVolume=()=>settings.musicEnabled?settings.volume:0;
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatScore=score=>Math.round(score).toLocaleString('en-US');
const durationLabel=track=>`${Math.floor(track.duration/60)}:${String(Math.round(track.duration%60)).padStart(2,'0')}`;
const cover=track=>`./assets/${track.id}.svg`;
const modeById=id=>MODES.find(m=>m.id===id)||MODES[0];
const difficultyById=id=>DIFFICULTIES.find(d=>d.id===id)||DIFFICULTIES[1];
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}

function renderMusicButtons(){
  const enabled=settings.musicEnabled&&settings.volume>0;
  const active=gameAudio||previewAudio;
  const status=active?.status||menuMusic.status;
  const playing=status.playing&&status.contextState==='running';
  for(const button of [$('#music-toggle'),$('#game-music')]){
    button.setAttribute('aria-pressed',String(enabled));
    button.setAttribute('aria-label',enabled?'关闭音乐':'开启音乐');
    button.dataset.audioState=playing&&enabled?'playing':enabled?'ready':'muted';
    button.title=enabled?'音乐已开启，点击静音':'音乐已静音，点击开启';
  }
  $('#music-toggle .music-label').textContent=enabled?'音乐开启':'音乐静音';
  $('#audio-status').textContent=!enabled?'音乐已静音；击打音效独立控制。':playing?(game?'游戏音乐播放中。':previewAudio?'正在试听曲目。':'大厅音乐 · Blue Hour 播放中。'):'音乐已开启，首次操作后自动播放。';
}
function syncAudio(){
  gameAudio?.setVolume(musicVolume());gameAudio?.setSfxVolume(settings.sfxVolume);
  previewAudio?.setVolume(musicVolume());
  menuMusic.configure({enabled:settings.musicEnabled,volume:settings.volume,blocked:!pageActive||document.hidden||Boolean(game)||gameStarting||Boolean(previewAudio)});
  renderMusicButtons();
}
function toggleMusic(){
  const enabled=settings.musicEnabled&&settings.volume>0;
  settings.musicEnabled=!enabled;
  if(!enabled&&settings.volume===0)settings.volume=DEFAULTS.volume;
  saveStorage('settings',settings);renderSettings();syncAudio();
}
function clearTouchFeedback(){
  $$('#touch-controls .pressed').forEach(button=>button.classList.remove('pressed'));
}
function renderTiming(timing,accuracy=100){
  const t=timing||{early:0,onTime:0,late:0,samples:0,meanMs:0,stdDevMs:0};
  $('#timing-early').textContent=t.early;$('#timing-on-time').textContent=t.onTime;$('#timing-late').textContent=t.late;
  const mean=Number(t.meanMs)||0;
  $('#timing-meter').style.setProperty('--timing-position',`${Math.max(0,Math.min(100,50+mean/3))}%`);
  $('#timing-marker').hidden=!t.samples;
  $('#timing-meter').setAttribute('aria-label',t.samples?`平均判定偏差 ${Math.round(mean)} 毫秒`:'尚无命中数据');
  const direction=mean<-25?'略微提前':mean>25?'略微偏晚':'接近正拍';
  $('#timing-advice').textContent=t.samples<8?'再多命中几个音符，就能分析你的节奏。先试轻松难度，听到节拍再按。':`命中平均${mean>=0?'+':''}${Math.round(mean)} ms · 波动 ${Math.round(t.stdDevMs)} ms。${direction}。${Math.abs(mean)>25?'若多局都在同一侧，可微调判定偏移。':accuracy<70?'先减少漏拍，再试着延续连击。':'保持这个节奏，试着延续连击。'}`;
}

function renderModes(){
  $('#mode-cards').innerHTML=MODES.map((m,index)=>`<button class="mode-card" data-mode-card="${m.id}" style="--mode-color:${m.color}" aria-label="选择${m.name}玩法"><div class="mode-visual"><img src="./assets/mode-${m.id}.svg" alt="${m.name}玩法示意"><span class="mode-badge">${m.tag}</span><span class="mode-number">0${index+1}</span></div><div class="mode-body"><div class="mode-title-row"><span class="mode-en">${m.en}</span><span class="mode-zh">${m.name}</span><span class="mode-arrow">${icon('arrow-up-right')}</span></div><p>${m.description}</p><div class="mode-bottom"><div class="keycaps">${m.keys.map(k=>`<kbd>${k}</kbd>`).join('')}</div><div class="mode-level"><span>上手难度</span>${[1,2,3,4].map(n=>`<i class="${n<=m.level?'on':''}"></i>`).join('')}</div></div></div></button>`).join('');
}
function trackRow(track,index){return `<div class="track-row"><div class="track-main"><span class="track-index">${String(index+1).padStart(2,'0')}</span><img class="track-cover" src="${cover(track)}" alt="${track.title} 封面" loading="lazy"><div><span class="track-name">${track.title}</span><span class="track-detail">PULSE ORIGINALS <span aria-hidden="true">/</span> ${track.genre}</span></div></div><span class="track-bpm">${track.bpm}<small>BPM</small></span><span class="track-duration">${durationLabel(track)}</span><div class="track-actions"><button class="icon-btn favorite-btn ${favorites.has(track.id)?'active':''}" data-favorite="${track.id}" aria-label="${favorites.has(track.id)?'取消收藏':'收藏'} ${track.title}" aria-pressed="${favorites.has(track.id)}">${icon('heart')}</button><button class="icon-btn preview-btn ${previewId===track.id?'playing':''}" data-preview="${track.id}" aria-label="${previewId===track.id?'停止试听':'试听'} ${track.title}">${icon(previewId===track.id?'pause':'play')}</button><button class="track-play" data-play="${track.id}">游玩 ${icon('arrow-up-right')}</button></div></div>`;}
function renderTracks(){
  $('#home-tracks').innerHTML=TRACKS.slice(0,4).map(trackRow).join('');
  const search=$('#track-search').value.toLowerCase().trim();
  const tracks=TRACKS.filter(t=>(filter!=='favorite'||favorites.has(t.id))&&`${t.title} ${t.subtitle} ${t.genre} ${t.bpm}`.toLowerCase().includes(search));
  $('#library-tracks').innerHTML=tracks.length?tracks.map(trackRow).join(''):`<div class="empty-state">${icon(filter==='favorite'?'heart':'search')}<h3>${filter==='favorite'&&!search?'收藏你的下一首心头好':'没有找到匹配曲目'}</h3><p>${filter==='favorite'&&!search?'点击曲目旁的爱心，把喜欢的节拍留在这里。':'换个曲名、风格或 BPM 再试试。'}</p><button class="button secondary" data-reset-search>查看全部曲目</button></div>`;
}
function renderScores(){
  const bestAccuracy=records.length?Math.max(...records.map(r=>r.accuracy)):0;
  const bestCombo=records.length?Math.max(...records.map(r=>r.maxCombo)):0;
  $('#score-stats').innerHTML=[{value:totalPlays,label:'完成的挑战'},{value:bestAccuracy.toFixed(2)+'%',label:'最佳准确率'},{value:bestCombo,label:'最高连击'}].map(s=>`<div class="stat-card"><strong>${s.value}</strong><span>${s.label}</span></div>`).join('');
  $('#scores-list').innerHTML=records.length?[...records].sort((a,b)=>b.score-a.score).map(r=>{const t=TRACKS.find(t=>t.id===r.trackId);return `<div class="score-row"><span class="score-grade">${esc(r.grade)}</span><div><h3>${t.title}</h3><p>${modeById(r.mode).name} · ${difficultyById(r.difficulty).name} · ${r.maxCombo} COMBO</p></div><div class="score-value">${formatScore(r.score)}<small>${r.accuracy.toFixed(2)}% ACCURACY</small></div><button class="icon-btn" data-record-play="${t.id}" data-mode="${r.mode}" data-difficulty="${r.difficulty}" aria-label="再次挑战 ${t.title}">${icon('arrow-up-right')}</button></div>`;}).join(''):`<div class="empty-state">${icon('trophy')}<h3>你的第一份纪录，即将诞生。</h3><p>完成一首曲子，看看你能把连击延续多远。</p><button class="button primary" data-first-play>开始第一局 ${icon('arrow-right')}</button></div>`;
}
function route(){
  const requested=location.hash.slice(1);
  const page=['home','library','scores'].includes(requested)?requested:'home';
  $$('.view').forEach(v=>v.hidden=v.id!==`${page}-view`);
  $$('[data-nav]').forEach(n=>{const active=n.dataset.nav===page;n.classList.toggle('active',active);active?n.setAttribute('aria-current','page'):n.removeAttribute('aria-current');});
  if(page==='library')renderTracks();if(page==='scores')renderScores();
  window.scrollTo({top:0,behavior:'instant'});
}
function openSetup(trackId=chosenTrack.id,mode=chosenMode,difficulty=chosenDifficulty){
  stopPreview();chosenTrack=TRACKS.find(t=>t.id===trackId)||TRACKS[0];chosenMode=mode;chosenDifficulty=difficulty;
  renderSetup();if(!$('#play-dialog').open)$('#play-dialog').showModal();
}
function renderSetup(){
  const mode=modeById(chosenMode);
  $('#setup-cover').src=cover(chosenTrack);$('#setup-cover').alt=`${chosenTrack.title} 封面`;
  $('#setup-title').textContent=chosenTrack.title;$('#setup-meta').textContent=`${chosenTrack.bpm} BPM · ${durationLabel(chosenTrack)} · ${chosenTrack.genre}`;
  $('#setup-modes').innerHTML=MODES.map(m=>`<button class="segment ${chosenMode===m.id?'active':''}" data-select-mode="${m.id}" aria-pressed="${chosenMode===m.id}">${m.name}<small>${m.en}</small></button>`).join('');
  $('#setup-difficulties').innerHTML=DIFFICULTIES.map((d,i)=>`<button class="segment ${chosenDifficulty===d.id?'active':''}" data-select-difficulty="${d.id}" aria-pressed="${chosenDifficulty===d.id}">${d.name}<small>${d.label} / LV.${chosenTrack.difficulty[i]}</small></button>`).join('');
  $('#setup-help').innerHTML=`<div class="keycaps">${mode.keys.map(k=>`<kbd>${k}</kbd>`).join('')}</div><p>${mode.help}</p>`;
  const best=records.find(r=>r.trackId===chosenTrack.id&&r.mode===chosenMode&&r.difficulty===chosenDifficulty);
  $('#setup-best').textContent=best?`${formatScore(best.score)} / ${best.grade}`:'尚未挑战';
  $('#setup-preview').innerHTML=icon(previewId===chosenTrack.id?'pause':'play');
  $('#setup-preview').setAttribute('aria-label',previewId===chosenTrack.id?'停止试听':'试听音乐');
}
function stopPreview(resumeLobby=true){
  previewToken++;clearTimeout(previewTimer);previewAudio?.destroy();previewAudio=null;previewId=null;
  $$('.preview-btn').forEach(b=>{b.classList.remove('playing');b.innerHTML=icon('play');const t=TRACKS.find(t=>t.id===b.dataset.preview);if(t)b.setAttribute('aria-label',`试听 ${t.title}`);});
  $('#setup-preview').innerHTML=icon('play');$('#setup-preview').setAttribute('aria-label','试听音乐');
  if(resumeLobby)syncAudio();
}
async function togglePreview(track){
  if(previewId===track.id){stopPreview();return;}
  stopPreview(false);const token=previewToken;const audio=new RhythmAudio();previewAudio=audio;previewId=track.id;syncAudio();
  $$('.preview-btn').filter(b=>b.dataset.preview===track.id).forEach(b=>{b.classList.add('playing');b.innerHTML=icon('pause');b.setAttribute('aria-label',`停止试听 ${track.title}`);});
  if($('#play-dialog').open)renderSetup();
  try{await audio.unlock();audio.setVolume(musicVolume());await audio.load(track);if(token!==previewToken){audio.stop();return;}audio.play(2.4);renderMusicButtons();previewTimer=setTimeout(stopPreview,12000);}catch(error){if(token===previewToken){stopPreview();toast('音乐加载失败，请再试一次。');}console.error(error);}
}
function renderSettings(){
  $('#music-enabled').checked=settings.musicEnabled;$('#sfx-volume').value=Math.round(settings.sfxVolume*100);$('#sfx-volume-value').textContent=`${Math.round(settings.sfxVolume*100)}%`;
  $('#volume').value=Math.round(settings.volume*100);$('#volume-value').textContent=`${Math.round(settings.volume*100)}%`;
  $('#speed').value=settings.speed;$('#offset').value=settings.offset;$('#offset-value').textContent=`${settings.offset>0?'+':''}${settings.offset} ms`;
  $('#reduced-motion').checked=settings.reducedMotion;document.body.classList.toggle('reduced-motion',settings.reducedMotion);renderMusicButtons();
}
function openSettings(){stopPreview();renderSettings();$('#settings-dialog').showModal();}
function settingsChanged(){settings=normalizeSettings({volume:Number($('#volume').value)/100,sfxVolume:Number($('#sfx-volume').value)/100,musicEnabled:$('#music-enabled').checked,speed:Number($('#speed').value),offset:Number($('#offset').value),reducedMotion:$('#reduced-motion').checked});saveStorage('settings',settings);renderSettings();syncAudio();}
function showGameUI(){
  const mode=modeById(chosenMode);
  $('#app-shell').hidden=true;$('#game-screen').hidden=false;$('#pause-overlay').hidden=true;document.body.style.overflow='hidden';
  $('#game-title').textContent=chosenTrack.title;$('#game-subtitle').textContent=`${mode.en} / ${difficultyById(chosenDifficulty).label} · ${chosenTrack.bpm} BPM`;
  $('#hud-score').textContent='0000000';$('#hud-accuracy').textContent='100.00%';$('#game-progress-fill').style.width='0%';
  $('#game-pause').setAttribute('aria-label','暂停游戏');$('#game-pause').innerHTML=icon('pause');
  $('#game-key-hint').textContent=mode.keys.join('  /  ');
  const buttons=chosenMode==='keys'?['D','F','J','K'].map((key,i)=>({lane:i,label:key,cls:''})):chosenMode==='drum'?[{lane:0,label:'红 · F / J',cls:'red'},{lane:1,label:'蓝 · D / K',cls:'blue'}]:[{lane:0,label:'SPACE / 点击跟随节拍',cls:'wide'}];
  $('#touch-controls').innerHTML=buttons.map(b=>`<button class="touch-key ${b.cls}" data-lane="${b.lane}" aria-label="${b.label}">${b.label}</button>`).join('');
}
async function startGame(){
  if(gameStarting)return;
  gameStarting=true;saveStorage('lastSelection',{trackId:chosenTrack.id,mode:chosenMode,difficulty:chosenDifficulty});syncAudio();const startButton=$('#start-game');startButton.disabled=true;startButton.innerHTML='正在准备节拍…';
  stopPreview();game?.destroy();game=null;gameAudio?.destroy();gameAudio=null;
  if($('#result-dialog').open)$('#result-dialog').close();if($('#play-dialog').open)$('#play-dialog').close();
  showGameUI();
  gameAudio=new RhythmAudio();gameAudio.setVolume(musicVolume());gameAudio.setSfxVolume(settings.sfxVolume);
  game=new RhythmGame({canvas:$('#game-canvas'),audio:gameAudio,track:chosenTrack,mode:chosenMode,difficulty:chosenDifficulty,settings:{...settings,volume:musicVolume()},onUpdate:stats=>{
    $('#hud-score').textContent=String(Math.round(stats.score)).padStart(7,'0');
    $('#hud-accuracy').textContent=`${Number(stats.accuracy).toFixed(2)}%`;renderMusicButtons();$('#game-progress-fill').style.width=`${Math.max(0,Math.min(1,stats.progress))*100}%`;
  },onError:()=>toast('音频未能恢复，请再点一次继续游戏。'),onPause:paused=>{clearTouchFeedback();renderMusicButtons();$('#pause-overlay').hidden=!paused;$('#game-pause').setAttribute('aria-label',paused?'继续游戏':'暂停游戏');$('#game-pause').innerHTML=icon(paused?'play':'pause');if(paused)$('#resume-game').focus();else $('#game-canvas').focus({preventScroll:true});},onFinish:finishGame});
  try{await game.start();if(game)$('#game-canvas').focus({preventScroll:true});}catch(error){console.error(error);exitGame();toast('游戏音频准备失败，请重试或使用支持 Web Audio 的浏览器。');}
  finally{gameStarting=false;syncAudio();startButton.disabled=false;startButton.innerHTML=`准备好了，开始 ${icon('arrow-right')}`;}
}
function exitGame(){game?.destroy();game=null;gameAudio?.destroy();gameAudio=null;$('#game-screen').hidden=true;$('#pause-overlay').hidden=true;$('#app-shell').hidden=false;document.body.style.overflow='';clearTouchFeedback();route();syncAudio();}
function finishGame(result){
  const snapshot={...result,trackId:chosenTrack.id,mode:chosenMode,difficulty:chosenDifficulty,date:new Date().toISOString()};lastResult=snapshot;
  const existing=records.findIndex(r=>r.trackId===snapshot.trackId&&r.mode===snapshot.mode&&r.difficulty===snapshot.difficulty);
  const isBest=existing===-1||snapshot.score>records[existing].score;
  if(isBest){if(existing===-1)records.push(snapshot);else records[existing]=snapshot;saveStorage('records',records);}
  totalPlays++;saveStorage('totalPlays',totalPlays);
  // Let the current animation callback finish before destroying the engine.
  queueMicrotask(()=>{exitGame();$('#result-grade').textContent=result.grade;$('#result-title').textContent=chosenTrack.title;$('#result-subtitle').textContent=`${modeById(chosenMode).name} · ${difficultyById(chosenDifficulty).name}`;$('#new-best').hidden=!isBest||result.score===0;$('#result-score').textContent=formatScore(result.score);$('#result-accuracy').textContent=`${result.accuracy.toFixed(2)}%`;$('#result-combo').textContent=result.maxCombo;$('#result-perfect').textContent=result.perfect;$('#result-good').textContent=result.good;$('#result-miss').textContent=result.miss;renderTiming(result.timing,result.accuracy);$('#result-dialog').showModal();$('#result-dialog').scrollTop=0;$('#result-title').focus({preventScroll:true});renderScores();});
}

document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.close){$('#'+target.dataset.close).close();return;}
  if(target.dataset.modeCard){openSetup(TRACKS[0].id,target.dataset.modeCard);return;}
  if(target.dataset.play){openSetup(target.dataset.play);return;}
  if(target.dataset.recordPlay){openSetup(target.dataset.recordPlay,target.dataset.mode,target.dataset.difficulty);return;}
  if(target.dataset.favorite){const id=target.dataset.favorite;favorites.has(id)?favorites.delete(id):favorites.add(id);saveStorage('favorites',[...favorites]);renderTracks();return;}
  if(target.dataset.preview){togglePreview(TRACKS.find(t=>t.id===target.dataset.preview));return;}
  if(target.dataset.selectMode){chosenMode=target.dataset.selectMode;renderSetup();return;}
  if(target.dataset.selectDifficulty){chosenDifficulty=target.dataset.selectDifficulty;renderSetup();return;}
  if(target.dataset.filter){filter=target.dataset.filter;$$('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));renderTracks();return;}
  if(target.hasAttribute('data-reset-search')){$('#track-search').value='';filter='all';$$('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));renderTracks();return;}
  if(target.hasAttribute('data-first-play'))openSetup();
});
$('#quick-play').addEventListener('click',()=>openSetup());
$('#explore-modes').addEventListener('click',()=>$('#modes-section').scrollIntoView({behavior:settings.reducedMotion?'instant':'smooth',block:'start'}));
$('#track-search').addEventListener('input',renderTracks);
$('#settings-button').addEventListener('click',openSettings);$('#tip-settings').addEventListener('click',openSettings);
['volume','sfx-volume','music-enabled','speed','offset','reduced-motion'].forEach(id=>$('#'+id).addEventListener('input',settingsChanged));
$('#reset-settings').addEventListener('click',()=>{settings={...DEFAULTS};saveStorage('settings',settings);renderSettings();syncAudio();toast('已恢复默认设置');});
$('#setup-preview').addEventListener('click',()=>togglePreview(chosenTrack));
$('#start-game').addEventListener('click',startGame);
$('#play-dialog').addEventListener('close',stopPreview);
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();}}));
$('#game-pause').addEventListener('click',()=>{if(gameStarting)return;if($('#pause-overlay').hidden)game?.pause();else game?.resume();});
$('#game-back').addEventListener('click',()=>{if(!gameStarting)game?.pause();});
$('#resume-game').addEventListener('click',()=>game?.resume());
$('#restart-game').addEventListener('click',startGame);
$('#leave-game').addEventListener('click',()=>{exitGame();location.hash='home';});
$('#result-retry').addEventListener('click',()=>{if(lastResult){chosenTrack=TRACKS.find(t=>t.id===lastResult.trackId);chosenMode=lastResult.mode;chosenDifficulty=lastResult.difficulty;}startGame();});
$('#result-settings').addEventListener('click',()=>{$('#result-dialog').close();openSettings();});
$('#music-toggle').addEventListener('click',toggleMusic);$('#game-music').addEventListener('click',toggleMusic);
$('#result-library').addEventListener('click',()=>{$('#result-dialog').close();location.hash='library';route();});
$('#touch-controls').addEventListener('pointerdown',e=>{const button=e.target.closest('[data-lane]');if(!button||gameStarting||game?.state!=='running')return;e.preventDefault();game?.input(Number(button.dataset.lane));button.classList.add('pressed');button.setPointerCapture(e.pointerId);});
['pointerup','pointercancel','lostpointercapture'].forEach(name=>$('#touch-controls').addEventListener(name,e=>{e.target.closest('[data-lane]')?.classList.remove('pressed');}));
window.addEventListener('hashchange',()=>{if(game)exitGame();stopPreview();route();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTouchFeedback();stopPreview(false);}syncAudio();});
window.addEventListener('blur',clearTouchFeedback);
const wakeMusic=event=>{if(event.isTrusted&&!event.repeat)void menuMusic.start();};
document.addEventListener('pointerdown',wakeMusic,{passive:true});document.addEventListener('keydown',wakeMusic);
window.addEventListener('pagehide',()=>{pageActive=false;stopPreview(false);if(game)exitGame();syncAudio();});
window.addEventListener('pageshow',()=>{pageActive=true;syncAudio();});
hydrateIcons();renderModes();renderTracks();renderScores();renderSettings();route();syncAudio();
