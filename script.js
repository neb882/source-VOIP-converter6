/* =========================================================================
 * TF2 Voice Emulator — script.js
 *
 * UI glue: console, cvars, game-event simulator, visualizer, netgraph, boot.
 * All heavy audio lives in audio.js; this file is "the chrome around it".
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
  recorder: null,        // active PCM capture session
  recTick: null,         // recording timer interval
  processing: false,
  batchRunning: false,   // batch.js is rendering its queue
  processId: 0,
  cancelProcessing: null
};

const MAX_FILE_BYTES = 100 * 1024 * 1024;
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

/* ------------------------------------------------------------------ */
/* Console utilities                                                  */
/* ------------------------------------------------------------------ */

function logLine(text, type = 'text') {
  const div = document.createElement('div');
  div.className = `c-${type}`;
  div.textContent = String(text == null ? '' : text);
  const isAtBottom = (els.conOut.scrollHeight - els.conOut.scrollTop - els.conOut.clientHeight) < 50;
  els.conOut.appendChild(div);
  // Finite scrollback: keeps the DOM light during long simulator sessions
  // (matters on mobile).
  while (els.conOut.childElementCount > 600) els.conOut.firstElementChild.remove();
  if (isAtBottom) els.conOut.scrollTop = els.conOut.scrollHeight;
}

/**
 * Tokenize with "rest" semantics Source-engine-style:
 *   say hello world         -> ['say', 'hello world']
 *   echo "a b c" d          -> ['echo', '"a b c" d']  (chat-style: rest preserved)
 *   dsp_room 7              -> ['dsp_room', '7']
 * First token is the command; everything after the first whitespace run is
 * returned as-is in args[1]. Quoted tokens are stripped of quotes for the
 * first arg when the rest is a single quoted string.
 */
function tokenize(str) {
  const trimmed = str.trim();
  if (!trimmed) return [];
  const m = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!m) return [trimmed];
  const cmd = m[1];
  let rest = m[2];
  if (rest && /^"[^"]*"$/.test(rest)) rest = rest.slice(1, -1);
  return rest !== undefined ? [cmd, rest] : [cmd];
}

function normalizeControlValue(el, raw) {
  if (!el || raw == null) return null;
  const value = String(raw).trim();
  if (el.tagName === 'SELECT') {
    return Array.from(el.options).some((option) => option.value === value) ? value : null;
  }
  if (el.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const min = el.min === '' ? -Infinity : Number(el.min);
    const max = el.max === '' ? Infinity : Number(el.max);
    return String(Math.min(max, Math.max(min, number)));
  }
  return value;
}

function showAdvanced(show) {
  document.body.classList.toggle('advanced', !!show);
  if (els.advancedToggle) {
    els.advancedToggle.setAttribute('aria-expanded', String(!!show));
    els.advancedToggle.textContent = show ? 'Hide advanced controls' : 'Show advanced controls';
  }
}

function setStatus(message, kind = '') {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.className = `source-status${kind ? ' ' + kind : ''}`;
}

/* ------------------------------------------------------------------ */
/* CVAR system                                                        */
/* ------------------------------------------------------------------ */

const cvars = {
  'help': {
    help: 'Show console help', usage: 'help [cvar]',
    action: (v) => {
      if (v) {
        const c = cvars[v.toLowerCase()];
        if (!c) return logLine(`help: no cvar or command named "${v}"`, 'err');
        logLine(`"${v.toLowerCase()}"`, 'cmd');
        if (c.help)  logLine(` - ${c.help}`, 'help');
        if (c.usage) logLine(` - usage: ${c.usage}`, 'help');
        return;
      }
      logLine('--- CONSOLE HELP ---', 'sys');
      logLine('Format: command [argument] — chain with ; like "voice_scale 0.5; dsp_room 7"');
      logLine('"find <string>"    – search for commands');
      logLine('"help <cvar>"      – detail for one command');
      logLine('"alias <n> <cmds>" – define a command alias');
      logLine('"cvarlist"          – list every command');
      logLine('"exec preset_modern" – quick-apply a preset');
    }
  },
  'cvarlist': { help: 'List all available console commands', action: printCvarList },
  'alias': {
    help: 'Create a command alias', usage: 'alias <name> "<commands>"',
    action: (v) => {
      if (!v) {
        const keys = Object.keys(aliases);
        if (!keys.length) return logLine('No aliases defined.', 'text');
        keys.forEach(k => logLine(`${k.padEnd(18)} : ${aliases[k]}`, 'text'));
        return;
      }
      const m = /^(\S+)\s+(.*)$/.exec(v);
      if (!m) return logLine('Usage: alias <name> "<commands>"', 'err');
      let body = m[2].trim();
      if (/^".*"$/.test(body)) body = body.slice(1, -1);
      aliases[m[1].toLowerCase()] = body;
      logLine(`alias "${m[1]}" = "${body}"`, 'val');
    }
  },
  'toggle': {
    help: 'Cycle a cvar between values (default 0/1)', usage: 'toggle <cvar> [v1 v2 ...]',
    action: (v) => {
      if (!v) return logLine('Usage: toggle <cvar> [v1 v2 ...]', 'err');
      const parts = v.split(/\s+/);
      const name = parts[0].toLowerCase();
      const target = cvars[name];
      if (!target) return logLine(`toggle: unknown cvar "${name}"`, 'err');
      const values = parts.length > 1 ? parts.slice(1) : ['0', '1'];
      let cur = '';
      if (target.link) {
        const el = document.getElementById(target.link);
        cur = el ? String(el.value) : '';
      } else if (target.val !== undefined) cur = String(target.val);
      const next = values[(values.indexOf(cur) + 1) % values.length];
      execCommand(`${name} ${next}`, false, 1);
    }
  },
  'net_jitter': {
    help: 'Alias of net_fakejitter',
    action: (v) => { if (v !== undefined) execCommand(`net_fakejitter ${v}`); else execCommand('net_fakejitter'); }
  },
  '+voicerecord': { help: 'Start microphone capture', action: () => startRecord() },
  '-voicerecord': { help: 'Stop microphone capture and mount the clip', action: () => stopRecord() },
  'writeconfig':  { help: 'Copy a shareable settings URL to the clipboard', action: () => writeConfig() },
  'preset_save':   { help: 'Save current settings under a name', usage: 'preset_save <name>',   action: (v) => savePreset(v) },
  'preset_load':   { help: 'Load a saved preset',                usage: 'preset_load <name>',   action: (v) => loadPreset(v) },
  'preset_list':   { help: 'List saved presets',                                                 action: () => listPresets() },
  'preset_delete': { help: 'Delete a saved preset',              usage: 'preset_delete <name>', action: (v) => deletePreset(v) },
  'find': {
    help: 'Find console commands by name',
    usage: 'find <string>',
    action: (v) => {
      if (!v) return logLine("Usage: find <string>", "err");
      logLine(`Searching for: ${v}`, 'sys');
      Object.keys(cvars).filter(k => k.includes(v.toLowerCase())).forEach(k => {
        logLine(`${k.padEnd(25)} : ${cvars[k].help || ''}`, 'text');
      });
    }
  },
  'clear':   { help: 'Clear the console output', action: () => els.conOut.replaceChildren() },
  'echo':    { help: 'Echo text to console', usage: 'echo <text>', action: (v) => logLine(v || "") },
  'status':  { help: 'Display map and connection status', action: printStatus },

  'disconnect': {
    help: 'Disconnect from server',
    action: () => {
      if (!state.isConnected) return logLine("Already disconnected.", "err");
      logLine('Disconnect: Client disconnect');
      state.isConnected = false;
      els.audio.pause();
    }
  },
  'connect': {
    help: 'Connect to a server', usage: 'connect <ip>',
    action: (v) => {
      if (state.isConnected) logLine('Disconnect: Client disconnect');
      state.isConnected = false;
      logLine(`Connecting to ${v || "127.0.0.1:27015"}...`, 'sys');
      setTimeout(() => logLine("Connected to server.", 'sys'), 800);
      setTimeout(() => logLine("Sending client info...", 'sys'), 1200);
      setTimeout(() => { logLine("Entered the game", 'sys'); state.isConnected = true; }, 1600);
    }
  },
  'retry':    { help: 'Retry connection to last server', action: () => cvars['connect'].action('last_server') },
  'quit': {
    help: 'Exit the engine',
    action: () => {
      logLine('Engine Error: ED_Alloc: no free edicts', 'err');
      setTimeout(() => {
        const crash = document.createElement('div');
        crash.style.cssText = 'color:#fff;text-align:center;margin-top:20%;';
        const heading = document.createElement('h1');
        heading.textContent = 'hl2.exe has stopped working';
        const message = document.createElement('p');
        message.textContent = 'Windows is checking for a solution to the problem... (refresh to restart)';
        crash.append(heading, message);
        document.body.replaceChildren(crash);
      }, 1000);
    }
  },
  'exec':       { help: 'Execute a preset config', usage: 'exec <filename>', action: runPreset },
  'screenshot': {
    help: 'Save visualizer to file',
    action: () => {
      const link = document.createElement('a');
      link.download = `tf2_viz_${Date.now()}.png`;
      link.href = els.canvas.toDataURL();
      link.click();
      logLine(`Wrote ${link.download}`, 'sys');
    }
  },
  'sv_cheats': {
    val: 0, help: 'Enable cheats/dev limits', flags: FCVAR.SERVER,
    action: (v) => {
      state.sv_cheats = parseInt(v) || 0;
      if (state.sv_cheats === 1) {
        els.gain.removeAttribute('max');
        els.loss.removeAttribute('max');
        els.voiceScale.removeAttribute('max');
        els.voiceScale.setAttribute('max', '4');
        logLine('Dev limits removed. God speed.');
      } else {
        els.gain.setAttribute('max', '5.0');
        els.loss.setAttribute('max', '60');
        els.voiceScale.setAttribute('max', '2.0');
        logLine('Cheats disabled.');
      }
    }
  },
  'sv_simulate_events': {
    val: 1, help: 'Toggle background game event simulation',
    action: (v) => {
      const on = parseInt(v) === 1;
      state.simEnabled = on;
      if (on) { simulator.start(); logLine("Game event simulation enabled.", "sys"); }
      else    { simulator.stop();  logLine("Game event simulation disabled.", "sys"); }
    }
  },

  /* === Cheat commands (tricks for fun) === */
  'god':     { help: 'Toggle god mode', flags: FCVAR.CHEAT, action: () => { state.godMode = !state.godMode; logLine(state.godMode ? 'godmode ON' : 'godmode OFF', 'sys'); } },
  'noclip':  { help: 'Toggle noclip movement', flags: FCVAR.CHEAT, action: () => { state.noclip = !state.noclip; logLine(state.noclip ? 'noclip ON' : 'noclip OFF', 'sys'); } },
  'impulse': { help: 'Cheat commands (101=health/ammo)', flags: FCVAR.CHEAT, action: (v) => { if (v === '101') logLine('HEV Suit: Health and Ammo full.', 'val'); else logLine(`Impulse ${v} not handled`, 'text'); } },
  'ent_create': {
    help: 'Create an entity', flags: FCVAR.CHEAT,
    action: () => {
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${Math.random()*80+10}%;top:${Math.random()*80+10}%;font-size:40px;pointer-events:none;z-index:100;`;
      el.style.transition = 'opacity 3s';
      el.innerText = ['📦', '⚠️', '👾', '💥'][Math.floor(Math.random() * 4)];
      document.body.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '0'; });
      setTimeout(() => el.remove(), 3100);
      logLine('Created entity info_target at origin', 'sys');
    }
  },
  'mat_fullbright': {
    help: 'Toggle fullbright mode', flags: FCVAR.CHEAT,
    action: (v) => {
      if (v === '1') { document.body.style.filter = 'brightness(1.5) contrast(1.2)'; logLine('mat_fullbright 1', 'sys'); }
      else           { document.body.style.filter = '';                                logLine('mat_fullbright 0', 'sys'); }
    }
  },
  'thirdperson': { help: 'Third person camera', flags: FCVAR.CHEAT, action: () => { els.canvas.style.transform = 'rotateX(180deg) rotateY(180deg)'; logLine('Camera: Third Person', 'sys'); } },
  'firstperson': { help: 'First person camera', action: () => { els.canvas.style.transform = ''; logLine('Camera: First Person', 'sys'); } },
  'unbindall':   { help: 'Unbind all keys', action: () => logLine('Key bindings removed.', 'sys') },
  'kill': {
    help: 'Suicide',
    action: () => {
      if (isFinite(els.audio.duration) && els.audio.duration > 0) { els.audio.pause(); els.audio.currentTime = els.audio.duration; }
      logLine('Player died.', 'warn');
    }
  },
  'explode': { help: 'Suicide with style', action: () => cvars['kill'].action() },
  'say':     { help: 'Display player message', usage: 'say <text>', action: (v) => { if (v) logLine(`Player :  ${v}`, 'text'); } },
  'map': {
    help: 'Set map name', usage: 'map <name>',
    action: (v) => { if (v) { logLine(`CModelLoader::Map_IsValid: '${v}' is not a valid map`, 'warn'); setTimeout(() => { state.mapName = v; logLine(`Changing level to ${v}...`, 'sys'); }, 500); } }
  },
  'changelevel': { help: 'Change map', action: (v) => cvars['map'].action(v) },

  /* === Net graph === */
  'net_graph': {
    val: 0, help: 'Draw the network usage graph (0-4)',
    action: (v) => {
      const level = parseInt(v);
      if (isNaN(level) || level < 0) return;
      els.ng.style.display = (level > 0) ? 'block' : 'none';
      els.ng.className = '';
      if (level > 0) els.ng.classList.add(`ng-level-${Math.min(level, 4)}`);
    }
  },

  /* === Audio playback === */
  'play':    { help: 'Start playback',   action: () => { if (els.audio.src) els.audio.play().catch(e => logLine(e.message, 'err')); else logLine('No audio loaded.', 'err'); } },
  'stop':    { help: 'Stop playback',    action: () => { els.audio.pause(); els.audio.currentTime = 0; } },
  'restart': { help: 'Restart playback', action: () => { els.audio.currentTime = 0; els.audio.play().catch(() => {}); } },

  /* === Linked cvars (mirror a DOM input) === */
  'voice_micgain':   { help: 'Sender capture gain; above 1 clips the int16 capture', link: 'gain' },
  'voice_scale':     { help: 'Receiver voice scale, applied inside the auto-gain (more = more clipping)', link: 'voice_scale' },
  'voice_agc':       { help: 'Receiver auto-gain with int16 clamp (0 = unity gain)', link: 'agc' },
  'voice_maxgain':   { help: 'Auto-gain cap (TF2 default 10)', link: 'maxgain' },
  'voice_avggain':   { help: 'Auto-gain normalizes each block between its mean (0) and peak (1) to full scale; 0.5 = TF2 default', link: 'avggain' },
  'voice_capture_channel': { help: 'Stereo input to the mono mic: left (measured through a virtual cable) / mix / right', link: 'capture_channel' },
  'voice_vad':       { help: 'Steam sender voice gate: auto (profile default) / 1 / 0', link: 'vad' },
  'voice_vad_threshold': { help: 'Gate opening level: 20 ms frame RMS in dBFS (measured -39.5); 120 ms pre-roll, 440 ms hold', link: 'vad_threshold' },
  'volume':          { help: 'Output volume of the rendered file (0.0 - 1.0)', link: 'volume' },
  'dsp_hpf':         { help: 'Optional sender high-pass cutoff (0 = off)', link: 'hp' },
  'dsp_lpf':         { help: 'Optional sender low-pass cutoff (20000 = off)', link: 'lp' },
  'snd_bits':        { help: 'Codec bitrate scale (16 = profile bitrate)', link: 'bits' },
  'net_fakeloss':    { help: 'Voice frames lost %, in bursts of ~2.2 frames concealed by Opus (TF2 net_fakeloss 5/10/15 on a listen server lost ~22/45/64%)', link: 'loss' },
  'net_fakejitter':  { help: 'Network jitter in ms: late voice frames, 3.2% at 50 ms, one in ten played as silence', link: 'jitter' },
  'net_split':       { help: 'Packet grouping in ms (whole 20 ms frames)', link: 'frameMs' },
  'snd_codec':       { help: 'Run the codec (0 = bypass; filters and receiver remain)', link: 'warble_on' },
  'sv_voicecodec':   {
    help: 'Voice codec (celt_22 / celt_44 / steam / steam_48 / speex)',
    link: 'codec',
    normalize: (v) => CODEC_PROFILES[v] ? v : null
  },
  'listener_position': {
    help: 'Listener position (open/tunnel/hallway/...)',
    link: 'listener_position',
    normalize: (v) => (v === 'manual' || LISTENER_POSITIONS[v]) ? v : null,
    action: (v) => {
      if (v === 'manual') showAdvanced(true);
      else if (v && LISTENER_POSITIONS[v]) {
        logLine(` - ${LISTENER_POSITIONS[v].label}: ${LISTENER_POSITIONS[v].notes}`, 'help');
      }
    }
  },
  'dsp_custom_time':  { link: 'c_dur', help: 'Custom reverb duration (s)' },
  'dsp_custom_decay': { link: 'c_dec', help: 'Custom reverb decay' },
  'dsp_custom_mix':   { link: 'c_mix', help: 'Custom reverb mix %' },
  'dsp_room': {
    help: 'Source dsp_room preset id (0-29, 99 = custom)',
    link: 'env',
    normalize: (v) => {
      let id = v;
      if (ENV_ALIAS[String(v).toLowerCase()] !== undefined) id = ENV_ALIAS[String(v).toLowerCase()];
      id = parseInt(id, 10);
      return DSP_PRESETS[id] ? String(id) : null;
    },
    action: (v) => {
      if (v == null) return;
      const id = parseInt(v, 10);
      els.customEnv.style.display = (id === 99) ? 'block' : 'none';
      // Setting dsp_room manually implies you're taking control away from
      // the listener-position preset, so flip the dropdown to "manual".
      els.position.value = 'manual';
      showAdvanced(true);
    }
  }
};

// Reverse map: <input id> → cvar name (used by the 'change' handler)
const idToCvarMap = {};
Object.keys(cvars).forEach(k => { if (cvars[k].link) idToCvarMap[cvars[k].link] = k; });

/* ------------------------------------------------------------------ */
/* Command dispatch                                                   */
/* ------------------------------------------------------------------ */

// User-defined aliases (Source `alias` command)
const aliases = {};

// Split a command line on ';' separators, respecting double quotes.
function splitCommands(str) {
  const parts = [];
  let cur = '', quoted = false;
  for (const ch of str) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

function execCommand(rawStr, isFromGui = false, depth = 0) {
  if (!rawStr || !rawStr.trim()) return;
  if (depth > 8) { logLine('exec/alias recursion too deep.', 'err'); return; }

  if (depth === 0) {
    if (!isFromGui) logLine(`] ${rawStr}`);
    else            logLine(`] ${rawStr} (gui_msg)`, 'help');
  }

  // Source consoles execute ';'-separated commands in order.
  const parts = splitCommands(rawStr);
  if (parts.length > 1) {
    parts.forEach(p => execCommand(p, isFromGui, depth + 1));
    return;
  }

  const tokens = tokenize(parts[0]);
  const cmdName = tokens[0].toLowerCase();
  const arg = tokens.length > 1 ? tokens[1] : undefined;

  const cvar = cvars[cmdName];
  if (!cvar) {
    if (aliases[cmdName]) { execCommand(aliases[cmdName], isFromGui, depth + 1); return; }
    logLine(`Unknown command "${cmdName}"`, 'err');
    if (cmdName.length >= 3) {
      const near = Object.keys(cvars).filter(k => k.startsWith(cmdName.slice(0, 3))).slice(0, 3);
      if (near.length) logLine(` - did you mean: ${near.join(', ')}?`, 'help');
    }
    return;
  }

  if ((cvar.flags & FCVAR.CHEAT) && state.sv_cheats === 0) {
    logLine(`Command "${cmdName}" requires sv_cheats 1.`, 'err');
    return;
  }

  if (cvar.link) {
    const el = document.getElementById(cvar.link);
    if (!el) { if (cvar.action) cvar.action(arg); return; }
    if (arg !== undefined) {
      const normalized = cvar.normalize ? cvar.normalize(arg) : normalizeControlValue(el, arg);
      if (normalized == null) {
        logLine(`${cmdName}: invalid value "${arg}"; keeping "${el.value}"`, 'err');
        return;
      }
      if (el.value !== normalized) el.value = normalized;
      if (cvar.action) cvar.action(normalized);
      logLine(`"${cmdName}" = "${normalized}"`, 'val');
      updateSignalChain();
    } else {
      logLine(`"${cmdName}" = "${el.value}"`, 'text');
      if (cvar.help) logLine(` - ${cvar.help}`, 'help');
    }
    return;
  }

  if (cvar.action) {
    cvar.action(arg);
    if (cvar.val !== undefined && arg !== undefined) { cvar.val = arg; logLine(`"${cmdName}" = "${arg}"`, 'val'); }
    else if (cvar.val !== undefined && arg === undefined) { logLine(`"${cmdName}" = "${cvar.val}"`, 'text'); if (cvar.help) logLine(` - ${cvar.help}`, 'help'); }
  }
}
window.execCommand = execCommand;

els.controls.addEventListener('change', (e) => {
  const target = e.target;
  if (idToCvarMap[target.id]) {
    const cmd = idToCvarMap[target.id];
    execCommand(`${cmd} ${target.value}`, true);
  }
  // A hand-edited control no longer matches any quick preset.
  setActivePreset(null);
  updateSignalChain();
});

function setActivePreset(name) {
  document.querySelectorAll('.preset-row .preset-btn').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === name));
  });
}

// Live, human-readable summary of the voice path the next render will use.
function updateSignalChain() {
  if (!els.chain) return;
  const codec = CODEC_PROFILES[els.codec.value] || CODEC_PROFILES.steam;
  const num = (el, fallback) => { const v = Number(el.value); return Number.isFinite(v) ? v : fallback; };
  const gain = num(els.gain, 1), bits = num(els.bits, 16), loss = num(els.loss, 0), jitter = num(els.jitter, 0);
  const maxGain = num(els.maxGain, VOICE_ENGINE.autoGain.maxGain), volume = num(els.volume, VOICE_ENGINE.volume);
  const codecOn = els.warble.value === '1', agcOn = els.agc.value === '1';
  const gateOn = codecOn && (els.vad.value === 'auto' ? !!codec.senderGate : els.vad.value === '1');
  const gateDb = num(els.vadThreshold, -39.5);
  const stereoIn = !!(state.decodedSource && state.decodedSource.left);
  const channelLabel = stereoIn ? ({ left: 'left ch · ', right: 'right ch · ', mix: 'L+R mix · ' })[els.captureChannel.value] || '' : '';
  const kbps = Math.round(Math.max(6000, codec.bitrate * bits / 16) / 1000);
  const mode = codec.application === 'lowdelay' ? 'CELT' : codec.codecRate <= 8000 ? 'SILK' : 'SILK/CELT hybrid';
  const packetMs = Math.max(20, Math.round(num(els.frameMs, 20) / 20) * 20);
  const room = els.position.value === 'manual'
    ? `dsp_room ${els.env.value}`
    : (LISTENER_POSITIONS[els.position.value] || LISTENER_POSITIONS.open).label;
  const filters = [num(els.hp, 0) > 10 ? `HP ${num(els.hp, 0)} Hz` : '', num(els.lp, 20000) < 20000 ? `LP ${num(els.lp, 20000)} Hz` : ''].filter(Boolean);
  const steps = [
    ['Capture', `${channelLabel}mic ×${gain.toFixed(1)}${filters.length ? ' · ' + filters.join(' · ') : ''} · ${gateOn ? `gate > ${gateDb} dBFS` : 'no gate'}`, gain > 1 ? 'hot' : ''],
    ['Codec', codecOn ? `Opus ${codec.codecRate / 1000} kHz · ${codec.encoder?.vbr ? 'VBR ' : ''}${kbps} kbps${codec.encoder?.dtx ? ' · DTX' : ''} · ${mode}` : 'bypassed', codecOn ? '' : 'off'],
    ['Network', `${packetMs} ms packets · ${loss}% lost${jitter > 0 ? ` · ${jitter} ms jitter` : ''}`, loss > 0 || jitter > 0 ? 'hot' : ''],
    ['Receiver', agcOn ? `auto-gain ≤${maxGain}× · int16 clip` : 'unity gain · int16 clip', ''],
    ['Mixer', `44.1 kHz · ${room}`, ''],
    ['Output', `volume ${Math.round(volume * 100)}%`, '']
  ];
  els.chain.replaceChildren(...steps.map(([title, detail, cls]) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    const b = document.createElement('b'); b.textContent = title;
    const span = document.createElement('span'); span.textContent = detail;
    li.append(b, span);
    return li;
  }));
  // The batch queue marks renders made with other settings.
  document.dispatchEvent(new Event('tf2:settings'));
}

function runPreset(name) {
  if (!name) return;
  const cleanName = String(name).replace('exec ', '').replace('preset_', '').replace(/\.cfg$/, '');
  const p = PRESETS[cleanName];
  if (!p) {
    // Fall back to user presets saved via preset_save
    const user = LS.get('tf2ve_presets', {});
    if (user[cleanName]) {
      applyConfig(user[cleanName]); logLine(`exec user_${cleanName}.cfg`, 'cmd');
      setActivePreset(null); updateSignalChain(); return;
    }
    logLine(`Error: preset "${name}" not found.`, 'err');
    return;
  }
  logLine(`exec user_presets/${cleanName}.cfg`, 'cmd');
  // Presets temporarily lift cheat restrictions so "mic spam" style gains work
  const tempCheats = state.sv_cheats; state.sv_cheats = 1;
  execCommand(`sv_voicecodec ${p.codec}`);
  execCommand(`listener_position ${p.position}`);
  execCommand(`dsp_hpf ${p.hp}`);
  execCommand(`dsp_lpf ${p.lp}`);
  execCommand(`voice_scale ${p.voice_scale}`);
  execCommand(`voice_micgain ${p.gain}`);
  execCommand(`net_fakeloss ${p.loss}`);
  execCommand('snd_bits 16');
  execCommand('snd_codec 1');
  execCommand('voice_agc 1');
  execCommand(`voice_maxgain ${VOICE_ENGINE.autoGain.maxGain}`);
  execCommand(`voice_avggain ${VOICE_ENGINE.autoGain.avgGain}`);
  execCommand('voice_capture_channel left');
  execCommand('voice_vad auto');
  execCommand('voice_vad_threshold -39.5');
  execCommand(`volume ${VOICE_ENGINE.volume}`);
  execCommand('net_split 20');
  execCommand(`net_fakejitter ${p.jitter || 0}`);
  state.sv_cheats = tempCheats;
  setActivePreset(cleanName);
  updateSignalChain();
}

function printCvarList() {
  logLine('-------------- CVAR LIST --------------', 'sys');
  Object.keys(cvars).sort().forEach(k => {
    let flags = "";
    if (cvars[k].flags & FCVAR.CHEAT)  flags += "[sv_cheats] ";
    if (cvars[k].flags & FCVAR.SERVER) flags += "[sv] ";
    logLine(`${k.padEnd(22)} : ${flags}${cvars[k].help || ''}`, 'text');
  });
  logLine('---------------------------------------', 'sys');
  logLine(`${Object.keys(cvars).length} total cvars`, 'sys');
}

function printStatus() {
  if (!state.isConnected) { logLine("Not connected to server.", "text"); return; }
  logLine(`hostname: Local Browser Environment`);
  logLine(`version : 2.0.0.1  / 24 ${CODEC_PROFILES[els.codec.value].codecRate} secure`);
  logLine(`codec   : ${CODEC_PROFILES[els.codec.value].displayName}`);
  logLine(`listener: ${els.position.value} (dsp_room ${els.env.value})`);
  logLine(`map     : ${state.mapName} at: 0 x, 0 y, 0 z`);
  if (els.file.files.length) {
    const f = els.file.files[0];
    logLine(`# userid name                uniqueid            connected ping loss state`);
    logLine(`#      1 "${f.name}"      ${f.size}bytes    00:00       5    0 active`);
  } else { logLine(`No file loaded.`, 'err'); }
}

/* ------------------------------------------------------------------ */
/* Config persistence: share links, saved presets, command history    */
/* ------------------------------------------------------------------ */

const LS = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
};

function getStoredPresets() {
  const value = LS.get('tf2ve_presets', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function configControl(key, el, afterSet) {
  return [
    key,
    () => el.value,
    (v) => { el.value = v; if (afterSet) afterSet(v); },
    (v) => normalizeControlValue(el, v)
  ];
}

const CONFIG_FIELDS = [
  configControl('codec', els.codec),
  configControl('pos', els.position),
  configControl('dsp', els.env, (v) => { els.customEnv.style.display = (v === '99') ? 'block' : 'none'; }),
  configControl('gain', els.gain),
  configControl('vs', els.voiceScale),
  configControl('hp', els.hp),
  configControl('lp', els.lp),
  configControl('bits', els.bits),
  configControl('agc', els.agc),
  configControl('maxgain', els.maxGain),
  configControl('avggain', els.avgGain),
  configControl('chan', els.captureChannel),
  configControl('vad', els.vad),
  configControl('vadthr', els.vadThreshold),
  configControl('vol', els.volume),
  configControl('frame', els.frameMs),
  configControl('loss', els.loss),
  configControl('warble', els.warble),
  configControl('cdur', els.cDur),
  configControl('cdec', els.cDec),
  configControl('cmix', els.cMix),
  configControl('jit', els.jitter)
];

function collectConfig() {
  const out = {};
  CONFIG_FIELDS.forEach(([key, get]) => out[key] = get());
  return out;
}

function applyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 0;
  let applied = 0;
  CONFIG_FIELDS.forEach(([key, get, set, normalize]) => {
    if (cfg[key] == null) return;
    try {
      const value = normalize ? normalize(cfg[key]) : String(cfg[key]);
      if (value != null) { set(value); applied++; }
    } catch (e) { /* invalid persisted value — retain the current setting */ }
  });
  if (els.position.value === 'manual' || els.env.value === '99') showAdvanced(true);
  if (applied) updateSignalChain();
  return applied;
}

function writeConfig() {
  const params = new URLSearchParams(collectConfig()).toString();
  const url = location.href.split('#')[0] + '#' + params;
  try { history.replaceState(null, '', '#' + params); } catch (e) {}
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => logLine('Host_WriteConfiguration: share URL copied to clipboard.', 'sys'))
      .catch(() => logLine(`Share URL: ${url}`, 'sys'));
  } else logLine(`Share URL: ${url}`, 'sys');
}

function applyHashConfig() {
  if (!location.hash || location.hash.length < 2) return;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const cfg = {};
    params.forEach((v, k) => cfg[k] = v);
    const n = applyConfig(cfg);
    if (n) logLine(`exec shared_config.cfg (${n} settings applied)`, 'cmd');
  } catch (e) { /* malformed hash — ignore */ }
}

function savePreset(name) {
  if (!name) return logLine('Usage: preset_save <name>', 'err');
  const key = String(name).trim().toLowerCase();
  const all = getStoredPresets();
  all[key] = collectConfig();
  LS.set('tf2ve_presets', all);
  logLine(`Host_WriteConfiguration: Wrote cfg/user_${key}.cfg`, 'sys');
}

function loadPreset(name) {
  if (!name) return logLine('Usage: preset_load <name>', 'err');
  const key = String(name).trim().toLowerCase();
  const all = getStoredPresets();
  if (!all[key]) return logLine(`preset_load: no saved preset "${key}"`, 'err');
  applyConfig(all[key]);
  logLine(`exec user_${key}.cfg`, 'cmd');
}

function listPresets() {
  const all = getStoredPresets();
  const keys = Object.keys(all);
  if (!keys.length) return logLine('No saved presets. Use preset_save <name>.', 'text');
  keys.sort().forEach(k => logLine(`user_${k}.cfg`, 'text'));
}

function deletePreset(name) {
  if (!name) return logLine('Usage: preset_delete <name>', 'err');
  const key = String(name).trim().toLowerCase();
  const all = getStoredPresets();
  if (!all[key]) return logLine(`preset_delete: no saved preset "${key}"`, 'err');
  delete all[key];
  LS.set('tf2ve_presets', all);
  logLine(`Deleted user_${key}.cfg`, 'sys');
}

/* ------------------------------------------------------------------ */
/* Source loading (file or microphone)                                */
/* ------------------------------------------------------------------ */

// `mono` is the L+R mix used for display and the dry A/B; stereo sources also
// keep their left channel so the render can capture it like a stereo cable.
function mountSource(mono, sampleRate, name, left = null) {
  const duration = mono.length / sampleRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('the clip has no decodable audio');
  if (duration > MAX_AUDIO_SECONDS) throw new Error('the clip exceeds the 10 minute limit');
  state.sourceName = name;
  if (state.dryBlob) URL.revokeObjectURL(state.dryBlob);
  if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
  state.lastBlob = null;
  state.lastWav = null;
  state.lastExports = {};
  state.processedBuffer = null;
  state.decodedSource = { sampleRate, duration, length: mono.length,
    numberOfChannels: 1, getChannelData: () => mono, left };
  state.dryBlob = URL.createObjectURL(TF2Audio.encodeWav(mono, sampleRate));
  els.process.disabled = false;
  els.dl.disabled = true;
  els.audio.pause();
  els.audio.removeAttribute('src');
  els.audio.load();
  if (els.audioDry) { els.audioDry.pause(); els.audioDry.removeAttribute('src'); els.audioDry.load(); }
  clearReferenceTake();
  if (els.reference) els.reference.hidden = false;
  els.abToggle.disabled = true;
  els.abToggle.textContent = 'A/B: Wet';
  state.abMode = 'wet';
  state.lastCodecInfo = null;
  resetVizView();
  refreshVisualizer();
  updateMeter();
  setStatus(`${name} · ${duration.toFixed(1)}s · ${sampleRate.toLocaleString()} Hz`, 'success');
  logLine(`FS_MountFile: "${name}" (${duration.toFixed(1)}s) mounted.`, 'sys');
  updateSignalChain();
}

let sourceLoadId = 0;
async function loadSourceFromArrayBuffer(ab, name) {
  const id = ++sourceLoadId;
  els.process.disabled = true;
  try {
    setStatus(`Decoding ${name}…`);
    if (!state.decodeCtx) state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await state.decodeCtx.decodeAudioData(ab);
    if (id !== sourceLoadId) return; // A newer selection superseded this decode.
    if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error('the clip exceeds the 10 minute limit');
    mountSource(TF2Audio.bufferToMono(decoded), decoded.sampleRate, name,
      decoded.numberOfChannels > 1 ? decoded.getChannelData(0).slice() : null);
  } catch (e) {
    if (id !== sourceLoadId) return;
    logLine(`decodeAudioData failed: ${e.message}`, 'err');
    setStatus(`Could not load audio: ${e.message}`, 'error');
    state.decodedSource = null;
    els.process.disabled = true;
  }
}

async function startRecord() {
  if (state.recorder || state.processing) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
    setStatus('Uncompressed microphone capture requires HTTPS or localhost and AudioWorklet support.', 'error');
    return;
  }
  const session = { stop: () => { session.stopRequested = true; } };
  state.recorder = session;
  ++sourceLoadId;
  els.process.disabled = true;
  els.file.disabled = true;
  els.mic.textContent = '⏹ Connecting…';
  let stream, context, source, capture, finished = false;
  const parts = [];
  const cleanup = async () => {
    if (finished) return;
    finished = true;
    stream?.getTracks().forEach(t => t.stop());
    source?.disconnect();
    capture?.disconnect();
    if (context && context.state !== 'closed') await context.close();
    if (state.recorder === session) state.recorder = null;
    clearInterval(state.recTick); state.recTick = null;
    els.mic.textContent = '🎤 Record';
    els.mic.classList.remove('recording');
    els.file.disabled = false;
    els.process.disabled = !state.decodedSource;
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    context = new (window.AudioContext || window.webkitAudioContext)();
    await context.audioWorklet.addModule('mic-capture.js');
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'mic-capture', {
      processorOptions: { maxSamples: MAX_RECORDING_SECONDS * context.sampleRate }
    });
    capture.onprocessorerror = async () => {
      await cleanup();
      setStatus('Microphone capture failed. Please record again.', 'error');
    };
    capture.port.onmessage = async e => {
      if (finished) return;
      if (e.data.type === 'samples') parts.push(e.data.data);
      if (e.data.type === 'complete') {
        const rate = context.sampleRate;
        await cleanup();
        const length = parts.reduce((sum, part) => sum + part.length, 0);
        if (!length) { setStatus('The microphone recording was empty.', 'error'); return; }
        const mono = new Float32Array(length);
        let offset = 0;
        for (const part of parts) { mono.set(part, offset); offset += part.length; }
        mountSource(mono, rate, 'microphone');
      }
    };
    source.connect(capture);
    capture.connect(context.destination); // Worklet outputs silence, never live mic monitoring.
    session.stop = () => { capture.port.postMessage('stop'); };
    await context.resume();
    if (session.stopRequested) session.stop();
    const started = performance.now();
    els.mic.classList.add('recording');
    state.recTick = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      els.mic.textContent = `⏹ ${elapsed.toFixed(0)}s`;
      if (elapsed >= MAX_RECORDING_SECONDS) session.stop();
    }, 250);
    setStatus('Recording uncompressed audio…');
    logLine('+voicerecord (PCM capture)', 'cmd');
  } catch (e) {
    await cleanup();
    setStatus(`Microphone unavailable: ${e.message}`, 'error');
    logLine(`VoiceRecord: ${e.message}`, 'err');
  }
}

function stopRecord() {
  if (state.recorder) state.recorder.stop();
}

if (els.mic) els.mic.addEventListener('click', () => {
  if (state.recorder) stopRecord(); else startRecord();
});

/* ------------------------------------------------------------------ */
/* Input handling                                                     */
/* ------------------------------------------------------------------ */

function cvarValue(name) {
  const c = cvars[name];
  if (!c) return null;
  if (c.link) { const el = document.getElementById(c.link); return el ? String(el.value) : null; }
  return c.val !== undefined ? String(c.val) : null;
}

function consoleMatches(prefix) {
  const p = prefix.toLowerCase();
  return [...new Set([...Object.keys(cvars), ...Object.keys(aliases)])].filter(k => k.startsWith(p)).sort();
}

function showHint(typed, rest) {
  const spacer = document.createElement('span');
  spacer.style.color = 'transparent';
  spacer.textContent = typed;
  els.conHint.append(spacer, document.createTextNode(rest));
}

// Grey inline hint: the first completion while typing a name, then the
// current value (or usage) once a known command is followed by a space.
function updateConsoleHint() {
  const val = els.conIn.value;
  els.conHint.replaceChildren();
  const argStart = /^(\S+) $/.exec(val);
  if (argStart && cvars[argStart[1].toLowerCase()]) {
    const name = argStart[1].toLowerCase(), c = cvars[name], current = cvarValue(name);
    const usage = c.usage ? c.usage.replace(/^\S+\s*/, '') : '';
    if (current !== null) showHint(val, `${current}   (current)`);
    else if (usage) showHint(val, usage);
  } else if (val && !/\s/.test(val)) {
    const match = consoleMatches(val)[0];
    if (match && match.length > val.length) showHint(val, match.substring(val.length));
  }
  updateCompleteBtn();
}
els.conIn.addEventListener('input', updateConsoleHint);

// Show the ⇥ tap-complete button whenever a completion is possible (touch
// keyboards have no Tab key).
function updateCompleteBtn() {
  if (!els.conComplete) return;
  const val = els.conIn.value;
  els.conComplete.style.display = val && !/\s/.test(val) && consoleMatches(val).length ? 'block' : 'none';
}

// Source-style Tab: complete a unique name, otherwise extend to the longest
// common prefix, otherwise list the candidates with their current values.
function completeConsole() {
  const val = els.conIn.value;
  if (!val || /\s/.test(val)) return;
  const matches = consoleMatches(val);
  if (matches.length === 1) {
    els.conIn.value = matches[0] + ' ';
  } else if (matches.length > 1) {
    let prefix = matches[0];
    for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > val.length) els.conIn.value = prefix;
    else {
      logLine(`] ${val}`, 'text');
      for (const m of matches.slice(0, 24)) {
        const value = cvarValue(m);
        logLine(`  ${m}${value !== null ? ` = "${value}"` : aliases[m] ? ' (alias)' : ''}`, 'help');
      }
      if (matches.length > 24) logLine(`  ... ${matches.length - 24} more`, 'help');
    }
  }
  updateConsoleHint();
  els.conIn.focus();
}

if (els.conComplete) els.conComplete.addEventListener('click', completeConsole);

els.conIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = els.conIn.value;
    if (val) {
      state.cmdHistory.push(val);
      if (state.cmdHistory.length > 50) state.cmdHistory.shift();
      state.cmdIndex = state.cmdHistory.length;
      LS.set('tf2ve_history', state.cmdHistory);
      execCommand(val);
      els.conIn.value = '';
      updateConsoleHint();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.cmdIndex > 0) {
      state.cmdIndex--; els.conIn.value = state.cmdHistory[state.cmdIndex];
      els.conIn.dispatchEvent(new Event('input'));
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.cmdIndex < state.cmdHistory.length - 1) {
      state.cmdIndex++; els.conIn.value = state.cmdHistory[state.cmdIndex];
      els.conIn.dispatchEvent(new Event('input'));
    } else {
      state.cmdIndex = state.cmdHistory.length; els.conIn.value = ''; updateConsoleHint();
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    completeConsole();
  }
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => { const cmd = btn.getAttribute('data-cmd'); if (cmd) execCommand(cmd); });
});

// Load one file as the source (file picker or a single dropped file).
async function loadSourceFile(f) {
  if (f.size > MAX_FILE_BYTES) {
    setStatus(`File is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 'error');
    logLine('FS_MountFile: file exceeds the 100 MB safety limit.', 'err');
    return;
  }
  const selection = ++sourceLoadId;
  els.process.disabled = true;
  try {
    const bytes = await f.arrayBuffer();
    if (selection !== sourceLoadId) return;
    await loadSourceFromArrayBuffer(bytes, f.name);
  } catch (error) {
    if (selection !== sourceLoadId) return;
    setStatus(`Could not read audio: ${error.message}`, 'error');
    els.process.disabled = !state.decodedSource;
  }
}

els.file.addEventListener('change', () => {
  if (!els.file.files.length) return;
  const files = Array.from(els.file.files);
  // Several files at once go to the batch queue (batch.js).
  if (files.length > 1 && window.TF2Batch) {
    els.file.value = '';
    window.TF2Batch.add(files, { reveal: true });
    return;
  }
  if (files[0].size > MAX_FILE_BYTES) els.file.value = '';
  loadSourceFile(files[0]);
});

/* ------------------------------------------------------------------ */
/* Process button                                                     */
/* ------------------------------------------------------------------ */

if (els.advancedToggle) {
  els.advancedToggle.addEventListener('click', () => showAdvanced(!document.body.classList.contains('advanced')));
}
if (els.consoleDetails) {
  els.consoleDetails.addEventListener('toggle', () => {
    els.conOut.setAttribute('aria-live', els.consoleDetails.open ? 'polite' : 'off');
  });
}

// Whether jobs can run in audio-worker.js (not from file://).
function canUseWorker() {
  return typeof Worker !== 'undefined' && location.protocol !== 'file:';
}

// One job in a dedicated worker. Returns { promise, cancel }: the promise
// resolves with the worker's reply; cancel() terminates the worker and
// rejects with an AbortError.
function startWorker(message, transfer, onProgress) {
  const worker = new Worker('audio-worker.js');
  const id = ++state.processId;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const finish = () => { done = true; worker.terminate(); };
    cancel = () => {
      if (done) return;
      finish();
      const error = new Error('Audio processing cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    worker.onmessage = (event) => {
      const reply = event.data || {};
      if (reply.id !== id || done) return;
      if (reply.type === 'progress') {
        if (onProgress) onProgress(reply.value);
      } else if (reply.type === 'error') {
        finish();
        reject(new Error(reply.message || 'Audio worker failed.'));
      } else {
        finish();
        resolve(reply);
      }
    };
    worker.onerror = (event) => {
      if (done) return;
      finish();
      reject(new Error(event.message || 'Audio worker could not start.'));
    };
    worker.postMessage({ ...message, id }, transfer);
  });
  return { promise, cancel };
}

// One render in a dedicated worker, as { promise, cancel }. The result
// carries the render's loudness and levels (meter.js) as `stats`.
function startWorkerJob(source, opts) {
  const mono = source.getChannelData(0).slice();
  const workerOpts = { ...opts };
  delete workerOpts.onProgress;
  const job = startWorker({ type: 'process', sampleRate: source.sampleRate, samples: mono.buffer, opts: workerOpts, measure: true },
    [mono.buffer], opts.onProgress);
  return {
    cancel: job.cancel,
    promise: job.promise.then((reply) => ({
      samples: new Float32Array(reply.samples),
      sampleRate: reply.sampleRate,
      blob: reply.blob,
      realOpus: reply.realOpus,
      codecInfo: reply.codecInfo,
      stats: reply.stats
    }))
  };
}

function processInWorker(source, opts) {
  const job = startWorkerJob(source, opts);
  state.cancelProcessing = job.cancel;
  return job.promise.finally(() => {
    if (state.cancelProcessing === job.cancel) state.cancelProcessing = null;
  });
}

function describeModes(modes) {
  if (!modes) return 'modes unknown';
  const total = modes.silk + modes.hybrid + modes.celt;
  const parts = Object.entries(modes).filter(([, n]) => n > 0)
    .map(([mode, n]) => `${mode.toUpperCase()} ${Math.round(100 * n / Math.max(1, total))}%`);
  return parts.length ? parts.join(', ') : 'no packets';
}

// The mono signal the game's microphone input receives from the source.
function captureSource(source, channel) {
  if (!source.left || channel === 'mix') return source;
  const mix = source.getChannelData(0), left = source.left;
  let mono = left;
  if (channel === 'right') {
    mono = new Float32Array(mix.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 2 * mix[i] - left[i];
  }
  return { sampleRate: source.sampleRate, duration: source.duration, length: mono.length, numberOfChannels: 1, getChannelData: () => mono };
}

// The render settings of the current controls (everything but progress).
function renderOptions() {
  const posKey = els.position.value;
  const dspRoomId = parseInt(els.env.value);
  return {
    codec: els.codec.value,
    // If user chose 'manual', respect the dsp_room dropdown; otherwise use listener position.
    listenerPos: (posKey === 'manual') ? null : posKey,
    dspRoom: dspRoomId,
    customEnv: (dspRoomId === 99) ? {
      duration: Number(els.cDur.value),
      decay:    Number(els.cDec.value),
      mix:      Number(els.cMix.value) / 100
    } : null,
    captureChannel: els.captureChannel.value,
    micGain:     Number(els.gain.value),
    voiceScale:  Number(els.voiceScale.value),
    hp:          Number(els.hp.value),
    lp:          Number(els.lp.value),
    bits:        Number(els.bits.value),
    agc:         els.agc.value === '1',
    maxGain:     Number(els.maxGain.value),
    avgGain:     Number(els.avgGain.value),
    gate:        els.vad.value === 'auto' ? null : els.vad.value === '1',
    gateThresholdDb: Number(els.vadThreshold.value),
    volume:      Number(els.volume.value),
    lossPct:     Number(els.loss.value),
    frameMs:     Number(els.frameMs.value),
    enableWarble: els.warble.value === '1',
    jitterMs:    Number(els.jitter.value)
  };
}

async function runAudioProcess(source, opts) {
  source = captureSource(source, opts.captureChannel);
  if (canUseWorker()) {
    try {
      return await processInWorker(source, opts);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      logLine(`Audio worker unavailable; using compatibility path (${error.message})`, 'warn');
    }
  }
  state.cancelProcessing = null;
  if (els.cancel) els.cancel.hidden = true;
  return TF2Audio.process(source, opts);
}

// Download name for a render of `sourceName` with codec profile `codecKey`.
function outputName(sourceName, codecKey, ext = 'wav') {
  const base = (sourceName || 'clip').replace(/\.[^/.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return `${base}_tf2_${codecKey}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* Download formats (formats.js): WAV, FLAC, MP3                      */
/* ------------------------------------------------------------------ */

function currentFormat() {
  const key = els.format ? els.format.value : 'wav';
  return TF2Formats.FORMATS[key] ? key : 'wav';
}

// The file for `format` made from a rendered WAV blob, as { blob, crc }
// (crc: CRC-32 for ZIP archives). Runs in a worker when it can.
async function exportWav(wavBlob, format) {
  const { mime } = TF2Formats.FORMATS[format];
  const wav = await wavBlob.arrayBuffer();
  if (canUseWorker()) {
    const reply = await startWorker({ type: 'export', wav, format }, [wav]).promise;
    return { blob: new Blob([reply.bytes], { type: mime }), crc: reply.crc };
  }
  const bytes = await TF2Formats.fromWav(new Uint8Array(wav), format);
  return { blob: new Blob([bytes], { type: mime }), crc: TF2Zip.crc32(bytes) };
}

// exportWav with the result kept per format in `cache`; a failure is not kept.
function cachedExport(cache, wavBlob, format) {
  if (!cache[format]) {
    cache[format] = exportWav(wavBlob, format);
    cache[format].catch(() => { delete cache[format]; });
  }
  return cache[format];
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function updateDownloadLabel() {
  if (els.dl && !els.dl.dataset.busy) els.dl.textContent = `Download ${TF2Formats.FORMATS[currentFormat()].label}`;
}

if (els.format) {
  const saved = LS.get('tf2ve_format', 'wav');
  if (TF2Formats.FORMATS[saved]) els.format.value = saved;
  els.format.addEventListener('change', () => {
    LS.set('tf2ve_format', currentFormat());
    updateDownloadLabel();
    document.dispatchEvent(new Event('tf2:format'));
  });
  updateDownloadLabel();
}

// Show a finished render: console report, preview players (wet plus the muted
// dry twin for A/B), download name, visualizer and status.
function presentRender({ samples, sampleRate, blob, realOpus, codecInfo, stats }, took, codecKey) {
  // Report the actual processing path: codec version, bitrate and the
  // Opus modes the encoder really chose.
  logLine(realOpus
    ? `S_Voice: ${codecInfo.version}, ${codecInfo.bitrate / 1000} kbps ${codecInfo.vbr ? 'VBR' : 'CBR'}${codecInfo.dtx ? ' + DTX' : ''}, 20 ms frames, native PLC (${describeModes(codecInfo.modes)})`
    : 'S_Voice: codec bypassed', 'sys');
  if (realOpus && codecInfo.gate != null) {
    const held = codecInfo.frames ? Math.round(100 * codecInfo.gatedFrames / codecInfo.frames) : 0;
    logLine(`S_Voice: voice gate at ${codecInfo.gate} dBFS sent ${codecInfo.spurts} talk spurt${codecInfo.spurts === 1 ? '' : 's'} and held back ${codecInfo.gatedFrames} of ${codecInfo.frames} frames (${held}%)`, 'sys');
  }
  if (realOpus && codecInfo.dtxFrames) {
    logLine(`S_Voice: ${codecInfo.dtxFrames} inactive frames sent as DTX comfort noise`, 'sys');
  }
  if (realOpus && (codecInfo.lostFrames || codecInfo.underrunFrames)) {
    logLine(`S_Voice: ${codecInfo.lostFrames} frames lost and concealed, ${codecInfo.underrunFrames || 0} late frames played as silence`, 'sys');
  }
  logLine(`S_Voice: receiver auto-gain ${codecInfo.autoGain ? 'on' : 'off'} at ${codecInfo.voiceRate} Hz`, 'sys');

  state.processedBuffer = samples;
  state.processedRate   = sampleRate;
  if (stats) meterResults.set(bufferId(samples), Promise.resolve(stats));
  if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
  state.lastBlob = URL.createObjectURL(blob);
  state.lastWav = blob;
  state.lastExports = {};

  // Default to wet after a new render; arm the muted dry twin so the
  // A/B toggle is an instant unmute rather than a src swap.
  state.abMode = 'wet';
  els.abToggle.disabled = false;
  els.abToggle.textContent = 'A/B: Wet';

  els.audio.src = state.lastBlob;
  els.audio.muted = false;
  if (els.audioDry) {
    els.audioDry.src = state.dryBlob;
    els.audioDry.muted = true;
    els.audioDry.volume = els.audio.volume;
  }
  if (els.audioReal) els.audioReal.muted = true;
  state.lastCodecKey = codecKey;
  els.dl.disabled = false;

  state.renderId++;
  state.lastCodecInfo = codecInfo;
  // A re-render of the same source keeps the view, band and selection.
  refreshVisualizer();
  updateMeter();
  updateReferenceReport();
  const method = realOpus ? `Real Opus · ${codecInfo.bitrate / 1000} kbps` : 'Codec bypassed';
  setStatus(`Ready · ${method} · ${(took / 1000).toFixed(1)}s render · ${sampleRate.toLocaleString()} Hz`, 'success');
  logLine(`ChangeLevel: rendered ${samples.length} samples @ ${sampleRate}Hz in ${took}ms`, 'sys');
  logLine(`Net_SendPacket: reliable stream ready.`);
}

if (els.cancel) els.cancel.addEventListener('click', () => {
  if (state.cancelProcessing) state.cancelProcessing();
});

if (els.dl) els.dl.addEventListener('click', async () => {
  if (!state.lastWav || els.dl.disabled) return;
  const format = currentFormat(), wav = state.lastWav;
  const { ext, label } = TF2Formats.FORMATS[format];
  const name = outputName(state.sourceName, state.lastCodecKey, ext);
  if (format === 'wav') { saveBlob(wav, name); return; }
  els.dl.disabled = true;
  els.dl.dataset.busy = '1';
  els.dl.textContent = `Encoding ${label}…`;
  try {
    const { blob } = await cachedExport(state.lastExports, wav, format);
    // Skip the save if a new render or source replaced this one meanwhile.
    if (state.lastWav === wav) saveBlob(blob, name);
    logLine(`Host_WriteFile: ${name} (${(blob.size / 1048576).toFixed(1)} MB)`, 'sys');
  } catch (e) {
    logLine(`${label} export failed: ${e.message}`, 'err');
    setStatus(`Could not make the ${label} file: ${e.message}`, 'error');
  } finally {
    delete els.dl.dataset.busy;
    updateDownloadLabel();
    els.dl.disabled = !state.lastWav || state.processing;
  }
});

els.process.addEventListener('click', async () => {
  if (!state.decodedSource) { logLine('No decoded audio — select a file first.', 'err'); return; }
  if (state.processing || state.batchRunning) return;
  state.processing = true;
  document.dispatchEvent(new Event('tf2:busy'));
  els.process.disabled = true;
  els.dl.disabled = true;
  els.file.disabled = true;
  if (els.mic) els.mic.disabled = true;
  if (els.controls) els.controls.inert = true;
  if (els.cancel) els.cancel.hidden = false;
  if (els.progress) { els.progress.hidden = false; els.progress.value = 0; }
  setStatus(`Processing ${state.decodedSource.duration.toFixed(1)}s of audio in the background…`);
  logLine(`S_StartSound: initializing render...`);

  try {
    const codecKey = els.codec.value;
    const opts = {
      ...renderOptions(),
      onProgress:  (p) => {
        const percent = Math.min(100, Math.max(0, Math.round(p * 100)));
        els.process.textContent = `Processing… ${percent}%`;
        if (els.progress) els.progress.value = percent;
      }
    };

    logLine(`MIX: codec=${opts.codec} pos=${opts.listenerPos || 'manual:'+opts.dspRoom} gain=${opts.micGain} vs=${opts.voiceScale}`);

    const t0 = performance.now();
    const result = await runAudioProcess(state.decodedSource, opts);
    const took = Math.round(performance.now() - t0);

    presentRender(result, took, codecKey);
  } catch (e) {
    if (e.name === 'AbortError') {
      logLine('S_StopSound: render cancelled.', 'warn');
      setStatus('Processing cancelled. Your source audio is still loaded.');
    } else {
      console.error(e);
      logLine(`render failed: ${e.message}`, 'err');
      setStatus(`Processing failed: ${e.message}`, 'error');
    }
  } finally {
    state.processing = false;
    state.cancelProcessing = null;
    els.process.disabled = false;
    els.dl.disabled = !state.lastWav;
    els.file.disabled = false;
    if (els.mic) els.mic.disabled = false;
    if (els.controls) els.controls.inert = false;
    els.process.textContent = 'Process Audio';
    if (els.cancel) els.cancel.hidden = true;
    if (els.progress) els.progress.hidden = true;
    document.dispatchEvent(new Event('tf2:busy'));
  }
});

/* ------------------------------------------------------------------ */
/* A/B toggle                                                         */
/* ------------------------------------------------------------------ */

// A/B cycles wet, dry and, with a real take loaded, real. All versions play
// in sync; switching is an instant mute swap, with no re-buffering.
const AB_LABELS = { wet: 'A/B: Wet', dry: 'A/B: Dry', real: 'A/B: Real' };
function setAbMutes() {
  els.audio.muted = state.abMode !== 'wet';
  if (els.audioDry) els.audioDry.muted = state.abMode !== 'dry';
  if (els.audioReal) els.audioReal.muted = state.abMode !== 'real';
}
els.abToggle.addEventListener('click', () => {
  if (!state.lastBlob || !state.dryBlob || !els.audioDry) return;
  const modes = ['wet', 'dry', ...(state.realTake && els.audioReal ? ['real'] : [])];
  state.abMode = modes[(modes.indexOf(state.abMode) + 1) % modes.length];
  setAbMutes();
  syncTwins(true);
  els.abToggle.textContent = AB_LABELS[state.abMode];
  refreshVisualizer();
});

// The hidden twins of the main (wet) player: the dry source and the real take.
const twins = () => [els.audioDry, els.audioReal].filter(el => el && el.src);
// Keep the twins locked to the main transport.
function syncTwins(force = false) {
  for (const el of twins()) {
    const d = el.duration;
    const t = Math.min(els.audio.currentTime, isFinite(d) && d > 0 ? Math.max(0, d - 0.01) : els.audio.currentTime);
    try {
      if (force || Math.abs(el.currentTime - t) > 0.02) el.currentTime = t;
    } catch (e) { /* metadata not ready yet */ }
  }
}

els.audio.addEventListener('volumechange', () => { for (const el of [els.audioDry, els.audioReal]) if (el) el.volume = els.audio.volume; });
els.audio.addEventListener('ratechange', () => { for (const el of [els.audioDry, els.audioReal]) if (el) el.playbackRate = els.audio.playbackRate; });

/* ------------------------------------------------------------------ */
/* Meter and loudness-matched A/B (meter.js)                          */
/*                                                                    */
/* The meter lists loudness and levels of the wet render and the dry  */
/* source, or of the time range selected in the visualizer. Matching  */
/* plays the louder of the two quieter by their difference in         */
/* integrated loudness over the whole file, so an A/B compares sound  */
/* rather than level.                                                 */
/* ------------------------------------------------------------------ */

els.meter = document.getElementById('meter');
els.meterRows = document.getElementById('meter-rows');
els.meterSel = document.getElementById('meter-sel');
els.meterSelText = document.getElementById('meter-sel-text');
els.meterSelZoom = document.getElementById('meter-sel-zoom');
els.meterSelClear = document.getElementById('meter-sel-clear');
els.abMatch = document.getElementById('ab-match');
state.abMatch = LS.get('tf2ve_ab_match', false) === true;
state.abOffsetDb = 0;         // gain applied to the louder version, dB (<= 0)
state.abLouder = null;        // 'WET' or 'DRY'

// TF2Meter.analyze on a copy of `samples`, in a worker when there is one.
function analyzeCopy(samples, rate) {
  const copy = samples.slice();
  if (canUseWorker()) {
    return startWorker({ type: 'analyze', samples: copy.buffer, sampleRate: rate }, [copy.buffer]).promise.then(reply => reply.stats);
  }
  return new Promise(resolve => setTimeout(() => resolve(TF2Meter.analyze(copy, rate)), 0));
}

const meterResults = new Map();   // buffer id -> Promise<stats>
function measure(samples, rate) {
  const id = bufferId(samples);
  if (!meterResults.has(id)) {
    const job = analyzeCopy(samples, rate);
    job.catch(() => meterResults.delete(id));
    meterResults.set(id, job);
  }
  return meterResults.get(id);
}

// Statistics of the samples between t0 and t1 s, for a selection; the last
// few ranges are kept.
const rangeResults = new Map();   // "id:from:to" -> Promise<stats>
function measureRange(samples, rate, t0, t1) {
  const from = Math.max(0, Math.floor(t0 * rate)), to = Math.min(samples.length, Math.max(from + 1, Math.ceil(t1 * rate)));
  const key = `${bufferId(samples)}:${from}:${to}`;
  if (!rangeResults.has(key)) {
    if (rangeResults.size >= 24) rangeResults.delete(rangeResults.keys().next().value);
    const job = analyzeCopy(samples.subarray(from, to), rate);
    job.catch(() => rangeResults.delete(key));
    rangeResults.set(key, job);
  }
  return rangeResults.get(key);
}

function meterSources() {
  const out = [];
  if (state.processedBuffer) out.push({ label: 'WET', samples: state.processedBuffer, rate: state.processedRate });
  if (state.decodedSource) out.push({ label: 'DRY', samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate });
  if (state.realTake) out.push({ label: 'REAL', samples: state.realTake.samples, rate: state.realTake.rate });
  return out;
}

const METER_COLUMNS = [
  ['integrated', 'LUFS', 1], ['lra', 'LU', 1], ['shortTermMax', 'LUFS', 1], ['momentaryMax', 'LUFS', 1],
  ['truePeak', 'dBTP', 1], ['samplePeak', 'dBFS', 1], ['rms', 'dBFS', 1], ['plr', 'dB', 1], ['dc', '%', 3]
];
function meterCell(key, value) {
  if (value === null || value === undefined) return '—';
  if (key === 'dc') return `${(value * 100).toFixed(3)}`;
  if (!Number.isFinite(value)) return '−∞';
  return value.toFixed(1).replace('-', '−');
}

// Values worth a second look: peaks that clip on 16-bit export or lossy
// encoding, and a DC offset (libopus 1.1.x comfort noise for a steady tone
// below ~60 Hz is nearly DC; see README).
function meterWarning(key, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (key === 'truePeak' && value > 0) return { level: 'meter-bad', text: 'Inter-sample peaks above 0 dBTP clip after MP3 decoding or resampling' };
  if (key === 'truePeak' && value > -1) return { level: 'meter-warn', text: 'Less than 1 dB below 0 dBTP: MP3 decoding may clip' };
  if (key === 'samplePeak' && value >= -0.01) return { level: 'meter-bad', text: 'Samples at full scale clip in the 16-bit file' };
  if (key === 'dc' && Math.abs(value) >= 0.005) return { level: 'meter-warn', text: 'DC offset over 0.5% of full scale' };
  return null;
}

let meterGeneration = 0, meterSourcesKey = '';
async function updateMeter() {
  const sources = meterSources();
  const generation = ++meterGeneration;
  const selection = vizSel;
  if (els.meter) els.meter.hidden = !sources.length;
  // Whole-file statistics drive the A/B matching and the loudness lane; they
  // only change with the audio, not with the selection.
  const sourcesKey = sources.map(src => bufferId(src.samples)).join(':');
  if (sourcesKey !== meterSourcesKey) {
    meterSourcesKey = sourcesKey;
    state.meterStats = null;
    applyAbMatch();
  }
  if (els.meterSel) {
    els.meterSel.hidden = !selection || !sources.length;
    if (selection) {
      els.meterSelText.textContent = `Selection ${formatTime(selection.t0, 3)} – ${formatTime(selection.t1, 3)} · ${(selection.t1 - selection.t0).toFixed(3)} s`;
    }
  }
  if (!sources.length || !els.meterRows) return;
  const row = (label, cells, cls = '', stats = null) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.appendChild(th);
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      const warning = stats && meterWarning(METER_COLUMNS[i][0], stats[METER_COLUMNS[i][0]]);
      if (warning) { td.className = warning.level; td.title = warning.text; }
      tr.appendChild(td);
    });
    return tr;
  };
  els.meterRows.replaceChildren(...sources.map(src => row(src.label, METER_COLUMNS.map(() => '…'))));
  const whole = await Promise.all(sources.map(src => measure(src.samples, src.rate).catch(() => null)));
  if (generation !== meterGeneration) return;
  const hadStats = !!state.meterStats;
  const statsFor = (label) => whole[sources.findIndex(src => src.label === label)] || null;
  state.meterStats = { wet: statsFor('WET'), dry: statsFor('DRY'), real: statsFor('REAL') };
  applyAbMatch();
  // The loudness lane draws from these.
  if (!hadStats && state.showLufs) refreshVisualizer();
  const results = selection
    ? await Promise.all(sources.map(src => measureRange(src.samples, src.rate, selection.t0, selection.t1).catch(() => null)))
    : whole;
  if (generation !== meterGeneration) return;
  const rows = sources.map((src, i) => row(src.label, METER_COLUMNS.map(([key]) => (results[i] ? meterCell(key, results[i][key]) : 'error')), '', results[i]));
  // Wet minus dry (Δ) and wet minus the real take (Δ real), for the columns
  // where a difference means something.
  const diff = new Set(['integrated', 'truePeak', 'samplePeak', 'rms', 'plr', 'lra']);
  const byLabel = (label) => results[sources.findIndex(src => src.label === label)] || null;
  for (const [label, other, title] of [['Δ', 'DRY', 'wet minus dry'], ['Δ real', 'REAL', 'wet minus the real take']]) {
    const a = byLabel('WET'), b = byLabel(other);
    if (!a || !b) continue;
    const tr = row(label, METER_COLUMNS.map(([key]) => {
      if (!diff.has(key) || a[key] === null || b[key] === null || !Number.isFinite(a[key]) || !Number.isFinite(b[key])) return '';
      const d = a[key] - b[key];
      return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)}`;
    }), 'meter-delta');
    tr.title = title;
    rows.push(tr);
  }
  els.meterRows.replaceChildren(...rows);
}
if (els.meterSelZoom) els.meterSelZoom.addEventListener('click', () => zoomToSelection());
if (els.meterSelClear) els.meterSelClear.addEventListener('click', () => { setSelection(null); refreshVisualizer(); });

// A/B gain (dB) for 'WET', 'DRY' or 'REAL'; 0 unless matching is on.
function abGainDb(label) {
  return state.abMatch ? (state.abGains && state.abGains[label]) || 0 : 0;
}

// Every version plays at the integrated loudness of the quietest.
function applyAbMatch() {
  const stats = state.meterStats || {};
  const level = (s) => (s && Number.isFinite(s.integrated) ? s.integrated : null);
  const levels = {};
  if (state.processedBuffer && level(stats.wet) !== null) levels.WET = level(stats.wet);
  if (state.decodedSource && level(stats.dry) !== null) levels.DRY = level(stats.dry);
  if (state.realTake && level(stats.real) !== null) levels.REAL = level(stats.real);
  const known = 'WET' in levels && 'DRY' in levels;
  const quietest = known ? Math.min(...Object.values(levels)) : 0;
  state.abGains = known ? Object.fromEntries(Object.entries(levels).map(([label, value]) => [label, quietest - value])) : {};
  state.abLouder = known ? (levels.WET > levels.DRY ? 'WET' : 'DRY') : null;
  state.abOffsetDb = known ? -Math.abs(levels.WET - levels.DRY) : 0;
  const now = state.audioCtx ? state.audioCtx.currentTime : 0;
  if (state.wetGain) state.wetGain.gain.setTargetAtTime(Math.pow(10, abGainDb('WET') / 20), now, 0.01);
  if (state.dryGain) state.dryGain.gain.setTargetAtTime(Math.pow(10, abGainDb('DRY') / 20), now, 0.01);
  if (state.realGain) state.realGain.gain.setTargetAtTime(Math.pow(10, abGainDb('REAL') / 20), now, 0.01);
  if (els.abMatch) {
    els.abMatch.disabled = !state.lastBlob || !state.dryBlob;
    els.abMatch.setAttribute('aria-pressed', String(state.abMatch));
    els.abMatch.classList.toggle('active', state.abMatch);
    const lowered = Object.entries(state.abGains).filter(([, g]) => g < -0.05)
      .map(([label, g]) => `${label.toLowerCase()} ${g.toFixed(1).replace('-', '−')}`);
    els.abMatch.textContent = !state.abMatch || !state.abLouder ? 'Match loudness'
      : 'REAL' in levels ? `Matched: ${lowered.join(', ') || 'all equal'} dB`
        : `Matched: ${state.abLouder.toLowerCase()} ${state.abOffsetDb.toFixed(1).replace('-', '−')} dB`;
  }
}

if (els.abMatch) els.abMatch.addEventListener('click', () => {
  state.abMatch = !state.abMatch;
  LS.set('tf2ve_ab_match', state.abMatch);
  applyAbMatch();
  refreshVisualizer();
});

// Space plays and pauses the preview, B switches A/B and L loops, outside
// text fields and buttons.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const target = event.target;
  if (target && target.closest && target.closest('input, textarea, select, button, audio, summary, [contenteditable]')) return;
  if (event.key === ' ' && els.audio.src) {
    event.preventDefault();
    if (els.audio.paused) els.audio.play().catch(() => {}); else els.audio.pause();
  } else if ((event.key === 'b' || event.key === 'B') && !els.abToggle.disabled) {
    event.preventDefault();
    els.abToggle.click();
  } else if ((event.key === 'l' || event.key === 'L') && els.vizLoop && !els.vizLoop.disabled) {
    event.preventDefault();
    toggleLoop();
  }
});

/* ------------------------------------------------------------------ */
/* Real take (reference.js)                                           */
/*                                                                    */
/* A real TF2 recording of the loaded source (voice_loopback) is      */
/* found in the source and put on its timeline, offset and clock      */
/* drift corrected. It becomes the third version of A/B, joins the    */
/* views and the meter, and a report compares it with the render:     */
/* level-matched band spectra, short-term level tracking and the      */
/* receiver's clipping signature.                                     */
/* ------------------------------------------------------------------ */

els.reference = document.getElementById('reference');
els.referenceFile = document.getElementById('reference-file');
els.referenceChannel = document.getElementById('reference-channel');
els.referenceClear = document.getElementById('reference-clear');
els.referenceStatus = document.getElementById('reference-status');
els.referenceReport = document.getElementById('reference-report');
els.audioReal = document.getElementById('preview-real');
state.realTake = null;   // { name, samples, rate, timeline, overlap: { t0, t1 }, blob }
let referenceJob = 0, reportJob = 0, referenceDecoded = null;
const REFERENCE_HELP = 'Load a voice_loopback recording of this source to check the simulation against it.';

function setReferenceStatus(text, level = '') {
  if (!els.referenceStatus) return;
  els.referenceStatus.textContent = text;
  els.referenceStatus.className = `reference-status${level ? ` ${level}` : ''}`;
}

function takeChannel(decoded, channel) {
  if (decoded.numberOfChannels < 2 || channel === 'mix') return TF2Audio.bufferToMono(decoded);
  return decoded.getChannelData(channel === 'right' ? 1 : 0).slice();
}

// Where the gate model puts talk spurts, for track(): the current profile
// and settings, as the render would use them.
function takeTrackOptions() {
  const o = renderOptions(), profile = CODEC_PROFILES[o.codec] || CODEC_PROFILES.steam;
  const on = o.enableWarble !== false && (o.gate == null ? !!profile.senderGate : o.gate);
  if (!on) return {};
  const spec = profile.senderGate || { thresholdDb: -39.5, prerollMs: 120, holdMs: 440 };
  return { gate: { thresholdDb: Number.isFinite(o.gateThresholdDb) ? o.gateThresholdDb : spec.thresholdDb,
    prerollMs: spec.prerollMs, holdMs: spec.holdMs }, micGain: o.micGain };
}

// The search and the warp, in a worker when there is one. The aligned take
// keeps the take's sample rate and runs the length of the source.
function locateTake(take, takeRate, source, sourceRate, onProgress) {
  const length = Math.round(source.length / sourceRate * takeRate), options = takeTrackOptions();
  if (canUseWorker()) {
    const t = take.slice(), s = source.slice();
    return startWorker({ type: 'locate', take: t.buffer, takeRate, source: s.buffer, sourceRate, length, options }, [t.buffer, s.buffer], onProgress)
      .promise.then(reply => ({ timeline: reply.timeline, aligned: new Float32Array(reply.aligned) }));
  }
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      const timeline = TF2Reference.track(take, takeRate, source, sourceRate, options);
      resolve({ timeline, aligned: TF2Reference.warpSegments(take, takeRate, timeline.segments, takeRate, length) });
    } catch (error) { reject(error); }
  }, 0));
}

function compareTakeJob(real, sim, rate) {
  if (canUseWorker()) {
    const r = real.slice(), s = sim.slice();
    return startWorker({ type: 'compareTake', real: r.buffer, sim: s.buffer, rate }, [r.buffer, s.buffer]).promise.then(reply => reply.report);
  }
  return new Promise(resolve => setTimeout(() => resolve(TF2Reference.compareTake(real, sim, rate)), 0));
}

async function loadReferenceTake(file) {
  if (!file || !state.decodedSource) return;
  const job = ++referenceJob;
  try {
    setReferenceStatus(`Decoding ${file.name}…`);
    if (!state.decodeCtx) state.decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await state.decodeCtx.decodeAudioData(await file.arrayBuffer());
    if (job !== referenceJob) return;
    if (decoded.duration > MAX_AUDIO_SECONDS * 1.5) throw new Error('takes are limited to 15 minutes');
    referenceDecoded = { decoded, name: file.name };
    await alignReferenceTake(job);
  } catch (error) {
    if (job === referenceJob) setReferenceStatus(`Could not use ${file.name}: ${error.message}`, 'reference-bad');
  }
}

async function alignReferenceTake(job = ++referenceJob) {
  if (!referenceDecoded || !state.decodedSource) return;
  const { decoded, name } = referenceDecoded;
  const take = takeChannel(decoded, els.referenceChannel ? els.referenceChannel.value : 'mix'), rate = decoded.sampleRate;
  const source = state.decodedSource.getChannelData(0), sourceRate = state.decodedSource.sampleRate;
  setReferenceStatus(`Finding the source in ${name}…`);
  try {
    const { timeline, aligned } = await locateTake(take, rate, source, sourceRate,
      (value) => { if (job === referenceJob) setReferenceStatus(`Finding the source in ${name}… ${Math.round(value * 100)}%`); });
    if (job !== referenceJob) return;
    clearReferenceTake(false);
    const overlap = timeline.overlap;
    const blob = URL.createObjectURL(TF2Audio.encodeWav(aligned, rate));
    state.realTake = { name, samples: aligned, rate, timeline, overlap, blob };
    if (els.audioReal) {
      els.audioReal.src = blob;
      els.audioReal.muted = state.abMode !== 'real';
      els.audioReal.volume = els.audio.volume;
      els.audioReal.playbackRate = els.audio.playbackRate;
      syncTwins(true);
      if (!els.audio.paused) els.audioReal.play().catch(() => {});
    }
    if (els.referenceClear) els.referenceClear.hidden = false;
    setReferenceStatus(`${name}: ${describeTiming(timeline)} It plays as the third A/B version (B cycles wet, dry, real).`, 'reference-good');
    const first = timeline.segments[0];
    logLine(`Reference: aligned "${name}" in ${timeline.segments.length} segment${timeline.segments.length === 1 ? '' : 's'} `
      + `(delay ${first.delayMs.toFixed(1)} ms first, clock ${first.clockPpm.toFixed(1)} ppm, ${timeline.points} windows, r ${timeline.correlation.toFixed(3)})`, 'sys');
    updateReferenceReport();
    updateMeter();
    refreshVisualizer();
  } catch (error) {
    if (job === referenceJob) setReferenceStatus(`Could not align ${name}: ${error.message}`, 'reference-bad');
  }
}

// The take's timing against the source, in words: TF2's receiver re-times
// talk spurts and trims latency in 256-sample (5.8 ms) skips.
function describeTiming(timeline) {
  const segs = timeline.segments;
  // Delay: take time minus source time (negative when the take starts
  // after the source does).
  const fmt = (ms) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)} s`;
  const delays = segs.map(g => g.delayMs);
  const steps = delays.slice(1).map((d, i) => d - delays[i]);
  const trims = steps.filter(d => Math.abs(Math.abs(d) - 1000 * 256 / 44100) < 0.8).length;
  const clock = segs[0].clockPpm;
  const spurts = timeline.spurts || 1;
  let text = segs.length === 1 ? `delay ${fmt(delays[0])} (take minus source)`
    : `${spurts} talk spurt${spurts === 1 ? '' : 's'} in ${segs.length} segments, delay ${fmt(Math.min(...delays))} to ${fmt(Math.max(...delays))}`
      + ` (take minus source; ${trims} 5.8 ms latency trim${trims === 1 ? '' : 's'}, ${steps.length - trims} other re-timing${steps.length - trims === 1 ? '' : 's'})`;
  text += `, clock ${clock >= 0 ? '+' : '−'}${Math.abs(clock).toFixed(0)} ppm, correlation ${timeline.correlation.toFixed(2)}${timeline.polarity < 0 ? ', polarity inverted' : ''}.`;
  return text;
}

// Remove the aligned take (and, unless keepFile, forget the decoded file).
function clearReferenceTake(forget = true) {
  if (state.realTake) URL.revokeObjectURL(state.realTake.blob);
  const had = !!state.realTake;
  state.realTake = null;
  if (els.audioReal) { els.audioReal.pause(); els.audioReal.removeAttribute('src'); els.audioReal.load(); }
  if (state.abMode === 'real') {
    state.abMode = 'wet';
    setAbMutes();
    els.abToggle.textContent = AB_LABELS.wet;
  }
  if (els.referenceReport) { els.referenceReport.hidden = true; els.referenceReport.replaceChildren(); }
  if (forget) {
    ++referenceJob;
    referenceDecoded = null;
    if (els.referenceFile) els.referenceFile.value = '';
    if (els.referenceClear) els.referenceClear.hidden = true;
    setReferenceStatus(REFERENCE_HELP);
    if (had) { updateMeter(); refreshVisualizer(); }
  }
}

const BAND_LABELS = ['40–80', '80–120', '120–200', '200–300', '300–500', '0.5–1k', '1–2k', '2–3k', '3–5k', '5–8k', '8–10k', '10–11k', '11–12k', '12–16k', '16–19k'];

// The simulation against the take over the part of the source the take covers.
async function updateReferenceReport() {
  const take = state.realTake, box = els.referenceReport;
  if (!box) return;
  box.hidden = !take;
  if (!take) return;
  const note = (text) => { const p = document.createElement('p'); p.textContent = text; return p; };
  if (!state.processedBuffer) { box.replaceChildren(note('Render the source to compare the simulation with the take.')); return; }
  const job = ++reportJob;
  box.replaceChildren(note('Comparing the render with the take…'));
  const sim = state.processedBuffer, rate = state.processedRate;
  const real = take.rate === rate ? take.samples : TF2Audio.resampleSinc(take.samples, take.rate, rate);
  const from = Math.max(0, Math.round(take.overlap.t0 * rate)), to = Math.min(sim.length, real.length, Math.round(take.overlap.t1 * rate));
  let report;
  try {
    if (to - from < rate) throw new Error('the take overlaps the source by less than a second');
    report = await compareTakeJob(real.subarray(from, to), sim.subarray(from, to), rate);
  } catch (error) {
    if (job === reportJob) box.replaceChildren(note(`Could not compare: ${error.message}`));
    return;
  }
  if (job !== reportJob || take !== state.realTake) return;
  const table = document.createElement('table');
  table.className = 'reference-bands';
  const caption = document.createElement('caption');
  caption.textContent = `Simulation minus take per band, dB, with the two level-matched at 300 Hz–3 kHz (${formatTime(take.overlap.t0, 1)}–${formatTime(take.overlap.t1, 1)})`;
  const head = document.createElement('tr'), body = document.createElement('tr');
  const cell = (tag, text, cls = '', title = '') => { const c = document.createElement(tag); c.textContent = text; if (cls) c.className = cls; if (title) c.title = title; return c; };
  head.append(cell('th', 'Hz'));
  body.append(cell('th', 'Δ', '', 'simulation minus take'));
  (report.bands || []).forEach((band, i) => {
    head.append(cell('th', BAND_LABELS[i] || band.hz));
    const d = band.simMinusRealDb;
    body.append(d === null ? cell('td', '—') : cell('td', `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`,
      Math.abs(d) <= 1.5 ? 'ref-good' : Math.abs(d) <= 3 ? 'ref-warn' : 'ref-bad'));
  });
  const thead = document.createElement('thead'), tbody = document.createElement('tbody');
  thead.append(head); tbody.append(body);
  table.append(caption, thead, tbody);
  const parts = [];
  const lt = report.levelTracking;
  if (lt) parts.push(`Short-term level: ${lt.rmsDeviationDb.toFixed(1)} dB rms apart, worst ${lt.worstDeviationDb.toFixed(1)} dB, r ${lt.correlation === null ? '—' : lt.correlation.toFixed(2)} (${lt.blocks} blocks of 0.5 s).`);
  const clip = report.clip || {};
  const sig = (s) => `ceiling ${s.ceilingDbfs.toFixed(1)} dBFS, ${s.clippedPercent.toFixed(1)}% at it, mean/ceiling ${s.meanOverCeiling.toFixed(2)}`;
  if (clip.real && clip.sim) parts.push(`Clipping: take ${sig(clip.real)}; simulation ${sig(clip.sim)}.`);
  if (Number.isFinite(report.anchorGainDb)) {
    const g = report.anchorGainDb;
    parts.push(`Level at 300 Hz–3 kHz: the simulation is ${Math.abs(g).toFixed(1)} dB ${g >= 0 ? 'louder' : 'quieter'} (volume and voice_scale set this).`);
  }
  box.replaceChildren(table, ...parts.map(note));
}

if (els.referenceFile) els.referenceFile.addEventListener('change', () => loadReferenceTake(els.referenceFile.files[0]));
if (els.referenceChannel) els.referenceChannel.addEventListener('change', () => { if (referenceDecoded) alignReferenceTake(); });
if (els.referenceClear) els.referenceClear.addEventListener('click', () => clearReferenceTake());
setReferenceStatus(REFERENCE_HELP);

/* ------------------------------------------------------------------ */
/* Visualizer                                                         */
/*                                                                    */
/* WAVE: peak + RMS envelope of the audible version; the samples      */
/*       themselves once zoomed in far enough.                        */
/* BARS: log-frequency spectrum in dBFS. Live from the AnalyserNode   */
/*       while playing; computed from the rendered buffer at the      */
/*       playhead when paused, with the analyser's own window/scale.  */
/* SPEC: spectrogram, linear or log frequency. The visible band is    */
/*       analysed in up to three tiers, each from a signal decimated  */
/*       to suit its top frequency. The FFT size follows the zoom so  */
/*       one window spans about as many pixels in time as one bin in  */
/*       frequency (like iZotope RX's auto-adjust), or is set by hand.*/
/*                                                                    */
/* Under WAVE and SPEC: an optional loudness lane (momentary and      */
/* short-term LUFS, wet and dry), the codec lane (what the voice path */
/* did with each 20 ms frame) and the time ruler.                     */
/*                                                                    */
/* Time: Ctrl/⌘ + wheel or a pinch zooms, a drag or Shift + wheel     */
/* pans, a click seeks, the − + FIT buttons and + − 0 ← → keys too.   */
/* Frequency (SPEC): the wheel over the left ruler, Alt or            */
/* Ctrl/⌘ + Shift + wheel over the view, ↑ ↓ keys; drag the ruler to  */
/* pan, double-click it to reset. Shift + drag selects a range for    */
/* the meter and the loop; Z zooms to it, Esc clears it, L loops.     */
/* ------------------------------------------------------------------ */

const ctx = els.canvas.getContext('2d', { alpha: false });
const VIZ = {
  minHz: 20, maxHz: 20000,   // BARS log-frequency axis
  minDb: -100, maxDb: -10,   // AnalyserNode dB scale (full-scale sine ~ -13.6)
  fftSize: 8192,             // BARS: 5.4-5.9 Hz bins, 170-186 ms window
  ranges: [48, 72, 96, 120], // selectable displayed dynamic range (SPEC, WAVE in dB)
  bandEdgeHz: 12000,         // Opus super-wideband edge used by the Steam profile
  logMinHz: 20,              // floor of the log spectrogram
  minFreqSpanHz: 40,         // deepest frequency zoom, linear axis
  minFreqRatio: 1.3,         // deepest frequency zoom, log axis (top / bottom)
  fftMin: 64, fftMax: 16384, // FFT sizes, in samples of the analysed (decimated) signal
  maxWindowSec: 1.4,         // longest AUTO analysis window
  maxDecimation: 64,
  maxColumns: 1600,          // spectrogram columns per image (stretched to the canvas)
  minSpanSamples: 48,        // deepest time zoom: this many samples across the view
  rulerH: 16, laneH: 12,     // px: time ruler and codec lane under WAVE / SPEC
  lufsFrac: 0.26, lufsMinH: 48, lufsTop: 0, lufsFloor: -48,
  freqRulerW: 36,            // px: the SPEC frequency ruler along the left edge
  tallHeight: 520            // px, the TALL view
};
els.vizContainer = document.getElementById('viz-container');
els.vizLog = document.getElementById('viz-log');
els.vizZoomIn = document.getElementById('viz-zoom-in');
els.vizZoomOut = document.getElementById('viz-zoom-out');
els.vizFit = document.getElementById('viz-fit');
els.vizTall = document.getElementById('viz-tall');
els.vizRange = document.getElementById('viz-range');
els.vizRes = document.getElementById('viz-res');
els.vizLufs = document.getElementById('viz-lufs');
els.vizLoop = document.getElementById('viz-loop');
els.vizLegend = document.getElementById('viz-legend');
els.vizAvg = document.getElementById('viz-avg');
state.vizScale = LS.get('tf2ve_viz_scale', 'lin') === 'log' ? 'log' : 'lin';
state.waveScale = LS.get('tf2ve_wave_scale', 'lin') === 'db' ? 'db' : 'lin';
state.vizRange = VIZ.ranges.includes(Number(LS.get('tf2ve_viz_range', 72))) ? Number(LS.get('tf2ve_viz_range', 72)) : 72;
state.specRes = (() => { const v = LS.get('tf2ve_spec_res', 'auto'); return v === 'auto' || [256, 512, 1024, 2048, 4096, 8192, 16384].includes(Number(v)) ? v : 'auto'; })();
state.showLufs = LS.get('tf2ve_lufs_lane', false) === true;
state.loop = false;
let vizPeaks = null, vizPeakTime = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  // Only touch the backing store when the size really changed: assigning
  // canvas.width clears it.
  if (els.canvas.width !== W || els.canvas.height !== H) {
    els.canvas.width = W;
    els.canvas.height = H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { w: rect.width, h: rect.height, dpr };
}

// Inferno-like palette for the spectrogram, 256 entries.
const PALETTE = (() => {
  const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  return lut;
})();

const dbToUnit = (value) => Math.min(1, Math.max(0, (value - VIZ.minDb) / (VIZ.maxDb - VIZ.minDb)));
const hzToX = (hz, w, top) => w * Math.log(hz / VIZ.minHz) / Math.log(top / VIZ.minHz);

// Log-spaced [fromBin, toBin] ranges for `count` bars/rows.
function logBands(count, sampleRate, fftSize) {
  const top = Math.min(VIZ.maxHz, sampleRate / 2), binHz = sampleRate / fftSize, bands = [];
  for (let i = 0; i < count; i++) {
    const lo = VIZ.minHz * Math.pow(top / VIZ.minHz, i / count);
    const hi = VIZ.minHz * Math.pow(top / VIZ.minHz, (i + 1) / count);
    bands.push([lo / binHz, hi / binHz]);
  }
  return bands;
}

// Max over each band; narrow low bands interpolate between bins.
function bandLevels(spectrumDb, bands, out) {
  const last = spectrumDb.length - 1;
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i];
    let value = -Infinity;
    if (hi - lo < 1) {
      const pos = Math.min(last, (lo + hi) / 2), k = Math.floor(pos), f = pos - k;
      value = spectrumDb[k] * (1 - f) + spectrumDb[Math.min(last, k + 1)] * f;
    } else {
      for (let k = Math.ceil(lo); k <= Math.min(last, Math.floor(hi)); k++) value = Math.max(value, spectrumDb[k]);
    }
    out[i] = Number.isFinite(value) ? value : VIZ.minDb;
  }
  return out;
}

const blackman = (() => {
  const cache = new Map();
  return (n) => {
    if (!cache.has(n)) cache.set(n, Float32Array.from({ length: n },
      (_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n)));
    return cache.get(n);
  };
})();

// Radix-2 FFT plans: bit-reversal and twiddle tables and work buffers,
// made once per size.
const fftPlans = new Map();
function fftPlan(n) {
  let plan = fftPlans.get(n);
  if (!plan) {
    const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | (i & 1 ? n >> 1 : 0);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    plan = { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n), win: blackman(n) };
    fftPlans.set(n, plan);
  }
  return plan;
}

// Blackman-windowed FFT of `samples` centred on `center` (zero outside);
// leaves the spectrum in plan.re / plan.im.
function windowedFft(plan, samples, center) {
  const { n, rev, cos, sin, re, im, win } = plan;
  const start = Math.round(center - n / 2);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    re[rev[i]] = (j >= 0 && j < samples.length ? samples[j] : 0) * win[i];
  }
  im.fill(0);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0, t = 0; k < half; k++, t += stride) {
        const a = i + k, b = a + half, wr = cos[t], wi = sin[t];
        const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
      }
    }
  }
}

// Same windowing and scaling as AnalyserNode.getFloatFrequencyData.
function spectrumAt(samples, center, fftSize, out) {
  const plan = fftPlan(fftSize);
  windowedFft(plan, samples, center);
  for (let k = 0; k < fftSize / 2; k++) out[k] = 20 * Math.log10(Math.hypot(plan.re[k], plan.im[k]) / fftSize + 1e-12);
  return out;
}

// The version the listener hears: processed (wet) or original (dry).
function audibleBuffer() {
  if (state.abMode === 'real' && state.realTake) return { samples: state.realTake.samples, rate: state.realTake.rate, label: 'REAL' };
  if (state.abMode === 'dry' && state.decodedSource) {
    return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'DRY' };
  }
  if (state.processedBuffer) return { samples: state.processedBuffer, rate: state.processedRate, label: 'WET' };
  if (state.decodedSource) return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'SOURCE' };
  return null;
}

// A stable id per sample array, so cached images never outlive their audio.
const bufferIds = new WeakMap();
let nextBufferId = 1;
function bufferId(samples) {
  if (!bufferIds.has(samples)) bufferIds.set(samples, nextBufferId++);
  return bufferIds.get(samples);
}

function playheadFraction() {
  const d = els.audio.duration;
  return Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, els.audio.currentTime / d)) : 0;
}

/* ---------------- time view (zoom and pan) and selection ---------------- */

// Visible time range in seconds; t1 = Infinity runs to the end of the file.
const vizView = { t0: 0, t1: Infinity };
let vizSel = null;   // selected time range { t0, t1 } in seconds, or null
function resetVizView() {
  vizView.t0 = 0;
  vizView.t1 = Infinity;
  resetFreqView();
  setSelection(null);
}

function visibleRange(buffer) {
  const duration = Math.max(buffer.samples.length / buffer.rate, 1e-6);
  const minSpan = Math.min(duration, VIZ.minSpanSamples / buffer.rate);
  const end = Number.isFinite(vizView.t1) ? vizView.t1 : duration;
  const span = Math.min(duration, Math.max(minSpan, end - vizView.t0));
  const t0 = Math.min(Math.max(0, vizView.t0), duration - span);
  return { t0, t1: t0 + span, duration, minSpan, zoomed: span < duration * (1 - 1e-9) };
}

function setVizView(start, span, duration) {
  const t0 = Math.min(Math.max(0, start), Math.max(0, duration - span));
  vizView.t0 = t0;
  vizView.t1 = t0 + span >= duration * (1 - 1e-9) ? Infinity : t0 + span;
  refreshVisualizer();
}

// Zoom by `factor` (< 1 zooms in) keeping the time at `anchor` (0..1 across the view) in place.
function zoomViz(factor, anchor = null) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode === 'bars') return;
  const r = visibleRange(buffer), span = r.t1 - r.t0;
  if (anchor === null) {
    // Buttons and keys zoom around the playhead when it is in view.
    const t = els.audio.currentTime;
    anchor = els.audio.src && t >= r.t0 && t <= r.t1 ? (t - r.t0) / span : 0.5;
  }
  const next = Math.min(r.duration, Math.max(r.minSpan, span * factor));
  setVizView(r.t0 + anchor * span - anchor * next, next, r.duration);
}

function panViz(fraction) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode === 'bars') return;
  const r = visibleRange(buffer);
  setVizView(r.t0 + fraction * (r.t1 - r.t0), r.t1 - r.t0, r.duration);
}

let selectionTimer = 0;
function setSelection(range) {
  const next = range && range.t1 - range.t0 > 1e-4 ? { t0: Math.max(0, range.t0), t1: range.t1 } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(vizSel);
  vizSel = next;
  if (!changed) return;
  applyLoop();
  // The meter follows the selection once it settles.
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => { if (typeof updateMeter === 'function') updateMeter(); }, 150);
}

function zoomToSelection() {
  const buffer = audibleBuffer();
  if (!buffer || !vizSel || state.vizMode === 'bars') return;
  const r = visibleRange(buffer), span = vizSel.t1 - vizSel.t0;
  // A little room either side, as editors do.
  setVizView(vizSel.t0 - span * 0.05, Math.max(r.minSpan, span * 1.1), r.duration);
}

/* ---------------- frequency view (SPEC) ---------------- */

// Visible band in Hz; null ends run to the full band.
const vizFreq = { lo: null, hi: null };
function specTop(rate) { return Math.min(VIZ.maxHz, rate / 2); }

function freqRange(rate, scale = state.vizScale) {
  const top = specTop(rate), floor = scale === 'log' ? VIZ.logMinHz : 0;
  let lo = Math.max(floor, Math.min(vizFreq.lo ?? floor, top));
  let hi = Math.min(top, Math.max(vizFreq.hi ?? top, lo));
  if (scale === 'log') {
    if (hi / lo < VIZ.minFreqRatio) { hi = Math.min(top, lo * VIZ.minFreqRatio); lo = hi / VIZ.minFreqRatio; }
  } else if (hi - lo < VIZ.minFreqSpanHz) {
    hi = Math.min(top, lo + VIZ.minFreqSpanHz); lo = Math.max(floor, hi - VIZ.minFreqSpanHz);
  }
  return { lo, hi, top, floor, scale, zoomed: lo > floor * 1.0001 + 1e-6 || hi < top * 0.9999 };
}
// The axis is linear in Hz or in log Hz; d() maps a frequency onto it.
const freqDomain = (scale) => (scale === 'log' ? Math.log : (f) => f);
const freqUndomain = (scale) => (scale === 'log' ? Math.exp : (d) => d);

// Frequency at height fraction u (0 = bottom, 1 = top) of the visible band.
function specHz(u, rate, scale = state.vizScale) {
  const r = freqRange(rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  return inv(d(r.lo) + u * (d(r.hi) - d(r.lo)));
}
function hzToU(hz, rate, scale = state.vizScale) {
  const r = freqRange(rate, scale), d = freqDomain(scale);
  return (d(Math.max(hz, 1e-9)) - d(r.lo)) / (d(r.hi) - d(r.lo));
}

function setFreqView(lo, hi, rate) {
  const full = freqRange(rate, state.vizScale);
  const floor = full.floor, top = full.top;
  if (lo <= floor * 1.0001 + 1e-6 && hi >= top * 0.9999) { vizFreq.lo = null; vizFreq.hi = null; }
  else { vizFreq.lo = Math.max(floor, lo); vizFreq.hi = Math.min(top, hi); }
  refreshVisualizer();
}

// Zoom the frequency axis by `factor` (< 1 zooms in) around height fraction `anchor`.
function zoomFreq(factor, anchor = 0.5) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode !== 'spec') return;
  const scale = state.vizScale, r = freqRange(buffer.rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  const d0 = d(r.lo), d1 = d(r.hi), dFloor = d(r.floor), dTop = d(r.top);
  const minSpan = scale === 'log' ? Math.log(VIZ.minFreqRatio) : VIZ.minFreqSpanHz;
  const span = Math.min(dTop - dFloor, Math.max(minSpan, (d1 - d0) * factor));
  const at = d0 + anchor * (d1 - d0);
  const start = Math.min(Math.max(dFloor, at - anchor * span), dTop - span);
  setFreqView(inv(start), inv(start + span), buffer.rate);
}

function panFreq(fraction) {
  const buffer = audibleBuffer();
  if (!buffer || state.vizMode !== 'spec') return;
  const scale = state.vizScale, r = freqRange(buffer.rate, scale), d = freqDomain(scale), inv = freqUndomain(scale);
  const d0 = d(r.lo), d1 = d(r.hi), span = d1 - d0, dFloor = d(r.floor), dTop = d(r.top);
  const start = Math.min(Math.max(dFloor, d0 + fraction * span), dTop - span);
  setFreqView(inv(start), inv(start + span), buffer.rate);
}

function resetFreqView() { vizFreq.lo = null; vizFreq.hi = null; }

/* ---------------- layout ---------------- */

// The per-frame log of the last render, if its codec ran.
function codecFrames() {
  const info = state.lastCodecInfo;
  return info && info.frameLog && state.processedBuffer ? info : null;
}

// WAVE and SPEC: the image on top, then the loudness lane (if on), the
// codec lane (after a render with the codec) and the time ruler.
function vizLayout(w, h) {
  const time = state.vizMode !== 'bars';
  const rulerH = time ? VIZ.rulerH : 0;
  const laneH = time && codecFrames() ? VIZ.laneH : 0;
  let lufsH = time && state.showLufs ? Math.max(VIZ.lufsMinH, Math.round(h * VIZ.lufsFrac)) : 0;
  if (h - rulerH - laneH - lufsH < 40) lufsH = 0;
  const mainH = Math.max(20, h - rulerH - laneH - lufsH);
  return { w, h, mainH, lufsY: mainH, lufsH, laneY: mainH + lufsH, laneH, rulerY: mainH + lufsH + laneH, rulerH };
}

function regionAt(layout, y) {
  if (y < layout.mainH) return 'main';
  if (y < layout.laneY) return 'lufs';
  if (y < layout.rulerY) return 'lane';
  return 'ruler';
}

/* ---------------- drawing helpers ---------------- */

function drawBackdrop(w, h, y = 0) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, y, w, h);
}

function drawLabel(text, x, y, color = 'rgba(200, 210, 220, 0.75)', align = 'left') {
  ctx.font = '9px Verdana, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// A label on a dark plate, kept inside the canvas.
function drawTag(text, x, y, w, color = 'rgba(230, 238, 245, 0.95)') {
  ctx.font = '10px Verdana, sans-serif';
  const width = ctx.measureText(text).width + 8;
  const left = Math.max(0, Math.min(w - width, x));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)'; ctx.fillRect(left, y, width, 14);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = color;
  ctx.fillText(text, left + 4, y + 2);
}

// A small label on a translucent plate, for text over the images.
function drawPlate(text, x, y) {
  ctx.font = '9px Verdana, sans-serif';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'; ctx.fillRect(x - 2, y - 1, ctx.measureText(text).width + 6, 12);
  drawLabel(text, x + 1, y + 1, 'rgba(210, 220, 230, 0.9)');
}

function formatTime(t, decimals = 0) {
  const minutes = Math.floor(t / 60), seconds = t - minutes * 60;
  return `${minutes}:${seconds.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`;
}
const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${hz.toFixed(hz < 100 ? 1 : 0)} Hz`);
// Nearest equal-tempered note (A4 = 440 Hz) and its offset in cents.
function noteName(hz) {
  if (!(hz >= 16 && hz <= 20000)) return '';
  const n = Math.round(12 * Math.log2(hz / 440)), cents = Math.round(1200 * Math.log2(hz / 440) - 100 * n);
  const names = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
  const name = names[((n % 12) + 12) % 12], octave = 4 + Math.floor((n + 9) / 12);
  return `${name}${octave}${cents ? ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢` : ''}`;
}

function drawFrequencyGrid(w, h, top, labels) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 1;
  for (const hz of [100, 1000, 10000]) {
    if (hz >= top) continue;
    const x = Math.round(hzToX(hz, w, top)) + 0.5;
    if (labels) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(x + 1, h - 12, 22, 11);
      drawLabel(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 11);
    } else { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  }
  if (VIZ.bandEdgeHz < top) {
    const x = Math.round(hzToX(VIZ.bandEdgeHz, w, top)) + 0.5;
    if (labels) drawLabel('12k', x + 3, 16, 'rgba(255, 184, 34, 0.85)');
    else {
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255, 184, 34, 0.35)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.restore();
    }
  }
}

function drawBars(levels, w, h, top, now) {
  drawBackdrop(w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(h * (1 - dbToUnit(dbLine))) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  drawFrequencyGrid(w, h, top, false);
  const count = levels.length, slot = w / count, barW = Math.max(1, slot - 1);
  if (!vizPeaks || vizPeaks.length !== count) vizPeaks = new Float32Array(count);
  const dt = vizPeakTime ? Math.min(0.1, (now - vizPeakTime) / 1000) : 0;
  vizPeakTime = now;
  for (let i = 0; i < count; i++) {
    const u = dbToUnit(levels[i]);
    vizPeaks[i] = Math.max(u, vizPeaks[i] - dt * 0.5);       // caps fall 50%/s
    const barH = u * h;
    ctx.fillStyle = `hsl(${Math.round(205 - 205 * Math.min(1, u * 1.15))}, 85%, ${40 + 20 * u}%)`;
    ctx.fillRect(i * slot, h - barH, barW, barH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(i * slot, Math.round(h - vizPeaks[i] * h) - 1, barW, 1.5);
  }
  drawFrequencyGrid(w, h, top, true);
}

function drawPlayhead(w, h, range) {
  if (!els.audio.src) return;
  const t = els.audio.currentTime;
  if (t < range.t0 || t > range.t1) return;
  const x = Math.round((t - range.t0) / (range.t1 - range.t0) * w) + 0.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

// The time ruler: its own strip under the lanes, ticks at least ~70 px apart.
function drawTimeRuler(w, y, hR, range) {
  ctx.fillStyle = '#0b0e12'; ctx.fillRect(0, y, w, hR);
  const span = range.t1 - range.t0;
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s / span * w >= 70) || 600;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
  for (let k = Math.ceil(range.t0 / step - 1e-9); k * step <= range.t1 + 1e-9; k++) {
    const x = Math.round((k * step - range.t0) / span * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 4); ctx.stroke();
    if (x + 44 < w) drawLabel(formatTime(k * step, decimals), x + 3, y + 4, 'rgba(210, 220, 230, 0.85)');
  }
}

// "Nice" frequency ticks for the visible band, at least `minGap` px apart:
// on the log axis the densest of 1-2-...-9, 1-2-5 and 1 per decade that
// fits (a linear series on a very deep zoom), on the linear axis a 1-2-5
// step.
function freqTicks(r, height, minGap = 22) {
  const d = freqDomain(r.scale), span = d(r.hi) - d(r.lo);
  const px = (hz) => (d(hz) - d(r.lo)) / span * height;
  let out = [];
  if (r.scale === 'log') {
    const series = (mantissas) => {
      const list = [];
      for (let e = Math.floor(Math.log10(Math.max(r.lo, 1))); e <= Math.ceil(Math.log10(r.hi)); e++) {
        for (const m of mantissas) { const hz = m * 10 ** e; if (hz >= r.lo && hz <= r.hi) list.push(hz); }
      }
      return list;
    };
    const spaced = (list) => list.every((hz, i) => !i || px(hz) - px(list[i - 1]) >= minGap);
    out = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 5], [1]].map(series).find(spaced) || series([1]);
    if (out.length < 3) return freqTicks({ ...r, scale: 'lin' }, height, minGap);
  } else {
    const target = Math.max(2, height / (minGap * 1.8));
    const raw = (r.hi - r.lo) / target, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || 10 * p;
    for (let hz = Math.ceil(r.lo / step) * step; hz <= r.hi + 1e-9; hz += step) out.push(+hz.toFixed(6));
  }
  // Thin to the minimum spacing, keeping the band edge when it is in view.
  const kept = [];
  for (const hz of out) if (!kept.length || Math.abs(px(hz) - px(kept[kept.length - 1])) >= minGap) kept.push(hz);
  if (VIZ.bandEdgeHz > r.lo && VIZ.bandEdgeHz < r.hi && !kept.includes(VIZ.bandEdgeHz)) kept.push(VIZ.bandEdgeHz);
  return kept;
}
const tickLabel = (hz) => (hz >= 1000 ? `${+(hz / 1000).toFixed(hz % 1000 ? 2 : 0)}k` : `${+hz.toFixed(hz < 10 ? 1 : 0)}`);

// The frequency ruler on the left of SPEC: interactive (wheel zooms, drag pans).
function drawFrequencyAxisLabels(w, h, rate) {
  const r = freqRange(rate);
  ctx.fillStyle = r.zoomed ? 'rgba(102, 192, 244, 0.10)' : 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, VIZ.freqRulerW - 8, h);
  for (const hz of freqTicks(r, h)) {
    const y = h - h * hzToU(hz, rate);
    if (y < 1 || y > h - 1) continue;
    const edge = hz === VIZ.bandEdgeHz;
    ctx.strokeStyle = edge ? 'rgba(255, 184, 34, 0.45)' : 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath(); ctx.moveTo(VIZ.freqRulerW - 12, Math.round(y) + 0.5); ctx.lineTo(VIZ.freqRulerW - 4, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(1, Math.max(0, y - 10), VIZ.freqRulerW - 12, 10);
    drawLabel(tickLabel(hz), 3, Math.max(0, y - 10), edge ? 'rgba(255, 184, 34, 0.95)' : 'rgba(220, 230, 240, 0.9)');
  }
}

/* ---------------- static images of the visible range ---------------- */

// The last WAVE or SPEC image: { base, key, canvas, t0, t1, ... }. `base`
// names what it shows apart from the time and frequency range; while a new
// range is computed, the last image with the same base is drawn stretched
// to it.
let vizImage = null;
let vizPending = null, specJob = 0, specTimer = 0;
const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

function imageBase(buffer) {
  const scale = state.vizMode === 'spec' ? state.vizScale : state.waveScale === 'db' ? `db${state.vizRange}` : 'lin';
  return `${state.vizMode}:${scale}:${bufferId(buffer.samples)}:${buffer.rate}`;
}

// Height fraction (0..1 from the centre line) of a sample value on the
// waveform: linear, or dBFS down to the selected range.
function waveMapper() {
  if (state.waveScale !== 'db') return (v) => v;
  const floor = -state.vizRange;
  return (v) => {
    const a = Math.abs(v);
    if (a <= 0) return 0;
    const u = Math.max(0, 1 - (20 * Math.log10(a)) / floor);
    return v < 0 ? -u : u;
  };
}
// Amplitude grid levels in dBFS for the current waveform scale.
function waveGridDb() {
  return state.waveScale === 'db' ? [-6, -12, -24, -48, -72, -96].filter(d => d > -state.vizRange) : [-6];
}

function renderWaveImage(buffer, W, H, range) {
  const image = document.createElement('canvas');
  image.width = W; image.height = H;
  const g = image.getContext('2d', { alpha: false });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const mid = H / 2, map = waveMapper();
  g.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  g.beginPath();
  g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(W, Math.round(mid) + 0.5);
  for (const dbLevel of waveGridDb()) {
    const u = map(Math.pow(10, dbLevel / 20));
    for (const y of [mid - u * mid, mid + u * mid]) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); }
  }
  g.stroke();
  const data = buffer.samples, first = range.t0 * buffer.rate;
  const clip = 0.999;   // full scale: samples here clip when saved as 16-bit
  const perPixel = (range.t1 - range.t0) * buffer.rate / W;
  if (perPixel >= 2) {
    for (let x = 0; x < W; x++) {
      const from = Math.max(0, Math.floor(first + x * perPixel));
      const to = Math.min(data.length, Math.max(from + 1, Math.floor(first + (x + 1) * perPixel)));
      let min = 0, max = 0, sq = 0;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < min) min = v; if (v > max) max = v;
        sq += v * v;
      }
      const rmsValue = Math.sqrt(sq / Math.max(1, to - from));
      const top = map(max), bottom = map(min), r = map(rmsValue);
      g.fillStyle = '#2a5f86';
      g.fillRect(x, mid - top * mid, 1, Math.max(1, (top - bottom) * mid));
      g.fillStyle = '#66c0f4';
      g.fillRect(x, mid - r * mid, 1, Math.max(1, 2 * r * mid));
      if (max >= clip || min <= -clip) {
        g.fillStyle = '#ff4040';
        g.fillRect(x, 0, 1, 3); g.fillRect(x, H - 3, 1, 3);
      }
    }
  } else {
    // Zoomed in to single samples: the sample values joined by lines, and
    // dots once they are far enough apart.
    const i0 = Math.max(0, Math.floor(first) - 1), i1 = Math.min(data.length - 1, Math.ceil(first + W * perPixel) + 1);
    g.strokeStyle = '#66c0f4'; g.lineWidth = Math.max(1, Math.round(H / 180));
    g.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = (i - first) / perPixel, y = mid - map(data[i]) * mid;
      if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    if (perPixel < 0.15) {
      const r = Math.max(2, Math.round(H / 120));
      for (let i = i0; i <= i1; i++) {
        g.fillStyle = Math.abs(data[i]) >= clip ? '#ff4040' : '#d7efff';
        g.fillRect((i - first) / perPixel - r / 2, mid - map(data[i]) * mid - r / 2, r, r);
      }
    }
  }
  return { canvas: image, t0: range.t0, t1: range.t1 };
}

// The signal decimated by 2, 4, ... VIZ.maxDecimation for the lower bands of
// the spectrogram. Each level halves the one above with the renderer's
// Kaiser-windowed sinc (flat to 0.83 of the new Nyquist, 86 dB stopband),
// in slices so the page stays responsive. Sample i of the level for factor
// D is sample D * i of the input; the spectrogram reads each level only up
// to 0.4 of its rate.
const decimations = new WeakMap();
function decimated(samples, factor) {
  let levels = decimations.get(samples);
  if (!levels) decimations.set(samples, levels = new Map([[1, Promise.resolve(samples)]]));
  if (!levels.has(factor)) {
    const level = decimated(samples, factor / 2).then(halve);
    level.catch(() => levels.delete(factor));
    levels.set(factor, level);
  }
  return levels.get(factor);
}
async function halve(x) {
  const out = new Float32Array(Math.max(1, Math.round(x.length / 2)));
  // resampleSinc reads 32 inputs either side of each output.
  const margin = 64, block = 1 << 17;
  for (let s = 0; s < x.length; s += block) {
    const from = Math.max(0, s - margin), to = Math.min(x.length, s + block + margin);
    const part = TF2Audio.resampleSinc(x.subarray(from, to), 2, 1);
    const offset = (s - from) / 2, count = Math.min(block / 2, out.length - s / 2);
    out.set(part.subarray(offset, offset + count), s / 2);
    await yieldToUi();
  }
  return out;
}

// How the spectrogram analyses the visible band. The rows are split into
// tiers, each read from the signal decimated as far as its top frequency
// allows: one tier on the linear axis, one per octave-ish band on the log
// axis. The FFT size of a tier is fixed (RES) or, on AUTO, sized to the
// view: a Blackman window of T seconds smears about 0.4 T in time and
// 2.35 / T in frequency (its -6 dB widths), so T = 2.4 * sqrt(column
// seconds / row Hz) would blur as many pixels one way as the other. AUTO
// uses 3.4 instead of 2.4, blurring about twice as many pixels in time as
// in frequency: tones, harmonics and hum stay sharp and onsets soften a
// little. Zooming in time shortens the window; zooming in frequency, or
// going lower on the log axis, lengthens it.
function specPlan(rate, H, colSec) {
  const r = freqRange(rate), log = r.scale === 'log';
  const fixed = state.specRes === 'auto' ? 0 : Number(state.specRes);
  // A fixed size keeps at least VIZ.fftMin points after decimation.
  const maxD = fixed ? Math.max(1, Math.min(VIZ.maxDecimation, fixed / VIZ.fftMin)) : VIZ.maxDecimation;
  const decimationFor = (hz) => { let D = 1; while (D < maxD && hz <= 0.4 * rate / (D * 2)) D *= 2; return D; };
  const edges = Float64Array.from({ length: H + 1 }, (_, i) => specHz(i / H, rate));
  const tiers = new Map(), rowTier = new Uint8Array(H);
  const linearD = decimationFor(r.hi);
  for (let row = 0; row < H; row++) {
    const D = log ? decimationFor(edges[row + 1]) : linearD;
    if (!tiers.has(D)) tiers.set(D, { D, rows: [] });
    tiers.get(D).rows.push(row);
  }
  const list = [...tiers.values()].sort((a, b) => b.D - a.D);
  const perRow = (freqDomain(r.scale)(r.hi) - freqDomain(r.scale)(r.lo)) / H;
  list.forEach((tier, index) => {
    tier.rate = rate / tier.D;
    let N;
    if (fixed) N = fixed / tier.D;
    else {
      // Row height in Hz at the tier's centre (on the log axis df = f d(ln f)).
      const first = edges[tier.rows[0]], last = edges[tier.rows[tier.rows.length - 1] + 1];
      const rowHz = log ? Math.sqrt(first * last) * perRow : perRow;
      const T = Math.min(VIZ.maxWindowSec, 3.4 * Math.sqrt(colSec / rowHz));
      N = 2 ** Math.round(Math.log2(Math.max(1, T * tier.rate)));
    }
    tier.fft = Math.min(VIZ.fftMax, Math.max(VIZ.fftMin, N));
    tier.windowSec = tier.fft / tier.rate;
    tier.binHz = tier.rate / tier.fft;
    for (const row of tier.rows) rowTier[row] = index;
  });
  return { tiers: list, edges, rowTier, fixed };
}

// Spectrogram of the visible range, computed a few columns at a time. When a
// column spans more than half a window, up to four windows are max-held so
// short events are not missed. Levels are dB (a full-scale sine reads about
// -13.6, as in BARS) on the linear axis; on the log axis, where tiers differ
// in resolution, they are per Hz so noise stays continuous across them.
async function renderSpectrogram(job, buffer, W, H, range, fr, base, key) {
  const { samples, rate } = buffer;
  const log = fr.scale === 'log';
  const cols = Math.min(W, VIZ.maxColumns);
  const step = (range.t1 - range.t0) * rate / cols;
  const plan = specPlan(rate, H, step / rate);
  for (const tier of plan.tiers) {
    tier.data = await decimated(samples, tier.D);
    if (job !== specJob) return;
    tier.bands = tier.rows.map(row => [plan.edges[row] / tier.binHz, plan.edges[row + 1] / tier.binHz]);
    tier.plan = fftPlan(tier.fft);
    tier.spectrum = new Float32Array(tier.fft / 2);
    tier.level = new Float32Array(tier.rows.length);
    tier.norm = log ? -10 * Math.log10(tier.binHz) : 0;
    tier.hops = Math.max(1, Math.min(4, Math.round(step / tier.D / (tier.fft / 2))));
  }
  const grid = new Float32Array(cols * H);
  let yieldAt = performance.now() + 12;
  for (let x = 0; x < cols; x++) {
    const column = grid.subarray(x * H, (x + 1) * H);
    column.fill(-400);
    const start = range.t0 * rate + x * step;
    for (const tier of plan.tiers) {
      for (let hop = 0; hop < tier.hops; hop++) {
        windowedFft(tier.plan, tier.data, (start + (hop + 0.5) * step / tier.hops) / tier.D);
        const { re, im, n } = tier.plan;
        for (let k = 0; k < n / 2; k++) tier.spectrum[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (n * n) + 1e-24) + tier.norm;
        bandLevels(tier.spectrum, tier.bands, tier.level);
        for (let i = 0; i < tier.rows.length; i++) if (tier.level[i] > column[tier.rows[i]]) column[tier.rows[i]] = tier.level[i];
      }
    }
    if (performance.now() > yieldAt) {
      await yieldToUi();
      if (job !== specJob) return;
      yieldAt = performance.now() + 12;
    }
  }
  // Scale each image to its own loud end so band edges stay visible on
  // loud, clipped renders: the colours span the selected range below the
  // 99th-percentile level.
  const sorted = grid.filter((_, i) => i % 7 === 0).sort();
  const topDb = sorted[Math.floor(sorted.length * 0.99)] ?? VIZ.maxDb;
  const tiers = plan.tiers.map(({ D, fft, rate: tierRate, windowSec, binHz }) => ({ D, fft, rate: tierRate, windowSec, binHz }));
  vizImage = { base, key, canvas: document.createElement('canvas'), t0: range.t0, t1: range.t1, lo: fr.lo, hi: fr.hi, scale: fr.scale,
    grid, cols, rows: H, log, topDb, tiers, rowTier: plan.rowTier, fixed: plan.fixed };
  paintSpectrogram(vizImage);
  vizPending = null;
  refreshVisualizer();
}

// Colour a computed spectrogram grid for the selected range (cheap; redone
// when only the range changes).
function paintSpectrogram(image) {
  const { grid, cols, rows: H, topDb } = image, span = state.vizRange;
  image.canvas.width = cols; image.canvas.height = H;
  const g = image.canvas.getContext('2d');
  const pixels = g.createImageData(cols, H);
  for (let x = 0; x < cols; x++) {
    for (let r = 0; r < H; r++) {
      const u = Math.min(1, Math.max(0, (grid[x * H + r] - topDb + span) / span));
      const c = Math.round(u * 255) * 3, p = ((H - 1 - r) * cols + x) * 4;
      pixels.data[p] = PALETTE[c]; pixels.data[p + 1] = PALETTE[c + 1]; pixels.data[p + 2] = PALETTE[c + 2]; pixels.data[p + 3] = 255;
    }
  }
  g.putImageData(pixels, 0, 0);
  image.range = span;
}

// The analysis resolution of a spectrogram image, for the corner label.
function describeResolution(img) {
  if (!img || !img.tiers) return '';
  const ms = (s) => (s < 0.1 ? (s * 1000).toFixed(1) : (s * 1000).toFixed(0));
  const windows = img.tiers.map(t => t.windowSec);
  const lo = Math.min(...windows), hi = Math.max(...windows);
  const mode = img.fixed ? `FFT ${img.fixed}` : 'AUTO';
  if (img.tiers.length === 1) return `${mode} · ${ms(lo)} ms · ${formatHz(img.tiers[0].binHz)} bins`;
  return `${mode} · ${ms(lo)}–${ms(hi)} ms windows`;
}

// Colour scale at the right edge of the spectrogram.
function drawColorbar(w, h) {
  const img = vizImage;
  if (!img || !img.grid) return;
  const x = w - 12, top = 8, bottom = h - 8, height = bottom - top;
  if (height < 40) return;
  for (let y = 0; y < height; y++) {
    const c = Math.round((1 - y / height) * 255) * 3;
    ctx.fillStyle = `rgb(${PALETTE[c]}, ${PALETTE[c + 1]}, ${PALETTE[c + 2]})`;
    ctx.fillRect(x, top + y, 7, 1);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.strokeRect(x - 0.5, top - 0.5, 8, height + 1);
  const unit = img.log ? ' dB/Hz' : ' dB';
  for (const [value, y] of [[img.topDb, top], [img.topDb - img.range, bottom - 10]]) {
    const text = `${value.toFixed(0)}${y === top ? unit : ''}`;
    ctx.font = '9px Verdana, sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(x - tw - 7, y, tw + 5, 11);
    drawLabel(text, x - 4, y + 1, 'rgba(220, 230, 240, 0.85)', 'right');
  }
}

function requestSpectrogram(buffer, W, H, range, fr, base, key) {
  if (vizPending === key) return;
  vizPending = key;
  clearTimeout(specTimer);
  const job = ++specJob;
  // Right away when nothing comparable is on screen; otherwise once a zoom or
  // pan gesture settles, showing the stretched last image meanwhile.
  const delay = vizImage && vizImage.base === base ? 90 : 0;
  specTimer = setTimeout(() => {
    renderSpectrogram(job, buffer, W, H, range, fr, base, key).catch((error) => {
      if (job === specJob) { vizPending = null; logLine(`spectrogram failed: ${error.message}`, 'err'); }
    });
  }, delay);
}

// Draw the part of `img` that overlaps the view, stretched to it. SPEC images
// also map their frequency band onto the visible one.
function drawImageInView(img, range, fr, w, h) {
  const iw = img.canvas.width, ih = img.canvas.height, span = img.t1 - img.t0;
  const sx = (range.t0 - img.t0) / span * iw, sw = (range.t1 - range.t0) / span * iw;
  const x0 = Math.max(0, sx), x1 = Math.min(iw, sx + sw);
  if (x1 <= x0) return;
  let sy0 = 0, sy1 = ih, dy0 = 0, dy1 = h;
  if (fr && img.lo !== undefined) {
    const d = freqDomain(fr.scale), a0 = d(img.lo), a1 = d(img.hi), b0 = d(fr.lo), b1 = d(fr.hi);
    const top = Math.min(a1, b1), bottom = Math.max(a0, b0);
    if (top <= bottom) return;
    sy0 = (a1 - top) / (a1 - a0) * ih; sy1 = (a1 - bottom) / (a1 - a0) * ih;
    dy0 = (b1 - top) / (b1 - b0) * h; dy1 = (b1 - bottom) / (b1 - b0) * h;
  }
  ctx.drawImage(img.canvas, x0, sy0, x1 - x0, sy1 - sy0, (x0 - sx) / sw * w, dy0, (x1 - x0) / sw * w, dy1 - dy0);
}

// WAVE or SPEC for the visible range, in the top `h` pixels. Returns the range drawn.
function drawTimeView(buffer, w, h, dpr) {
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  const range = visibleRange(buffer);
  const spec = state.vizMode === 'spec';
  const fr = spec ? freqRange(buffer.rate) : null;
  const base = imageBase(buffer);
  const key = `${base}:${W}x${H}:${range.t0}:${range.t1}${spec ? `:${fr.lo}:${fr.hi}:${state.specRes}` : ''}`;
  if (vizImage && vizImage.key === key && vizImage.grid && vizImage.range !== state.vizRange) paintSpectrogram(vizImage);
  if (!vizImage || vizImage.key !== key) {
    if (spec) requestSpectrogram(buffer, W, H, range, fr, base, key);
    else vizImage = { base, key, ...renderWaveImage(buffer, W, H, range) };
  }
  drawBackdrop(w, h);
  const ready = vizImage && vizImage.key === key;
  if (vizImage && vizImage.base === base) drawImageInView(vizImage, range, fr, w, h);
  if (!ready) drawLabel('Analyzing…', w - 24, h - 14, 'rgba(255, 184, 34, 0.9)', 'right');
  // Read by the browser tests: mode, scale, band (SPEC) and time range of a finished image.
  els.canvas.dataset.view = ready
    ? `${state.vizMode}:${spec ? `${state.vizScale}:f${fr.lo.toFixed(1)}-${fr.hi.toFixed(1)}` : ''}:${range.t0.toFixed(4)}-${range.t1.toFixed(4)}`
    : '';
  return range;
}

/* ---------------- lanes under WAVE and SPEC ---------------- */

// Codec lane: what the voice path did with each 20 ms frame, in playback
// time (frame f plays from (f * frame - lookahead) / rate). Colours by code
// in opus-codec.mjs FRAME. A pixel covering several frames shows the most
// common of them, with a strip along the top whose strength is the share
// of frames lost (red) or late (orange) there.
const FRAME_STYLE = [
  { name: 'not sent', color: '#1c232b', text: 'not sent: the voice gate was closed, the listener hears silence' },
  { name: 'SILK', color: '#3d7fc4', text: 'SILK: speech coding, up to 8 kHz' },
  { name: 'Hybrid', color: '#2fa58a', text: 'Hybrid: SILK below 8 kHz, CELT above' },
  { name: 'CELT', color: '#9a6ad6', text: 'CELT: transform coding, full band' },
  { name: 'DTX', color: '#9a7414', text: 'DTX: no speech detected; the decoder plays comfort noise' },
  { name: 'lost', color: '#ff4040', text: 'lost: the decoder conceals the gap (PLC)' },
  { name: 'late', color: '#ff9d2e', text: 'late: arrived after its playout time, played as silence' }
];
const FRAME_LOST = 5, FRAME_LATE = 6;

function frameAt(info, t) {
  const f = Math.floor((t * info.sampleRate + info.lookahead) / info.frameSamples);
  return f >= 0 && f < info.frames ? f : -1;
}
const frameStart = (info, f) => (f * info.frameSamples - info.lookahead) / info.sampleRate;

function drawCodecLane(L, range) {
  const info = codecFrames();
  if (!info || !L.laneH) return;
  const { w } = L, y = L.laneY + 1, hL = L.laneH - 2, span = range.t1 - range.t0;
  ctx.fillStyle = '#07090c'; ctx.fillRect(0, L.laneY, w, L.laneH);
  const log = info.frameLog, frameSec = info.frameSamples / info.sampleRate;
  const perPixel = span / w / frameSec;
  if (perPixel < 0.5) {
    // Frames several pixels wide: one block each, with a hairline between.
    const f0 = Math.max(0, frameAt(info, Math.max(range.t0, 0))), f1 = frameAt(info, range.t1);
    for (let f = f0; f <= (f1 < 0 ? info.frames - 1 : f1); f++) {
      const x0 = (frameStart(info, f) - range.t0) / span * w, x1 = x0 + frameSec / span * w;
      ctx.fillStyle = FRAME_STYLE[log[f]].color;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0)), hL);
    }
    return;
  }
  const counts = new Uint16Array(FRAME_STYLE.length);
  for (let x = 0; x < w; x++) {
    const a = range.t0 + x / w * span, b = range.t0 + (x + 1) / w * span;
    let f0 = Math.floor((a * info.sampleRate + info.lookahead) / info.frameSamples);
    let f1 = Math.floor((b * info.sampleRate + info.lookahead) / info.frameSamples);
    f0 = Math.max(0, f0); f1 = Math.min(info.frames - 1, Math.max(f0, f1));
    if (f0 >= info.frames) break;
    counts.fill(0);
    for (let f = f0; f <= f1; f++) counts[log[f]]++;
    let code = 0;
    for (let c = 1; c < FRAME_STYLE.length; c++) if (counts[c] > counts[code]) code = c;
    ctx.fillStyle = FRAME_STYLE[code].color;
    ctx.fillRect(x, y, 1, hL);
    const missed = counts[FRAME_LOST] + counts[FRAME_LATE];
    if (missed && code !== FRAME_LOST && code !== FRAME_LATE) {
      const share = missed / (f1 - f0 + 1);
      ctx.fillStyle = counts[FRAME_LOST] >= counts[FRAME_LATE] ? `rgba(255, 64, 64, ${0.35 + 0.65 * Math.min(1, share * 2.5)})`
        : `rgba(255, 157, 46, ${0.35 + 0.65 * Math.min(1, share * 2.5)})`;
      ctx.fillRect(x, y, 1, 3);
    }
  }
}

// Loudness lane: momentary (400 ms, thin) and short-term (3 s, bold) loudness
// of the wet render and the dry source, each value drawn at the centre of its
// window, with dashed lines at their integrated loudness.
const LUFS_STYLE = { WET: '102, 192, 244', DRY: '235, 235, 235', REAL: '164, 208, 7' };
function drawLufsLane(L, range) {
  if (!L.lufsH) return;
  const { w } = L, y0 = L.lufsY, hL = L.lufsH, span = range.t1 - range.t0;
  ctx.fillStyle = '#05080b'; ctx.fillRect(0, y0, w, hL);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(0, y0, w, 1);
  const toY = (lufs) => y0 + 3 + (VIZ.lufsTop - Math.max(VIZ.lufsFloor, Math.min(VIZ.lufsTop, lufs))) / (VIZ.lufsTop - VIZ.lufsFloor) * (hL - 6);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const level of [-12, -24, -36]) { const y = Math.round(toY(level)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  const stats = state.meterStats;
  const series = stats ? [['DRY', stats.dry], ['REAL', stats.real], ['WET', stats.wet]].filter(([, s]) => s && s.history) : [];
  for (const [label, s] of series) {
    const rgb = LUFS_STYLE[label], hop = s.history.hop;
    for (const [values, windowHops, width, alpha] of [[s.history.momentary, 4, 1, 0.45], [s.history.shortTerm, 30, 1.6, 0.95]]) {
      if (!values.length) continue;
      const off = windowHops / 2;
      const k0 = Math.max(0, Math.floor(range.t0 / hop - off) - 1), k1 = Math.min(values.length - 1, Math.ceil(range.t1 / hop - off) + 1);
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`; ctx.lineWidth = width;
      ctx.beginPath();
      for (let k = k0; k <= k1; k++) {
        const x = ((k + off) * hop - range.t0) / span * w, y = toY(values[k]);
        if (k === k0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (Number.isFinite(s.integrated)) {
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = `rgba(${rgb}, 0.6)`; ctx.lineWidth = 1;
      const y = Math.round(toY(s.integrated)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.restore();
    }
  }
  for (const level of [-12, -24, -36]) {
    const y = toY(level);
    if (y - 5 < y0 + 2 || y + 5 > y0 + hL) continue;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(level).replace('-', '−'), 4, y - 5, 'rgba(200, 210, 220, 0.7)');
  }
  drawLabel(series.length ? 'LUFS' : 'LUFS · measuring…', w - 6, y0 + 3, 'rgba(200, 210, 220, 0.6)', 'right');
}

// Loudness values at time t, for the lane's hover readout.
function lufsAt(s, t) {
  const read = (values, windowHops) => {
    const k = Math.round(t / s.history.hop - windowHops / 2);
    return k >= 0 && k < values.length ? values[k] : null;
  };
  return { m: read(s.history.momentary, 4), s: read(s.history.shortTerm, 30) };
}

/* ---------------- selection and loop ---------------- */

function drawSelection(L, range) {
  if (!vizSel) return;
  const span = range.t1 - range.t0;
  const x0 = (vizSel.t0 - range.t0) / span * L.w, x1 = (vizSel.t1 - range.t0) / span * L.w;
  if (x1 < 0 || x0 > L.w) return;
  const a = Math.max(0, x0), b = Math.min(L.w, x1);
  ctx.fillStyle = 'rgba(102, 192, 244, 0.16)'; ctx.fillRect(a, 0, b - a, L.rulerY);
  ctx.fillStyle = state.loop ? 'rgba(164, 208, 7, 0.85)' : 'rgba(102, 192, 244, 0.85)';
  ctx.fillRect(a, L.rulerY, b - a, 3);
  ctx.strokeStyle = state.loop ? 'rgba(164, 208, 7, 0.8)' : 'rgba(102, 192, 244, 0.75)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of [x0, x1]) if (x >= 0 && x <= L.w) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.h); }
  ctx.stroke();
}

// Looping: the whole file loops through the element itself; a selection
// loops by seeking back to its start when playback crosses its end.
let loopLastTime = 0;
function applyLoop() {
  els.audio.loop = state.loop && !vizSel;
  if (els.vizLoop) {
    els.vizLoop.setAttribute('aria-pressed', String(state.loop));
    els.vizLoop.title = vizSel ? 'Loop the selection (L)' : 'Loop the whole file (L); Shift + drag or drag the time ruler to select a range';
  }
}
function checkLoop() {
  const t = els.audio.currentTime;
  if (state.loop && vizSel && !els.audio.paused && loopLastTime < vizSel.t1 && t >= vizSel.t1) {
    els.audio.currentTime = vizSel.t0;
    loopLastTime = vizSel.t0;
    return;
  }
  loopLastTime = t;
}
function toggleLoop() {
  state.loop = !state.loop;
  applyLoop();
  // Starting a selection loop from outside it jumps in.
  if (state.loop && vizSel && els.audio.src && (els.audio.currentTime < vizSel.t0 || els.audio.currentTime >= vizSel.t1)) {
    els.audio.currentTime = vizSel.t0;
  }
  refreshVisualizer();
}

/* ---------------- hover readout ---------------- */

let vizHover = null;   // pointer position over the canvas, CSS pixels
function drawHover(L, buffer, range) {
  if (!vizHover) return;
  const { x, y } = vizHover, { w } = L;
  const region = regionAt(L, y);
  const span = range.t1 - range.t0, t = range.t0 + x / w * span;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.rulerY);
  let text = formatTime(t, 3);
  if (region === 'main' && state.vizMode === 'spec') {
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    const hz = specHz(1 - y / L.mainH, buffer.rate);
    const note = noteName(hz);
    text += ` · ${formatHz(hz)}${note ? ` (${note})` : ''}`;
    const img = vizImage;
    if (img && img.grid && img.base === imageBase(buffer) && t >= img.t0 && t <= img.t1 && hz >= img.lo && hz <= img.hi) {
      const d = freqDomain(img.scale);
      const col = Math.min(img.cols - 1, Math.floor((t - img.t0) / (img.t1 - img.t0) * img.cols));
      const row = Math.min(img.rows - 1, Math.max(0, Math.floor((d(hz) - d(img.lo)) / (d(img.hi) - d(img.lo)) * img.rows)));
      const db = img.grid[col * img.rows + row];
      if (db > -300) text += ` · ${db.toFixed(0)} dB${img.log ? '/Hz' : ''}`;
      const tier = img.tiers[img.rowTier[row]];
      if (tier) text += ` · ${(tier.windowSec * 1000).toFixed(tier.windowSec < 0.1 ? 1 : 0)} ms / ${formatHz(tier.binHz)}`;
    }
  } else if (region === 'main' && state.vizMode === 'wave') {
    const perPixel = Math.max(1, span * buffer.rate / w);
    const from = Math.max(0, Math.floor(t * buffer.rate)), to = Math.min(buffer.samples.length, from + Math.ceil(perPixel));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(buffer.samples[i]));
    text += ` · ${peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '−∞'} dBFS`;
  } else if (region === 'lufs') {
    const stats = state.meterStats || {};
    const fmt = (v) => (v === null ? '—' : Number.isFinite(v) ? v.toFixed(1) : '−∞');
    for (const [label, s] of [['wet', stats.wet], ['dry', stats.dry], ['real', stats.real]]) {
      if (!s || !s.history) continue;
      const v = lufsAt(s, t);
      text += ` · ${label} M ${fmt(v.m)} S ${fmt(v.s)}`;
    }
    text += ' LUFS';
  } else if (region === 'lane') {
    const info = codecFrames(), f = info ? frameAt(info, t) : -1;
    if (f >= 0) {
      const code = info.frameLog[f], bytes = info.frameBytes ? info.frameBytes[f] : 0;
      const perPacket = info.framesPerPacket || 1;
      text = `frame ${f}${perPacket > 1 ? ` (packet ${Math.floor(f / perPacket)})` : ''} · ${formatTime(Math.max(0, frameStart(info, f)), 3)} · ${FRAME_STYLE[code].name}`;
      if (bytes && code !== 0) text += ` · ${bytes} B${code === FRAME_LOST || code === FRAME_LATE ? '' : ` (${(bytes * 8 / (info.frameMs || 20)).toFixed(1)} kbps)`}`;
    }
  }
  ctx.stroke();
  const tagY = region === 'main' ? Math.max(4, Math.min(L.mainH - 18, y - 20)) : Math.max(4, L.lufsY - 18);
  drawTag(text, x + 10, tagY, w);
}

/* ---------------- BARS ---------------- */

// The version to overlay in BARS: the render when hearing the source or the
// real take; the real take (or else the source) when hearing the render.
function otherBuffer() {
  if (!state.processedBuffer || !state.decodedSource) return null;
  if (state.abMode !== 'wet') return { samples: state.processedBuffer, rate: state.processedRate, label: 'WET' };
  if (state.realTake) return { samples: state.realTake.samples, rate: state.realTake.rate, label: 'REAL' };
  return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'DRY' };
}

// Spectrum of `buffer` at the playhead, as band levels, shifted by its A/B
// matching gain so it compares with what is heard.
function bufferBandLevels(buffer, bands, out) {
  const spectrum = state.vizSpectrum2 || (state.vizSpectrum2 = new Float32Array(VIZ.fftSize / 2));
  spectrumAt(buffer.samples, els.audio.currentTime * buffer.rate, VIZ.fftSize, spectrum);
  bandLevels(spectrum, bands, out);
  const offset = abGainDb(buffer.label);
  if (offset) for (let i = 0; i < out.length; i++) out[i] += offset;
  return out;
}


function drawBarsView(buffer, w, h, now) {
  const live = state.isPlaying && state.analyser;
  const rate = live ? state.audioCtx.sampleRate : buffer.rate;
  const top = Math.min(VIZ.maxHz, rate / 2);
  const count = Math.max(16, Math.min(200, Math.floor(w / 5)));
  if (!state.vizBands || state.vizBands.count !== count || state.vizBands.rate !== rate) {
    state.vizBands = { count, rate, bands: logBands(count, rate, VIZ.fftSize), levels: new Float32Array(count),
      overlay: new Float32Array(count), smoothed: null };
  }
  const bands = state.vizBands;
  if (live) {
    const spectrum = state.vizSpectrum || (state.vizSpectrum = new Float32Array(VIZ.fftSize / 2));
    state.analyser.getFloatFrequencyData(spectrum);
    bandLevels(spectrum, bands.bands, bands.levels);
  } else {
    bufferBandLevels(buffer, bands.bands, bands.levels);
  }
  drawBars(bands.levels, w, h, top, now);

  // The other version (dry when hearing wet, and vice versa) as a line,
  // smoothed like the analyser while playing.
  const other = otherBuffer();
  if (other) {
    const fresh = bufferBandLevels(other, logBands(count, other.rate, VIZ.fftSize), bands.overlay);
    if (live && bands.smoothed && bands.smoothed.length === count) {
      const tau = state.analyser.smoothingTimeConstant;
      for (let i = 0; i < count; i++) {
        bands.smoothed[i] = 20 * Math.log10(tau * Math.pow(10, bands.smoothed[i] / 20) + (1 - tau) * Math.pow(10, fresh[i] / 20) + 1e-12);
      }
    } else {
      bands.smoothed = Float32Array.from(fresh);
    }
    const slot = w / count;
    ctx.strokeStyle = 'rgba(235, 235, 235, 0.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = (i + 0.5) * slot, y = h - dbToUnit(bands.smoothed[i]) * h;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(h * (1 - dbToUnit(dbLine)));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(dbLine), 4, y - 5, 'rgba(200, 210, 220, 0.75)');
  }
  if (live) {
    const wave = state.vizWave || (state.vizWave = new Float32Array(state.analyser.fftSize));
    state.analyser.getFloatTimeDomainData(wave);
    let peak = 0, sq = 0;
    for (const v of wave) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
    const toDb = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
    drawLabel(`${buffer.label}  peak ${toDb(peak)}  rms ${toDb(Math.sqrt(sq / wave.length))} dBFS`, 30, 4);
  } else {
    drawLabel(`${buffer.label}  spectrum at ${els.audio.currentTime.toFixed(2)} s`, 30, 4);
  }
  if (other) drawLabel(`— ${other.label}`, 30, 16, 'rgba(235, 235, 235, 0.85)');
  if (state.abMatch && state.abOffsetDb) drawLabel('levels matched', 30, 28, 'rgba(164, 208, 7, 0.9)');

  if (vizHover) {
    const i = Math.min(count - 1, Math.max(0, Math.floor(vizHover.x / (w / count))));
    const [lo, hi] = bands.bands[i], binHz = rate / VIZ.fftSize;
    const hz = Math.sqrt(Math.max(lo, 0.5) * hi) * binHz;
    let text = `${formatHz(hz)} · ${buffer.label} ${bands.levels[i].toFixed(1)} dB`;
    if (other && bands.smoothed) text += ` · ${other.label} ${bands.smoothed[i].toFixed(1)} dB`;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(vizHover.x) + 0.5, 0); ctx.lineTo(Math.round(vizHover.x) + 0.5, h); ctx.stroke();
    drawTag(text, vizHover.x + 10, Math.max(40, Math.min(h - 32, vizHover.y - 20)), w);
  }
}

/* ---------------- BARS: average spectrum ---------------- */

// AVG: the long-term average spectrum of the render and the source over the
// selection (or the whole file), the source shifted to the render's
// loudness, and their difference. Welch's method: power averaged over
// 8192-point Blackman windows (up to 1500, spread evenly), skipping windows
// below -70 dBFS RMS as BS.1770 gates silence; then 1/6-octave smoothing.
const AVG = { fft: 8192, minFft: 1024, maxWindows: 1500, gateDb: -70, octave: 1 / 6, diffRange: 24 };
state.barsAvg = LS.get('tf2ve_bars_avg', false) === true;
const avgResults = new Map();   // "id:t0:t1" -> Promise<{ power, rate, fft, windows }>

function averagePower(samples, rate, t0, t1) {
  const key = `${bufferId(samples)}:${t0.toFixed(4)}:${t1.toFixed(4)}`;
  if (!avgResults.has(key)) {
    if (avgResults.size >= 16) avgResults.delete(avgResults.keys().next().value);
    const job = (async () => {
      const from = Math.max(0, Math.floor(t0 * rate)), to = Math.min(samples.length, Math.ceil(t1 * rate));
      const part = samples.subarray(from, to);
      let n = AVG.fft;
      while (n > AVG.minFft && n > part.length) n /= 2;
      const plan = fftPlan(n), sum = new Float64Array(n / 2 + 1);
      const count = Math.max(1, Math.min(AVG.maxWindows, Math.floor((part.length - n) / (n / 2)) + 1));
      const step = count > 1 ? (part.length - n) / (count - 1) : 0;
      const gate = Math.pow(10, AVG.gateDb / 10) * n;
      let used = 0, yieldAt = performance.now() + 12;
      for (let i = 0; i < count; i++) {
        const start = Math.round(i * step);
        let energy = 0;
        for (let j = start; j < Math.min(part.length, start + n); j++) energy += part[j] * part[j];
        if (energy < gate && count > 1) continue;
        windowedFft(plan, part, part.length < n ? part.length / 2 : start + n / 2);
        for (let k = 0; k <= n / 2; k++) sum[k] += plan.re[k] * plan.re[k] + plan.im[k] * plan.im[k];
        used++;
        if (performance.now() > yieldAt) { await yieldToUi(); yieldAt = performance.now() + 12; }
      }
      // Mean power per bin, scaled like AnalyserNode (a full-scale sine reads about -13.6 dB).
      for (let k = 0; k <= n / 2; k++) sum[k] = used ? sum[k] / used / (n * n) : 0;
      return { power: sum, rate, fft: n, windows: used };
    })();
    job.catch(() => avgResults.delete(key));
    avgResults.set(key, job);
  }
  return avgResults.get(key);
}

// dB per pixel column, smoothed over 1/6 octave around each column's
// frequency (prefix sums of power; narrow low bands interpolate).
function smoothedSpectrum(result, w, top) {
  const { power, rate, fft } = result, binHz = rate / fft, last = power.length - 1;
  const prefix = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k++) prefix[k + 1] = prefix[k] + power[k];
  const at = (bin) => { const k = Math.min(last - 1, Math.floor(bin)), f = bin - k; return power[k] * (1 - f) + power[k + 1] * f; };
  const half = Math.pow(2, AVG.octave / 2), out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const hz = VIZ.minHz * Math.pow(top / VIZ.minHz, (x + 0.5) / w);
    const lo = hz / half / binHz, hi = Math.min(last, hz * half / binHz);
    let p;
    if (hi - lo < 2) p = at(Math.min(last - 1, hz / binHz));
    else { const k0 = Math.ceil(lo), k1 = Math.floor(hi); p = (prefix[k1 + 1] - prefix[k0]) / (k1 - k0 + 1); }
    out[x] = p > 0 ? 10 * Math.log10(p) : -Infinity;
  }
  return out;
}

let avgView = null;   // { key, wet, ref, extra, ... } for the current width and range
// The render against the real take when one is loaded (dry drawn faintly
// behind), else against the dry source. Each is shifted to the render's
// loudness over the analysed range.
function drawAverageView(w, h) {
  drawBackdrop(w, h);
  const versions = {
    WET: state.processedBuffer ? { samples: state.processedBuffer, rate: state.processedRate } : null,
    DRY: state.decodedSource ? { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate } : null,
    REAL: state.realTake ? { samples: state.realTake.samples, rate: state.realTake.rate } : null
  };
  const refLabel = versions.REAL ? 'REAL' : 'DRY';
  const order = ['WET', refLabel, ...(versions.REAL ? ['DRY'] : [])].filter(label => versions[label]);
  const first = versions[order[0]];
  const duration = first.samples.length / first.rate;
  const range = vizSel ? { t0: vizSel.t0, t1: Math.min(vizSel.t1, duration) } : { t0: 0, t1: duration };
  // A take covers only part of the source: analyse where it has audio.
  if (state.realTake) { range.t0 = Math.max(range.t0, state.realTake.overlap.t0); range.t1 = Math.min(range.t1, state.realTake.overlap.t1); }
  if (!(range.t1 - range.t0 > 0.05)) { drawLabel('The selection is outside the real take.', 8, 8); els.canvas.dataset.view = ''; return; }
  const top = Math.min(VIZ.maxHz, ...order.map(label => versions[label].rate / 2));
  const key = `${order.map(label => bufferId(versions[label].samples)).join(':')}:${range.t0.toFixed(4)}:${range.t1.toFixed(4)}:${Math.round(w)}`;
  const whole = !vizSel && !state.realTake;
  if (!avgView || avgView.key !== key) {
    avgView = { key, pending: true };
    const view = avgView;
    Promise.all(order.map(label => averagePower(versions[label].samples, versions[label].rate, range.t0, range.t1)))
      .then(async (powers) => {
        // Match loudness over the same range (RMS when it is under 0.4 s).
        const levels = await Promise.all(order.map(label => (whole ? measure(versions[label].samples, versions[label].rate)
          : measureRange(versions[label].samples, versions[label].rate, range.t0, range.t1)).catch(() => null)));
        if (avgView !== view) return;
        const lufs = (s) => (s && Number.isFinite(s.integrated) ? s.integrated : null);
        const curves = {};
        order.forEach((label, i) => {
          let offset = 0, match = '';
          if (i > 0 && order[0] === 'WET') {
            if (lufs(levels[0]) !== null && lufs(levels[i]) !== null) { offset = lufs(levels[0]) - lufs(levels[i]); match = 'loudness'; }
            else if (levels[0] && levels[i] && Number.isFinite(levels[0].rms) && Number.isFinite(levels[i].rms)) { offset = levels[0].rms - levels[i].rms; match = 'RMS'; }
          }
          curves[label] = { values: smoothedSpectrum(powers[i], Math.round(w), top).map(v => v + offset), offset, match };
        });
        Object.assign(view, { pending: false, top, range, curves, refLabel, windows: powers[0].windows, fft: powers[0].fft });
        refreshVisualizer();
      })
      .catch((error) => { if (avgView === view) { view.pending = false; view.error = error.message; refreshVisualizer(); } });
  }
  const v = avgView;
  const specH = Math.round(h * 0.68), diffY = specH + 4, diffH = h - diffY - 2;
  // Level grid and frequency grid.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; ctx.lineWidth = 1;
  const yDb = (db) => specH * (1 - dbToUnit(db));
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(yDb(dbLine)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  drawFrequencyGrid(w, specH, top, false);
  ctx.fillStyle = '#05080b'; ctx.fillRect(0, specH, w, h - specH);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(0, specH, w, 1);
  const yDiff = (d) => diffY + diffH / 2 - Math.max(-1, Math.min(1, d / AVG.diffRange)) * diffH / 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.beginPath();
  for (const d of [-12, 12]) { const y = Math.round(yDiff(d)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath(); ctx.moveTo(0, Math.round(yDiff(0)) + 0.5); ctx.lineTo(w, Math.round(yDiff(0)) + 0.5); ctx.stroke();
  const STYLE = { WET: ['rgba(102, 192, 244, 0.95)', 2], DRY: ['rgba(235, 235, 235, 0.85)', 1.5], REAL: ['rgba(164, 208, 7, 0.95)', 1.5] };
  if (v.pending || v.error) {
    drawLabel(v.error ? `Average spectrum failed: ${v.error}` : 'Analyzing…', w - 8, 6, 'rgba(255, 184, 34, 0.9)', 'right');
  } else {
    const curve = (values, color, width, y) => {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      let pen = false;
      for (let x = 0; x < values.length; x++) {
        if (!Number.isFinite(values[x])) { pen = false; continue; }
        const yy = y(values[x]);
        if (pen) ctx.lineTo(x + 0.5, yy); else { ctx.moveTo(x + 0.5, yy); pen = true; }
      }
      ctx.stroke();
    };
    // Back to front: the faint source behind a real take, the reference, the render.
    if (v.curves.DRY && v.refLabel === 'REAL') curve(v.curves.DRY.values, 'rgba(235, 235, 235, 0.3)', 1, yDb);
    if (v.curves[v.refLabel]) curve(v.curves[v.refLabel].values, ...STYLE[v.refLabel], yDb);
    if (v.curves.WET) curve(v.curves.WET.values, ...STYLE.WET, yDb);
    v.diff = null;
    if (v.curves.WET && v.curves[v.refLabel]) {
      // Difference, where either version is above the display floor.
      const ref = v.curves[v.refLabel].values;
      const diff = v.curves.WET.values.map((a, x) => (Math.max(a, ref[x]) > VIZ.minDb ? a - ref[x] : NaN));
      ctx.fillStyle = 'rgba(255, 184, 34, 0.18)';
      for (let x = 0; x < diff.length; x++) {
        if (!Number.isFinite(diff[x])) continue;
        const y0 = yDiff(0), y1 = yDiff(diff[x]);
        ctx.fillRect(x, Math.min(y0, y1), 1, Math.abs(y1 - y0));
      }
      curve(diff, 'rgba(255, 184, 34, 0.95)', 1.5, yDiff);
      v.diff = diff;
    }
  }
  drawFrequencyGrid(w, specH, top, true);
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = Math.round(yDb(dbLine));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 22, 10);
    drawLabel(String(dbLine), 4, y - 5, 'rgba(200, 210, 220, 0.75)');
  }
  for (const d of [-12, 12]) {
    const y = yDiff(d);
    if (y - 5 < specH + 2 || y + 5 > h) continue;
    drawLabel(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, 4, y - 5, 'rgba(200, 210, 220, 0.6)');
  }
  drawLabel(`Δ wet − ${refLabel.toLowerCase()}`, w - 6, diffY + 2, 'rgba(255, 184, 34, 0.8)', 'right');
  const where = vizSel || state.realTake ? `${formatTime(range.t0, 2)}–${formatTime(range.t1, 2)}` : 'whole file';
  drawPlate(`AVERAGE SPECTRUM · ${where}${v.fft ? ` · ${v.fft}-pt, ${v.windows} windows, 1/6 oct` : ''}`, 30, 3);
  if (v.curves) {
    let x = 30;
    for (const label of ['WET', refLabel, ...(refLabel === 'REAL' ? ['DRY'] : [])]) {
      const c = v.curves[label];
      if (!c) continue;
      const shift = c.match ? ` (${c.offset >= 0 ? '+' : '−'}${Math.abs(c.offset).toFixed(1)} dB)` : '';
      const text = `— ${label}${shift}`;
      drawLabel(text, x, 17, label === 'DRY' && refLabel === 'REAL' ? 'rgba(235, 235, 235, 0.5)' : STYLE[label][0]);
      ctx.font = '9px Verdana, sans-serif';
      x += ctx.measureText(text).width + 12;
    }
    if (Object.values(v.curves).some(c => c.match)) drawLabel(`${Object.values(v.curves).find(c => c.match).match} matched to wet`, x, 17, 'rgba(200, 210, 220, 0.55)');
  }
  els.canvas.dataset.view = v.pending ? '' : `avg:${refLabel.toLowerCase()}:${range.t0.toFixed(4)}-${range.t1.toFixed(4)}`;

  if (vizHover && !v.pending && v.curves) {
    const x = Math.min(w - 1, Math.max(0, Math.floor(vizHover.x)));
    const hz = VIZ.minHz * Math.pow(v.top / VIZ.minHz, (x + 0.5) / w);
    const fmt = (d) => (Number.isFinite(d) ? d.toFixed(1) : '−∞');
    let text = formatHz(hz);
    for (const label of ['WET', 'REAL', 'DRY']) if (v.curves[label]) text += ` · ${label.toLowerCase()} ${fmt(v.curves[label].values[x])}`;
    if (v.diff && Number.isFinite(v.diff[x])) text += ` · Δ ${v.diff[x] >= 0 ? '+' : '−'}${Math.abs(v.diff[x]).toFixed(1)} dB`;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
    drawTag(text, vizHover.x + 10, Math.max(30, Math.min(specH - 18, vizHover.y - 20)), w);
  }
}

// dBFS labels for the waveform's amplitude grid.
function drawWaveLabels(w, h) {
  const map = waveMapper(), mid = h / 2;
  for (const dbLevel of waveGridDb()) {
    const y = mid - map(Math.pow(10, dbLevel / 20)) * mid;
    if (y < 18) continue;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, y - 5, 24, 10);
    drawLabel(String(dbLevel), 4, y - 5, 'rgba(200, 210, 220, 0.7)');
  }
}


/* ---------------- main draw ---------------- */

function drawVisualizer(now = performance.now()) {
  const { w, h, dpr } = resizeCanvas();
  const buffer = audibleBuffer();
  if (!buffer) { drawBackdrop(w, h); drawLabel('Load audio to visualize', 8, 8); els.canvas.dataset.view = ''; return; }
  if (state.vizMode === 'bars') {
    if (state.barsAvg) drawAverageView(w, h); else drawBarsView(buffer, w, h, now);
    return;
  }
  const L = vizLayout(w, h);
  const range = drawTimeView(buffer, w, L.mainH, dpr);
  const spec = state.vizMode === 'spec';
  if (spec) {
    drawFrequencyAxisLabels(w, L.mainH, buffer.rate);
    drawColorbar(w, L.mainH);
  } else {
    drawWaveLabels(w, L.mainH);
  }
  drawLufsLane(L, range);
  drawCodecLane(L, range);
  drawTimeRuler(w, L.rulerY, L.rulerH, range);
  drawSelection(L, range);
  const zoom = range.zoomed ? `  ${formatTime(range.t0, 2)}–${formatTime(range.t1, 2)}` : '';
  const resolution = spec && vizImage && vizImage.tiers && vizImage.base === imageBase(buffer) ? `  ·  ${describeResolution(vizImage)}` : '';
  drawPlate(`${buffer.label}${zoom}${resolution}`, spec ? VIZ.freqRulerW : 6, 3);
  drawPlayhead(w, L.rulerY, range);
  drawHover(L, buffer, range);
}

function animateVisualizer(now) {
  checkLoop();
  // Zoomed in, the view pages along with the playhead.
  const buffer = state.vizMode !== 'bars' && audibleBuffer();
  if (buffer) {
    const r = visibleRange(buffer), t = els.audio.currentTime;
    if (r.zoomed && (t > r.t1 || t < r.t0)) {
      const span = r.t1 - r.t0;
      vizView.t0 = Math.min(Math.max(0, t - 0.02 * span), r.duration - span);
      vizView.t1 = vizView.t0 + span;
    }
  }
  drawVisualizer(now);
  if (state.isPlaying) state.animationId = requestAnimationFrame(animateVisualizer);
}

function refreshVisualizer() {
  updateVizTools();
  if (!state.isPlaying) drawVisualizer();
}

// The legend under the view: codec lane colours with frame counts, and the
// loudness lane's lines.
const frameCounts = new WeakMap();
let legendKey = '';
function updateLegend() {
  if (!els.vizLegend) return;
  const time = state.vizMode !== 'bars';
  const info = time ? codecFrames() : null;
  const lufs = time && state.showLufs && !!(state.processedBuffer || state.decodedSource);
  const key = `${info ? bufferId(info.frameLog) : 0}:${lufs}:${!!state.realTake}`;
  if (key === legendKey) return;
  legendKey = key;
  const items = [];
  const item = (swatch, text, title) => {
    const span = document.createElement('span');
    span.className = 'lg-item';
    if (title) span.title = title;
    span.append(swatch, text);
    return span;
  };
  const box = (color) => { const i = document.createElement('i'); i.className = 'lg-box'; i.style.background = color; return i; };
  const line = (rgb, width, dashed) => {
    const i = document.createElement('i');
    i.className = 'lg-line';
    i.style.borderTop = `${width}px ${dashed ? 'dashed' : 'solid'} rgb(${rgb})`;
    return i;
  };
  if (info) {
    if (!frameCounts.has(info.frameLog)) {
      const counts = new Array(FRAME_STYLE.length).fill(0);
      for (const code of info.frameLog) counts[code]++;
      frameCounts.set(info.frameLog, counts);
    }
    const counts = frameCounts.get(info.frameLog);
    const head = document.createElement('b');
    head.textContent = 'Codec';
    head.title = 'What the voice path did with each 20 ms frame; hover the lane for packet sizes';
    items.push(head);
    FRAME_STYLE.forEach((style, code) => {
      if (counts[code]) items.push(item(box(style.color), `${style.name} ${counts[code]}`, style.text));
    });
  }
  if (lufs) {
    const head = document.createElement('b');
    head.textContent = 'Loudness';
    head.title = 'BS.1770 loudness over time: momentary (400 ms) and short-term (3 s), each at the centre of its window';
    items.push(head);
    for (const label of ['WET', 'DRY', ...(state.realTake ? ['REAL'] : [])]) {
      items.push(item(line(LUFS_STYLE[label], 2, false), `${label.toLowerCase()} S`, `${label.toLowerCase()} short-term (3 s)`));
      items.push(item(line(LUFS_STYLE[label], 1, false), `${label.toLowerCase()} M`, `${label.toLowerCase()} momentary (400 ms)`));
    }
    items.push(item(line('180, 180, 180', 1, true), 'integrated', 'Integrated loudness of the whole file'));
  }
  els.vizLegend.replaceChildren(...items);
  els.vizLegend.hidden = !items.length;
}

function updateVizTools() {
  const loaded = !!(state.processedBuffer || state.decodedSource);
  const timeView = state.vizMode !== 'bars' && loaded;
  for (const button of [els.vizZoomIn, els.vizZoomOut, els.vizFit]) if (button) button.disabled = !timeView;
  if (els.vizLog) {
    // SPEC: log frequency axis. WAVE: dBFS amplitude.
    const wave = state.vizMode === 'wave', on = wave ? state.waveScale === 'db' : state.vizScale === 'log';
    els.vizLog.textContent = wave ? 'dB' : 'LOG';
    els.vizLog.title = wave ? 'Waveform amplitude in dBFS: shows quiet detail, fades, gates and noise floors'
      : 'Spectrogram frequency axis: log from 20 Hz, analysed with longer windows for the low octaves';
    els.vizLog.disabled = state.vizMode === 'bars';
    els.vizLog.setAttribute('aria-pressed', String(on));
  }
  if (els.vizRange) {
    els.vizRange.hidden = !(state.vizMode === 'spec' || (state.vizMode === 'wave' && state.waveScale === 'db'));
    els.vizRange.textContent = `${state.vizRange} dB`;
  }
  if (els.vizAvg) {
    els.vizAvg.hidden = state.vizMode !== 'bars';
    els.vizAvg.disabled = !loaded;
    els.vizAvg.setAttribute('aria-pressed', String(state.barsAvg));
  }
  if (els.vizRes) {
    els.vizRes.hidden = state.vizMode !== 'spec';
    if (els.vizRes.value !== String(state.specRes)) els.vizRes.value = String(state.specRes);
  }
  if (els.vizLufs) {
    els.vizLufs.disabled = state.vizMode === 'bars';
    els.vizLufs.setAttribute('aria-pressed', String(state.showLufs));
  }
  if (els.vizLoop) els.vizLoop.disabled = !loaded;
  applyLoop();
  updateLegend();
}

// Segmented WAVE | BARS | SPEC control.
function setVizMode(mode) {
  if (state.vizMode === mode) return;
  state.vizMode = mode;
  for (const [button, value] of [[els.vizWave, 'wave'], [els.vizBars, 'bars'], [els.vizSpec, 'spec']]) {
    if (!button) continue;
    button.classList.toggle('active', mode === value);
    button.setAttribute('aria-pressed', String(mode === value));
  }
  vizPeaks = null;
  refreshVisualizer();
}

// FIT: the whole file and the whole band; the selection stays.
function fitView() {
  vizView.t0 = 0;
  vizView.t1 = Infinity;
  resetFreqView();
  refreshVisualizer();
}

if (els.vizWave) els.vizWave.addEventListener('click', () => setVizMode('wave'));
if (els.vizBars) els.vizBars.addEventListener('click', () => setVizMode('bars'));
if (els.vizSpec) els.vizSpec.addEventListener('click', () => setVizMode('spec'));
if (els.vizZoomIn) els.vizZoomIn.addEventListener('click', () => zoomViz(0.5));
if (els.vizZoomOut) els.vizZoomOut.addEventListener('click', () => zoomViz(2));
if (els.vizFit) els.vizFit.addEventListener('click', fitView);
if (els.vizLog) els.vizLog.addEventListener('click', () => {
  if (state.vizMode === 'wave') {
    state.waveScale = state.waveScale === 'db' ? 'lin' : 'db';
    LS.set('tf2ve_wave_scale', state.waveScale);
  } else {
    state.vizScale = state.vizScale === 'log' ? 'lin' : 'log';
    LS.set('tf2ve_viz_scale', state.vizScale);
    // Keep the visible band where the new axis can show it (log starts at 20 Hz).
    if (vizFreq.lo !== null && state.vizScale === 'log') vizFreq.lo = Math.max(VIZ.logMinHz, vizFreq.lo);
  }
  refreshVisualizer();
});
if (els.vizAvg) els.vizAvg.addEventListener('click', () => {
  state.barsAvg = !state.barsAvg;
  LS.set('tf2ve_bars_avg', state.barsAvg);
  refreshVisualizer();
});
if (els.vizRange) els.vizRange.addEventListener('click', () => {
  state.vizRange = VIZ.ranges[(VIZ.ranges.indexOf(state.vizRange) + 1) % VIZ.ranges.length];
  LS.set('tf2ve_viz_range', state.vizRange);
  refreshVisualizer();
});
if (els.vizRes) els.vizRes.addEventListener('change', () => {
  state.specRes = els.vizRes.value === 'auto' ? 'auto' : Number(els.vizRes.value);
  LS.set('tf2ve_spec_res', String(state.specRes));
  refreshVisualizer();
});
if (els.vizLufs) els.vizLufs.addEventListener('click', () => {
  state.showLufs = !state.showLufs;
  LS.set('tf2ve_lufs_lane', state.showLufs);
  refreshVisualizer();
});
if (els.vizLoop) els.vizLoop.addEventListener('click', toggleLoop);

// Taller view: the TALL button, or drag the bottom-right corner (desktop).
// Taller than the stylesheet's height for this screen (TALL, or a drag).
function isTall() {
  const box = els.vizContainer, inline = box.style.height;
  if (!inline) return false;
  box.style.height = '';
  const natural = box.offsetHeight;
  box.style.height = inline;
  return box.offsetHeight > natural + 20;
}
function setVizHeight(px) {
  els.vizContainer.style.height = px ? `${px}px` : '';
  if (els.vizTall) els.vizTall.setAttribute('aria-pressed', String(isTall()));
}
if (els.vizTall) els.vizTall.addEventListener('click', () => {
  const tall = isTall();
  setVizHeight(tall ? 0 : VIZ.tallHeight);
  LS.set('tf2ve_viz_height', tall ? 0 : VIZ.tallHeight);
});
{
  const saved = Number(LS.get('tf2ve_viz_height', 0));
  if (saved >= 160 && saved <= 2000) setVizHeight(saved);
}
if (typeof ResizeObserver !== 'undefined') {
  let lastHeight = els.vizContainer.offsetHeight, timer = 0;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const height = els.vizContainer.offsetHeight;
      if (height !== lastHeight && els.vizContainer.style.height) LS.set('tf2ve_viz_height', height);
      lastHeight = height;
      if (els.vizTall) els.vizTall.setAttribute('aria-pressed', String(isTall()));
      refreshVisualizer();
    }, 100);
  }).observe(els.vizContainer);
}

/* ---------------- pointer, wheel and keys ---------------- */

const vizPointers = new Map();
let vizDrag = null, vizPinch = null;
const canvasPoint = (event) => {
  const rect = els.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
};
// What a point on the canvas is over: 'freq' (the SPEC frequency ruler),
// 'main', 'lufs', 'lane' or 'ruler'.
function pointRegion(p) {
  const L = vizLayout(p.w, p.h), region = regionAt(L, p.y);
  return { L, region: region === 'main' && state.vizMode === 'spec' && p.x < VIZ.freqRulerW ? 'freq' : region };
}
const timeAtPoint = (p, r) => Math.min(r.duration, Math.max(0, r.t0 + p.x / p.w * (r.t1 - r.t0)));

els.canvas.addEventListener('wheel', (event) => {
  const buffer = state.vizMode !== 'bars' && audibleBuffer();
  if (!buffer) return;
  const p = canvasPoint(event), { L, region } = pointRegion(p);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? p.h : 1;
  const delta = Math.max(-100, Math.min(100, (event.deltaY || event.deltaX) * unit));
  // Frequency zoom (SPEC): the wheel over the frequency ruler, or Alt or
  // Ctrl/⌘ + Shift + wheel over the view, around the pointer's frequency.
  if (state.vizMode === 'spec' && (region === 'freq' || event.altKey || ((event.ctrlKey || event.metaKey) && event.shiftKey))) {
    event.preventDefault();
    zoomFreq(Math.exp(delta * 0.005), Math.min(1, Math.max(0, 1 - p.y / L.mainH)));
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/⌘ + wheel, and trackpad pinches (which arrive as ctrl + wheel).
    event.preventDefault();
    zoomViz(Math.exp(Math.max(-100, Math.min(100, event.deltaY * unit)) * 0.005), p.x / p.w);
    return;
  }
  const dx = event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX;
  if (dx && visibleRange(buffer).zoomed) {
    event.preventDefault();
    panViz(dx * unit / p.w);
  }
}, { passive: false });

els.canvas.addEventListener('pointerdown', (event) => {
  if (state.vizMode === 'bars' || !audibleBuffer() || event.button > 0) return;
  const p = canvasPoint(event), { L, region } = pointRegion(p);
  vizPointers.set(event.pointerId, p);
  try { els.canvas.setPointerCapture(event.pointerId); } catch (e) { /* synthetic pointer */ }
  const buffer = audibleBuffer(), r = visibleRange(buffer);
  if (vizPointers.size === 1) {
    const base = { x: p.x, y: p.y, w: p.w, moved: false, t0: r.t0, span: r.t1 - r.t0, duration: r.duration, shift: event.shiftKey };
    if (region === 'freq') {
      // Drag the frequency ruler to move the band; double-click resets it.
      const fr = freqRange(buffer.rate), d = freqDomain(fr.scale);
      vizDrag = { ...base, kind: 'freq', h: L.mainH, d0: d(fr.lo), d1: d(fr.hi), rate: buffer.rate };
    } else if (event.shiftKey || region === 'ruler') {
      // Shift + drag, or a drag along the time ruler, selects a range.
      vizDrag = { ...base, kind: 'select', anchor: timeAtPoint(p, r), region };
    } else {
      vizDrag = { ...base, kind: 'pan' };
    }
  } else if (vizPointers.size === 2) {
    const [a, b] = [...vizPointers.values()];
    vizDrag = null;
    vizPinch = { dist: Math.max(10, Math.abs(a.x - b.x)), mid: (a.x + b.x) / 2, w: p.w, t0: r.t0, span: r.t1 - r.t0,
      duration: r.duration, minSpan: r.minSpan };
  }
});

els.canvas.addEventListener('pointermove', (event) => {
  const p = canvasPoint(event);
  if (vizPointers.has(event.pointerId)) vizPointers.set(event.pointerId, p);
  if (vizPinch && vizPointers.size === 2) {
    const [a, b] = [...vizPointers.values()];
    const dist = Math.max(10, Math.abs(a.x - b.x)), mid = (a.x + b.x) / 2;
    const span = Math.min(vizPinch.duration, Math.max(vizPinch.minSpan, vizPinch.span * vizPinch.dist / dist));
    const at = vizPinch.t0 + vizPinch.mid / vizPinch.w * vizPinch.span;
    setVizView(at - mid / vizPinch.w * span, span, vizPinch.duration);
  } else if (vizDrag && vizPointers.has(event.pointerId)) {
    const dx = p.x - vizDrag.x, dy = p.y - vizDrag.y;
    if (Math.abs(dx) > 4 || (vizDrag.kind === 'freq' && Math.abs(dy) > 3)) vizDrag.moved = true;
    if (vizDrag.moved) {
      if (vizDrag.kind === 'pan') setVizView(vizDrag.t0 - dx / vizDrag.w * vizDrag.span, vizDrag.span, vizDrag.duration);
      else if (vizDrag.kind === 'select') {
        const t = Math.min(vizDrag.duration, Math.max(0, vizDrag.t0 + p.x / vizDrag.w * vizDrag.span));
        setSelection({ t0: Math.min(vizDrag.anchor, t), t1: Math.max(vizDrag.anchor, t) });
        refreshVisualizer();
      } else if (vizDrag.kind === 'freq') {
        // Dragging down shows higher frequencies, like dragging the image.
        const span = vizDrag.d1 - vizDrag.d0, shift = dy / vizDrag.h * span;
        const full = freqRange(vizDrag.rate), d = freqDomain(full.scale), inv = freqUndomain(full.scale);
        const start = Math.min(Math.max(d(full.floor), vizDrag.d0 + shift), d(full.top) - span);
        setFreqView(inv(start), inv(start + span), vizDrag.rate);
      }
    }
  }
  if (event.pointerType === 'mouse') {
    vizHover = { x: p.x, y: p.y };
    const { region } = pointRegion(p);
    els.canvas.style.cursor = vizDrag && vizDrag.moved && vizDrag.kind === 'pan' ? 'grabbing'
      : region === 'freq' ? 'ns-resize' : region === 'ruler' || event.shiftKey ? 'col-resize' : '';
    if (!state.isPlaying) drawVisualizer();
  }
});

function endVizPointer(event) {
  if (!vizPointers.has(event.pointerId)) return;
  vizPointers.delete(event.pointerId);
  const drag = vizDrag;
  if (event.type === 'pointerup' && drag && !drag.moved && drag.kind !== 'freq' && els.audio.src && Number.isFinite(els.audio.duration)) {
    const t = Math.min(Math.max(0, drag.t0 + canvasPoint(event).x / drag.w * drag.span), els.audio.duration);
    if (drag.shift && vizSel) {
      // Shift + click moves the nearer end of the selection there.
      if (Math.abs(t - vizSel.t0) < Math.abs(t - vizSel.t1)) setSelection({ t0: t, t1: vizSel.t1 });
      else setSelection({ t0: vizSel.t0, t1: t });
      refreshVisualizer();
    } else {
      // A click seeks the player there; in the view, a click outside the
      // selection also clears it.
      if (drag.kind === 'pan' && vizSel && (t < vizSel.t0 || t > vizSel.t1)) setSelection(null);
      els.audio.currentTime = t;
      refreshVisualizer();
    }
  }
  if (!vizPointers.size) { vizDrag = null; vizPinch = null; }
  else if (vizPinch) vizPinch = null;
}
els.canvas.addEventListener('pointerup', endVizPointer);
els.canvas.addEventListener('pointercancel', endVizPointer);
els.canvas.addEventListener('pointerleave', () => {
  if (!vizHover) return;
  vizHover = null;
  if (!state.isPlaying) drawVisualizer();
});
els.canvas.addEventListener('dblclick', (event) => {
  if (state.vizMode !== 'spec' || pointRegion(canvasPoint(event)).region !== 'freq') return;
  resetFreqView();
  refreshVisualizer();
});

els.canvas.addEventListener('keydown', (event) => {
  if (state.vizMode === 'bars' || event.ctrlKey || event.metaKey || event.altKey) return;
  const spec = state.vizMode === 'spec';
  const actions = {
    '+': () => zoomViz(0.5), '=': () => zoomViz(0.5), '-': () => zoomViz(2), '_': () => zoomViz(2),
    '0': fitView,
    ArrowLeft: () => panViz(-0.25), ArrowRight: () => panViz(0.25),
    ArrowUp: spec ? () => (event.shiftKey ? panFreq(0.25) : zoomFreq(0.5)) : null,
    ArrowDown: spec ? () => (event.shiftKey ? panFreq(-0.25) : zoomFreq(2)) : null,
    z: vizSel ? zoomToSelection : null, Z: vizSel ? zoomToSelection : null,
    Escape: vizSel ? () => { setSelection(null); refreshVisualizer(); } : null
  };
  if (!actions[event.key]) return;
  event.preventDefault();
  actions[event.key]();
});

els.audio.addEventListener('play', () => {
  if (!state.audioCtx) {
    try {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = VIZ.fftSize;
      state.analyser.smoothingTimeConstant = 0.6;
      state.analyser.minDecibels = VIZ.minDb;
      state.analyser.maxDecibels = VIZ.maxDb;
      // Each element has its own gain for the loudness-matched A/B.
      state.wetGain = state.audioCtx.createGain();
      state.sourceNode = state.audioCtx.createMediaElementSource(els.audio);
      state.sourceNode.connect(state.wetGain).connect(state.analyser);
      state.analyser.connect(state.audioCtx.destination);
      if (els.audioDry) {
        // Route the dry twin through the same analyser: a muted element is
        // silent in the graph, so the visualizer always shows the audible one.
        state.dryGain = state.audioCtx.createGain();
        state.sourceNodeDry = state.audioCtx.createMediaElementSource(els.audioDry);
        state.sourceNodeDry.connect(state.dryGain).connect(state.analyser);
      }
      if (els.audioReal) {
        state.realGain = state.audioCtx.createGain();
        state.sourceNodeReal = state.audioCtx.createMediaElementSource(els.audioReal);
        state.sourceNodeReal.connect(state.realGain).connect(state.analyser);
      }
      applyAbMatch();
    } catch (e) {
      state.analyser = null;   // visualizer falls back to buffer analysis
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  // A selection loop starts at the selection when played from outside it.
  if (state.loop && vizSel && (els.audio.currentTime < vizSel.t0 || els.audio.currentTime >= vizSel.t1)) els.audio.currentTime = vizSel.t0;
  loopLastTime = els.audio.currentTime;
  syncTwins();
  for (const el of twins()) el.play().catch(() => {});
  state.isPlaying = true;
  cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(animateVisualizer);
});
function stopVisualizer() {
  for (const el of [els.audioDry, els.audioReal]) if (el) el.pause();
  state.isPlaying = false;
  cancelAnimationFrame(state.animationId);
  refreshVisualizer();
}
els.audio.addEventListener('pause', stopVisualizer);
els.audio.addEventListener('ended', () => {
  // A selection that runs to the end of the file loops from here.
  if (state.loop && vizSel) { els.audio.currentTime = vizSel.t0; els.audio.play().catch(() => {}); return; }
  stopVisualizer();
});
els.audio.addEventListener('seeked', () => { syncTwins(); loopLastTime = els.audio.currentTime; refreshVisualizer(); });
els.audio.addEventListener('timeupdate', () => { checkLoop(); refreshVisualizer(); });
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refreshVisualizer, 150); });

/* ------------------------------------------------------------------ */
/* Net graph (only spins when visible)                                */
/*                                                                    */
/* Voice-channel numbers come from the last render: packets per       */
/* second from net_split, payload rate from the real encoded bytes,   */
/* and the loss the burst model actually produced.                    */
/* ------------------------------------------------------------------ */

let lastTime = performance.now(), frameCount = 0;
function updateNetGraph() {
  requestAnimationFrame(updateNetGraph);
  const now = performance.now();
  frameCount++;
  if (now - lastTime < 500) return;
  if (els.ng.style.display === 'block') {
    const fps = Math.round(frameCount * 1000 / (now - lastTime));
    els.ngFps.textContent = fps;
    els.ngPing.textContent = 5 + Math.floor(Math.random() * 4 + Number(els.jitter.value) / 5 * Math.random());
    els.ngLerp.textContent = '100.0';
    const info = state.lastCodecInfo;
    if (info && info.frames) {
      // Averages over the render; frames held back by the voice gate send nothing.
      const seconds = info.frames * info.frameMs / 1000;
      const sent = info.frames - (info.gatedFrames || 0);
      const pps = (sent / seconds / (info.framesPerPacket || 1)).toFixed(0);
      const kps = (info.encodedBytes / seconds / 1024).toFixed(2);
      els.ngIn.textContent = `${pps} ${kps}`;
      els.ngOut.textContent = `${pps} ${kps}`;
      els.ngLoss.textContent = sent ? Math.round(100 * (info.lostFrames + (info.underrunFrames || 0)) / sent) : 0;
    } else {
      els.ngIn.textContent = '0 0.00';
      els.ngOut.textContent = '0 0.00';
      els.ngLoss.textContent = els.loss.value;
    }
    els.ngFill.style.width = Math.min(100, (fps / 60) * 100) + '%';
    els.ngFill.style.background = (fps < 30) ? '#ff4040' : '#a4d007';
  }
  frameCount = 0;
  lastTime = now;
}
requestAnimationFrame(updateNetGraph);

// Pause the background event simulator while the tab is hidden (saves
// battery on mobile; resumes where it left off).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) simulator.stop();
  else if (state.simEnabled) simulator.start();
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

(function bootConsole() {
  // Restore persisted command history and any settings shared via URL hash.
  const savedHistory = LS.get('tf2ve_history', []);
  state.cmdHistory = Array.isArray(savedHistory)
    ? savedHistory.filter((entry) => typeof entry === 'string').slice(-50)
    : [];
  state.cmdIndex = state.cmdHistory.length;
  applyHashConfig();
  updateSignalChain();
  refreshVisualizer();
  if (!location.hash || location.hash.length < 2) setActivePreset('modern');

  const bootLogs = [
    { t: "Valve Software - Source Engine [ Build 22050 ]", c: 'text' },
    { t: "Heap: 256.00 Mb", c: 'text' },
    { t: "Parsed 358 text messages", c: 'text' },
    { t: "execing autoexec.cfg", c: 'text' },
    { t: "cc_lang_listener: loading linguistics_en.txt", c: 'text' },
    { t: "Sound System: Init (2 channels, 16bit)", c: 'sys' },
    { t: `sv_voicecodec: ${(CODEC_PROFILES[els.codec.value] || CODEC_PROFILES.steam).displayName}`, c: 'cmd' },
    { t: "Parallel processing initialized", c: 'text' },
    { t: "Type 'help' for commands. Try 'exec preset_spam' for overdriven mic spam.", c: 'sys' },
    { t: "System Ready.", c: 'sys' }
  ];
  let delay = 0;
  bootLogs.forEach(line => { setTimeout(() => logLine(line.t, line.c), delay); delay += Math.random() * 150 + 50; });
  setTimeout(() => { if (state.simEnabled) simulator.start(); }, delay + 500);
})();
