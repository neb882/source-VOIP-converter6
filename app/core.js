/* =========================================================================
 * TF2 Voice Emulator — app/core.js
 *
 * The page's interface code: console, cvars, game-event simulator, source
 * loading, rendering and downloads, meter, real-take check, visualizer,
 * net_graph and boot. All heavy audio lives in audio.js.
 *
 * It is split into page scripts in app/, loaded in order by index.html
 * (core, console, source, render, meter, realtake, visualizer, netgraph,
 * boot). They are classic scripts sharing their top-level names, as when
 * they were one file (script.js); code that runs at load time only uses
 * what an earlier file or its own defines.
 *
 * Depends on globals defined by constants.js + audio.js:
 *   TF2_DATA, PRESETS, CODEC_PROFILES, VOICE_ENGINE, DSP_PRESETS,
 *   LISTENER_POSITIONS, ENV_ALIAS, FCVAR, TF2Audio
 * =========================================================================
 */


/* ------------------------------------------------------------------ */
/* Element cache                                                      */
/* ------------------------------------------------------------------ */

const els = {
  file:      document.getElementById('file'),
  mic:       document.getElementById('mic'),
  process:   document.getElementById('process'),
  cancel:    document.getElementById('cancel-process'),
  dl:        document.getElementById('download'),
  dlVideo:   document.getElementById('download-video'),
  format:    document.getElementById('format'),
  status:    document.getElementById('source-status'),
  progress:  document.getElementById('process-progress'),
  advancedToggle: document.getElementById('advanced-toggle'),
  consoleDetails: document.getElementById('console-details'),
  audio:     document.getElementById('preview'),
  audioDry:  document.getElementById('preview-dry'),
  vizWave:   document.getElementById('viz-wave'),
  vizBars:   document.getElementById('viz-bars'),
  vizSpec:   document.getElementById('viz-spec'),
  canvas:    document.getElementById('visualizer'),
  codec:     document.getElementById('codec'),
  position:  document.getElementById('listener_position'),
  gain:      document.getElementById('gain'),
  voiceScale:document.getElementById('voice_scale'),
  env:       document.getElementById('env'),
  customEnv: document.getElementById('custom-env'),
  controls:  document.getElementById('controls-wrapper'),
  conOut:    document.getElementById('console-out'),
  conIn:     document.getElementById('console-input'),
  conHint:   document.getElementById('console-hint'),
  conComplete: document.getElementById('console-complete'),
  chain:     document.getElementById('signal-chain'),
  ng:        document.getElementById('net-graph'),
  ngFps:     document.getElementById('ng-fps'),
  ngPing:    document.getElementById('ng-ping'),
  ngLerp:    document.getElementById('ng-lerp'),
  ngFill:    document.getElementById('ng-fill'),
  ngLoss:    document.getElementById('ng-loss-val'),
  ngIn:      document.getElementById('ng-in'),
  ngOut:     document.getElementById('ng-out'),
  abToggle:  document.getElementById('ab-toggle'),
  hp:        document.getElementById('hp'),
  lp:        document.getElementById('lp'),
  bits:      document.getElementById('bits'),
  agc:       document.getElementById('agc'),
  retime:    document.getElementById('retime'),
  maxGain:   document.getElementById('maxgain'),
  avgGain:   document.getElementById('avggain'),
  vad:       document.getElementById('vad'),
  captureChannel: document.getElementById('capture_channel'),
  vadThreshold: document.getElementById('vad_threshold'),
  volume:    document.getElementById('volume'),
  loss:      document.getElementById('loss'),
  jitter:    document.getElementById('jitter'),
  frameMs:   document.getElementById('frameMs'),
  warble:    document.getElementById('warble_on'),
  cDur:      document.getElementById('c_dur'),
  cDec:      document.getElementById('c_dec'),
  cMix:      document.getElementById('c_mix')
};

const state = {
  lastBlob: null,        // URL for processed wav
  lastWav: null,         // Blob of the processed wav (the download master)
  lastExports: {},       // format -> Promise<{ blob, crc }> made from lastWav
  lastCodecKey: 'steam', // codec profile of the last render (download name)
  dryBlob: null,         // URL for original source (for A/B)
  processedBuffer: null, // Float32Array of last processed samples
  processedRate: null,
  decodedSource: null,   // AudioBuffer of the decoded source file
  decodeCtx: null,       // shared AudioContext used only for decodeAudioData
  audioCtx: null,
  analyser: null,
  sourceNode: null,
  isPlaying: false,
  animationId: null,
  sv_cheats: 0,
  godMode: false,
  noclip: false,
  cmdHistory: [],
  cmdIndex: -1,
  mapName: 'cp_process',
  isConnected: true,
  simEnabled: true,
  abMode: 'wet',         // 'wet' or 'dry'
  vizMode: 'wave',       // 'wave', 'bars' or 'spec' (spectrogram)
  renderId: 0,           // invalidates cached visualizer images per render
  lastCodecInfo: null,   // codec statistics of the last render (net_graph)
  sourceName: null,      // name of the loaded clip (file or mic)
  sourceVideo: null,     // the MP4/MOV the clip came from: { bytes, name, info } (video.js)
  recorder: null,        // active PCM capture session
  recTick: null,         // recording timer interval
  processing: false,
  batchRunning: false,   // batch.js is rendering its queue
  processId: 0,
  cancelProcessing: null
};

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;   // a video's audio is small; its picture is copied, not decoded
const MAX_AUDIO_SECONDS = 10 * 60;
const MAX_RECORDING_SECONDS = 5 * 60;

/* ------------------------------------------------------------------ */
/* Game-event simulator (unchanged in behavior, reorganised slightly) */
/* ------------------------------------------------------------------ */

class SourceSimulator {
  constructor(logCallback) {
    this.log = logCallback;
    this.isActive = false;
    this.timer = 0;
    this.players = [];
    this.maxPlayers = 24;
    for (let i = 0; i < 16; i++) this.addPlayer(true);
  }
  start() { if (this.isActive) return; this.isActive = true; this.schedule(); }
  stop()  { this.isActive = false; clearTimeout(this.timer); }
  schedule() {
    if (!this.isActive) return;
    this.timer = setTimeout(() => { this.processTick(); this.schedule(); }, 600 + Math.random() * 3200);
  }
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  count(team) { return this.players.filter(p => p.team === team).length; }
  addPlayer(silent = false) {
    if (this.players.length >= this.maxPlayers) return;
    const taken = new Set(this.players.map(p => p.name));
    const pool = TF2_DATA.playerNames.filter(n => !taken.has(n));
    if (!pool.length) return;
    // Autobalance-ish: new players join the smaller team.
    const team = this.count('RED') <= this.count('BLU') ? 'RED' : 'BLU';
    const player = { name: this.pick(pool), team };
    this.players.push(player);
    if (!silent) {
      this.log(`${player.name} connected`, 'text');
      setTimeout(() => { if (this.players.includes(player)) this.log(`Player ${player.name} joined team ${team}`, team === 'RED' ? 'red' : 'blu'); }, 900);
    }
  }
  removePlayer() {
    if (this.players.length <= 8) return;
    const i = Math.floor(Math.random() * this.players.length);
    const [player] = this.players.splice(i, 1);
    const reason = this.pick(['Disconnect by user.', 'Disconnect by user.', 'timed out', 'Kicked by Console : You have been voted off',
      'Client left game (Steam auth ticket has been canceled)']);
    this.log(`Dropped ${player.name} from server (${reason})`, 'text');
  }
  triggerKill() {
    const red = this.players.filter(p => p.team === 'RED'), blu = this.players.filter(p => p.team === 'BLU');
    if (!red.length || !blu.length) return;
    const [killer, victim] = Math.random() < 0.5 ? [this.pick(red), this.pick(blu)] : [this.pick(blu), this.pick(red)];
    const isCrit = Math.random() > 0.85;
    this.log(`${killer.name} killed ${victim.name} with ${this.pick(TF2_DATA.weapons)}.${isCrit ? ' (crit)' : ''}`, 'text');
  }
  triggerSuicide() {
    if (!this.players.length) return;
    const who = this.pick(this.players).name;
    this.log(Math.random() < 0.5 ? `${who} suicided.` : `${who} bid farewell, cruel world!`, 'text');
  }
  triggerChat() {
    if (!this.players.length) return;
    const player = this.pick(this.players);
    // TF2 order: *DEAD*(TEAM) Name :  message
    const prefix = `${Math.random() > 0.7 ? '*DEAD*' : ''}${Math.random() > 0.8 ? '(TEAM)' : ''}`;
    this.log(`${prefix}${prefix ? ' ' : ''}${player.name} :  ${this.pick(TF2_DATA.chat)}`, 'text');
  }
  triggerError()  { this.log(this.pick(TF2_DATA.errors), 'err'); }
  triggerSystem() { this.log(this.pick(TF2_DATA.system), 'text'); }
  triggerAchievement() {
    if (!this.players.length) return;
    this.log(`${this.pick(this.players).name} has earned the achievement ${this.pick(TF2_DATA.achievements)}`, 'ach');
  }
  triggerItem() {
    if (!this.players.length) return;
    this.log(`${this.pick(this.players).name} has found: ${this.pick(TF2_DATA.items)}`, 'item');
  }
  processTick() {
    const r = Math.random();
    if      (r < 0.04) this.addPlayer();
    else if (r < 0.07) this.removePlayer();
    else if (r < 0.37) this.triggerKill();
    else if (r < 0.41) this.triggerSuicide();
    else if (r < 0.64) this.triggerChat();
    else if (r < 0.68) this.triggerError();
    else if (r < 0.72) this.triggerAchievement();
    else if (r < 0.76) this.triggerItem();
    else if (r < 0.80) this.triggerSystem();
  }
}

const simulator = new SourceSimulator((text, type) => logLine(text, type));
