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
  worker: null,
  processId: 0,
  cancelProcessing: null,
  downloadName: 'tf2_voice.wav'
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
  'voice_vad_threshold': { help: 'Gate opening level: 20 ms frame RMS in dBFS (measured -39.5), 300 ms hold', link: 'vad_threshold' },
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
    ['Codec', codecOn ? `Opus ${codec.codecRate / 1000} kHz · ${kbps} kbps · ${mode}` : 'bypassed', codecOn ? '' : 'off'],
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
  els.abToggle.disabled = true;
  els.abToggle.textContent = 'A/B: Wet';
  state.abMode = 'wet';
  state.lastCodecInfo = null;
  refreshVisualizer();
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

els.file.addEventListener('change', async () => {
  if (!els.file.files.length) return;
  const f = els.file.files[0];
  if (f.size > MAX_FILE_BYTES) {
    setStatus(`File is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 'error');
    logLine('FS_MountFile: file exceeds the 100 MB safety limit.', 'err');
    els.file.value = '';
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

function processInWorker(source, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('audio-worker.js');
    const id = ++state.processId;
    const mono = source.getChannelData(0).slice();
    const workerOpts = { ...opts };
    delete workerOpts.onProgress;
    state.worker = worker;

    const cleanup = () => {
      worker.terminate();
      if (state.worker === worker) state.worker = null;
      state.cancelProcessing = null;
    };
    state.cancelProcessing = () => {
      cleanup();
      const error = new Error('Audio processing cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.type === 'progress') {
        if (opts.onProgress) opts.onProgress(message.value);
      } else if (message.type === 'result') {
        cleanup();
        resolve({
          samples: new Float32Array(message.samples),
          sampleRate: message.sampleRate,
          blob: message.blob,
          realOpus: message.realOpus,
          codecInfo: message.codecInfo
        });
      } else if (message.type === 'error') {
        cleanup();
        reject(new Error(message.message || 'Audio worker failed.'));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'Audio worker could not start.'));
    };
    worker.postMessage({
      type: 'process', id, sampleRate: source.sampleRate,
      samples: mono.buffer, opts: workerOpts
    }, [mono.buffer]);
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

async function runAudioProcess(source, opts) {
  source = captureSource(source, opts.captureChannel);
  if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
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

if (els.cancel) els.cancel.addEventListener('click', () => {
  if (state.cancelProcessing) state.cancelProcessing();
});

if (els.dl) els.dl.addEventListener('click', () => {
  if (!state.lastBlob || els.dl.disabled) return;
  const link = document.createElement('a');
  link.href = state.lastBlob;
  link.download = state.downloadName;
  link.click();
});

els.process.addEventListener('click', async () => {
  if (!state.decodedSource) { logLine('No decoded audio — select a file first.', 'err'); return; }
  if (state.processing) return;
  state.processing = true;
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
    const posKey   = els.position.value;
    const dspRoomId = parseInt(els.env.value);

    const opts = {
      codec: codecKey,
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
      frameMs:     Number(els.frameMs.value),  // net_split — previously never passed
      enableWarble: els.warble.value === '1',
      jitterMs:    Number(els.jitter.value),
      onProgress:  (p) => {
        const percent = Math.min(100, Math.max(0, Math.round(p * 100)));
        els.process.textContent = `Processing… ${percent}%`;
        if (els.progress) els.progress.value = percent;
      }
    };

    logLine(`MIX: codec=${opts.codec} pos=${opts.listenerPos || 'manual:'+opts.dspRoom} gain=${opts.micGain} vs=${opts.voiceScale}`);

    const t0 = performance.now();
    const { samples, sampleRate, blob, realOpus, codecInfo } = await runAudioProcess(state.decodedSource, opts);
    const took = Math.round(performance.now() - t0);

    // Report the actual processing path: codec version, bitrate and the
    // Opus modes the encoder really chose.
    logLine(realOpus
      ? `S_Voice: ${codecInfo.version}, ${codecInfo.bitrate / 1000} kbps, 20 ms frames, native PLC (${describeModes(codecInfo.modes)})`
      : 'S_Voice: codec bypassed', 'sys');
    if (realOpus && codecInfo.gate != null) {
      const held = codecInfo.frames ? Math.round(100 * codecInfo.gatedFrames / codecInfo.frames) : 0;
      logLine(`S_Voice: voice gate at ${codecInfo.gate} dBFS held back ${codecInfo.gatedFrames} of ${codecInfo.frames} frames (${held}%)`, 'sys');
    }
    if (realOpus && (codecInfo.lostFrames || codecInfo.underrunFrames)) {
      logLine(`S_Voice: ${codecInfo.lostFrames} frames lost and concealed, ${codecInfo.underrunFrames || 0} late frames played as silence`, 'sys');
    }
    logLine(`S_Voice: receiver auto-gain ${codecInfo.autoGain ? 'on' : 'off'} at ${codecInfo.voiceRate} Hz`, 'sys');

    state.processedBuffer = samples;
    state.processedRate   = sampleRate;
    if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
    state.lastBlob = URL.createObjectURL(blob);

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
    const base = (state.sourceName || 'clip').replace(/\.[^/.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    state.downloadName = `${base}_tf2_${codecKey}.wav`;
    els.dl.disabled = false;

    state.renderId++;
    state.lastCodecInfo = codecInfo;
    refreshVisualizer();
    const method = realOpus ? `Real Opus · ${codecInfo.bitrate / 1000} kbps` : 'Codec bypassed';
    setStatus(`Ready · ${method} · ${(took / 1000).toFixed(1)}s render · ${sampleRate.toLocaleString()} Hz`, 'success');
    logLine(`ChangeLevel: rendered ${samples.length} samples @ ${sampleRate}Hz in ${took}ms`, 'sys');
    logLine(`Net_SendPacket: reliable stream ready.`);
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
    els.file.disabled = false;
    if (els.mic) els.mic.disabled = false;
    if (els.controls) els.controls.inert = false;
    els.process.textContent = 'Process Audio';
    if (els.cancel) els.cancel.hidden = true;
    if (els.progress) els.progress.hidden = true;
  }
});

/* ------------------------------------------------------------------ */
/* A/B toggle                                                         */
/* ------------------------------------------------------------------ */

els.abToggle.addEventListener('click', () => {
  if (!state.lastBlob || !state.dryBlob || !els.audioDry) return;
  state.abMode = (state.abMode === 'wet') ? 'dry' : 'wet';
  const wetAudible = state.abMode === 'wet';
  // Both elements play in sync; A/B is an instant mute swap — no re-buffering.
  els.audio.muted = !wetAudible;
  els.audioDry.muted = wetAudible;
  syncDry(true);
  els.abToggle.textContent = wetAudible ? 'A/B: Wet' : 'A/B: Dry';
  refreshVisualizer();
});

// Keep the hidden dry twin locked to the main (wet) transport.
function syncDry(force = false) {
  if (!els.audioDry || !els.audioDry.src) return;
  const d = els.audioDry.duration;
  const t = Math.min(els.audio.currentTime,
    isFinite(d) && d > 0 ? Math.max(0, d - 0.01) : els.audio.currentTime);
  try {
    if (force || Math.abs(els.audioDry.currentTime - t) > 0.02) els.audioDry.currentTime = t;
  } catch (e) { /* metadata not ready yet */ }
}

els.audio.addEventListener('volumechange', () => { if (els.audioDry) els.audioDry.volume = els.audio.volume; });
els.audio.addEventListener('ratechange', () => { if (els.audioDry) els.audioDry.playbackRate = els.audio.playbackRate; });

/* ------------------------------------------------------------------ */
/* Visualizer                                                         */
/*                                                                    */
/* WAVE: peak + RMS envelope of the audible version with a playhead.  */
/* BARS: log-frequency spectrum in dBFS. Live from the AnalyserNode   */
/*       while playing; computed from the rendered buffer at the      */
/*       playhead when paused, with the analyser's own window/scale.  */
/* SPEC: whole-file log-frequency spectrogram with a playhead.        */
/* ------------------------------------------------------------------ */

const ctx = els.canvas.getContext('2d', { alpha: false });
const VIZ = {
  minHz: 40, maxHz: 20000,   // log-frequency axis
  minDb: -100, maxDb: -10,   // AnalyserNode dB scale (full-scale sine ~ -13.6)
  fftSize: 4096,
  bandEdgeHz: 12000          // Opus super-wideband edge used by the Steam profile
};
const vizCache = { key: null, image: null };
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

// Linear-frequency rows for the spectrogram: codec band edges read as
// horizontal lines instead of being squeezed into the top of a log axis.
function linearBands(count, sampleRate, fftSize) {
  const top = Math.min(VIZ.maxHz, sampleRate / 2), binHz = sampleRate / fftSize, bands = [];
  for (let i = 0; i < count; i++) bands.push([top * i / count / binHz, top * (i + 1) / count / binHz]);
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

// In-place radix-2 FFT for the paused/static views.
function fftReal(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const blackman = (() => {
  const cache = new Map();
  return (n) => {
    if (!cache.has(n)) cache.set(n, Float32Array.from({ length: n },
      (_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n)));
    return cache.get(n);
  };
})();

// Same windowing and scaling as AnalyserNode.getFloatFrequencyData.
function spectrumAt(samples, center, fftSize, out) {
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize), win = blackman(fftSize);
  const start = Math.round(center - fftSize / 2);
  for (let i = 0; i < fftSize; i++) {
    const j = start + i;
    re[i] = (j >= 0 && j < samples.length ? samples[j] : 0) * win[i];
  }
  fftReal(re, im);
  for (let k = 0; k < fftSize / 2; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / fftSize + 1e-12);
  return out;
}

// The version the listener hears: processed (wet) or original (dry).
function audibleBuffer() {
  if (state.abMode === 'dry' && state.decodedSource) {
    return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'DRY' };
  }
  if (state.processedBuffer) return { samples: state.processedBuffer, rate: state.processedRate, label: 'WET' };
  if (state.decodedSource) return { samples: state.decodedSource.getChannelData(0), rate: state.decodedSource.sampleRate, label: 'SOURCE' };
  return null;
}

function playheadFraction() {
  const d = els.audio.duration;
  return Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, els.audio.currentTime / d)) : 0;
}

function drawBackdrop(w, h) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
}

function drawLabel(text, x, y, color = 'rgba(200, 210, 220, 0.75)', align = 'left') {
  ctx.font = '9px Verdana, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillStyle = color; ctx.fillText(text, x, y);
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

function drawPlayhead(w, h) {
  if (!state.processedBuffer && !state.decodedSource) return;
  const x = Math.round(playheadFraction() * w) + 0.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

function renderWaveImage(buffer, W, H) {
  const image = document.createElement('canvas');
  image.width = W; image.height = H;
  const g = image.getContext('2d', { alpha: false });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  const data = buffer.samples, step = data.length / W, mid = H / 2;
  for (let x = 0; x < W; x++) {
    const from = Math.floor(x * step), to = Math.max(from + 1, Math.floor((x + 1) * step));
    let min = 0, max = 0, sq = 0;
    for (let i = from; i < to && i < data.length; i++) {
      const v = data[i];
      if (v < min) min = v; if (v > max) max = v;
      sq += v * v;
    }
    const rmsValue = Math.sqrt(sq / Math.max(1, to - from));
    g.fillStyle = '#2a5f86';
    g.fillRect(x, mid - max * mid, 1, Math.max(1, (max - min) * mid));
    g.fillStyle = '#66c0f4';
    g.fillRect(x, mid - rmsValue * mid, 1, Math.max(1, 2 * rmsValue * mid));
  }
  return image;
}

function renderSpectrogramImage(buffer, W, H) {
  const image = document.createElement('canvas');
  image.width = W; image.height = H;
  const g = image.getContext('2d');
  const pixels = g.createImageData(W, H);
  const fftSize = 2048, spectrum = new Float32Array(fftSize / 2), level = new Float32Array(H);
  const rows = linearBands(H, buffer.rate, fftSize), grid = new Float32Array(W * H);
  const data = buffer.samples, step = data.length / W;
  for (let x = 0; x < W; x++) {
    const column = grid.subarray(x * H, (x + 1) * H);
    column.fill(-200);
    // Up to three FFTs per column: max-hold keeps short events visible.
    const hops = Math.max(1, Math.min(3, Math.floor(step / fftSize)));
    for (let hop = 0; hop < hops; hop++) {
      spectrumAt(data, x * step + (hop + 0.5) * step / hops, fftSize, spectrum);
      bandLevels(spectrum, rows, level);
      for (let r = 0; r < H; r++) if (level[r] > column[r]) column[r] = level[r];
    }
  }
  // Scale each image to its own loud end so band edges stay visible on
  // loud, clipped renders: 72 dB below the 99th-percentile level.
  const sorted = grid.filter((_, i) => i % 7 === 0).sort();
  const topDb = sorted[Math.floor(sorted.length * 0.99)] || VIZ.maxDb, range = 72;
  for (let x = 0; x < W; x++) {
    for (let r = 0; r < H; r++) {
      const u = Math.min(1, Math.max(0, (grid[x * H + r] - topDb + range) / range));
      const c = Math.round(u * 255) * 3, p = ((H - 1 - r) * W + x) * 4;
      pixels.data[p] = PALETTE[c]; pixels.data[p + 1] = PALETTE[c + 1]; pixels.data[p + 2] = PALETTE[c + 2]; pixels.data[p + 3] = 255;
    }
  }
  g.putImageData(pixels, 0, 0);
  return image;
}

// Whole-file images are cached per buffer, mode and canvas size.
function staticImage(mode, buffer, W, H) {
  const key = `${mode}:${buffer.label}:${buffer.samples.length}:${buffer.rate}:${W}x${H}:${state.renderId}`;
  if (vizCache.key !== key) {
    vizCache.image = mode === 'spec' ? renderSpectrogramImage(buffer, W, H) : renderWaveImage(buffer, W, H);
    vizCache.key = key;
  }
  return vizCache.image;
}

function drawVisualizer(now = performance.now()) {
  const { w, h, dpr } = resizeCanvas();
  const buffer = audibleBuffer();
  if (!buffer) { drawBackdrop(w, h); drawLabel('Load audio to visualize', 8, 8); return; }
  if (state.vizMode === 'bars') {
    const live = state.isPlaying && state.analyser;
    const rate = live ? state.audioCtx.sampleRate : buffer.rate;
    const top = Math.min(VIZ.maxHz, rate / 2);
    const count = Math.max(16, Math.min(160, Math.floor(w / 5)));
    if (!state.vizBands || state.vizBands.count !== count || state.vizBands.rate !== rate) {
      state.vizBands = { count, rate, bands: logBands(count, rate, VIZ.fftSize), levels: new Float32Array(count) };
    }
    const spectrum = state.vizSpectrum || (state.vizSpectrum = new Float32Array(VIZ.fftSize / 2));
    if (live) state.analyser.getFloatFrequencyData(spectrum);
    else spectrumAt(buffer.samples, playheadFraction() * buffer.samples.length, VIZ.fftSize, spectrum);
    drawBars(bandLevels(spectrum, state.vizBands.bands, state.vizBands.levels), w, h, top, now);
    if (live) {
      const wave = state.vizWave || (state.vizWave = new Float32Array(state.analyser.fftSize));
      state.analyser.getFloatTimeDomainData(wave);
      let peak = 0, sq = 0;
      for (const v of wave) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
      const toDb = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
      drawLabel(`${buffer.label}  peak ${toDb(peak)}  rms ${toDb(Math.sqrt(sq / wave.length))} dBFS`, 8, 4);
    } else {
      drawLabel(`${buffer.label}  spectrum at ${els.audio.currentTime.toFixed(2)} s`, 8, 4);
    }
    return;
  }
  const image = staticImage(state.vizMode, buffer, Math.round(w * dpr), Math.round(h * dpr));
  ctx.drawImage(image, 0, 0, w, h);
  if (state.vizMode === 'spec') drawFrequencyAxisLabels(w, h, buffer.rate);
  drawLabel(buffer.label, state.vizMode === 'spec' ? 30 : 8, 4);
  drawPlayhead(w, h);
}

function drawFrequencyAxisLabels(w, h, rate) {
  const top = Math.min(VIZ.maxHz, rate / 2);
  for (const hz of [4000, 8000, VIZ.bandEdgeHz, 16000]) {
    if (hz >= top) continue;
    const y = h - h * hz / top;
    const edge = hz === VIZ.bandEdgeHz;
    const text = `${hz / 1000}k`;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(2, Math.max(0, y - 10), 22, 10);
    drawLabel(text, 4, Math.max(0, y - 10), edge ? 'rgba(255, 184, 34, 0.9)' : 'rgba(220, 230, 240, 0.85)');
  }
}

function animateVisualizer(now) {
  drawVisualizer(now);
  if (state.isPlaying) state.animationId = requestAnimationFrame(animateVisualizer);
}

function refreshVisualizer() {
  if (!state.isPlaying) drawVisualizer();
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

if (els.vizWave) els.vizWave.addEventListener('click', () => setVizMode('wave'));
if (els.vizBars) els.vizBars.addEventListener('click', () => setVizMode('bars'));
if (els.vizSpec) els.vizSpec.addEventListener('click', () => setVizMode('spec'));

els.audio.addEventListener('play', () => {
  if (!state.audioCtx) {
    try {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = VIZ.fftSize;
      state.analyser.smoothingTimeConstant = 0.6;
      state.analyser.minDecibels = VIZ.minDb;
      state.analyser.maxDecibels = VIZ.maxDb;
      state.sourceNode = state.audioCtx.createMediaElementSource(els.audio);
      state.sourceNode.connect(state.analyser);
      state.analyser.connect(state.audioCtx.destination);
      if (els.audioDry) {
        // Route the dry twin through the same analyser: a muted element is
        // silent in the graph, so the visualizer always shows the audible one.
        state.sourceNodeDry = state.audioCtx.createMediaElementSource(els.audioDry);
        state.sourceNodeDry.connect(state.analyser);
      }
    } catch (e) {
      state.analyser = null;   // visualizer falls back to buffer analysis
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  if (els.audioDry && els.audioDry.src) { syncDry(); els.audioDry.play().catch(() => {}); }
  state.isPlaying = true;
  cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(animateVisualizer);
});
function stopVisualizer() {
  if (els.audioDry) els.audioDry.pause();
  state.isPlaying = false;
  cancelAnimationFrame(state.animationId);
  refreshVisualizer();
}
els.audio.addEventListener('pause', stopVisualizer);
els.audio.addEventListener('ended', stopVisualizer);
els.audio.addEventListener('seeked', () => { syncDry(); refreshVisualizer(); });
els.audio.addEventListener('timeupdate', refreshVisualizer);
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
