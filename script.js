/* =========================================================================
 * TF2 Voice Emulator — script.js
 *
 * UI glue: console, cvars, game-event simulator, visualizer, netgraph, boot.
 * All heavy audio lives in audio.js; this file is "the chrome around it".
 *
 * Depends on globals defined by constants.js + audio.js:
 *   TF2_DATA, PRESETS, CODEC_PROFILES, DSP_PRESETS, LISTENER_POSITIONS,
 *   ENV_ALIAS, FCVAR, TF2Audio
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
  ng:        document.getElementById('net-graph'),
  ngFps:     document.getElementById('ng-fps'),
  ngPing:    document.getElementById('ng-ping'),
  ngLerp:    document.getElementById('ng-lerp'),
  ngFill:    document.getElementById('ng-fill'),
  ngLoss:    document.getElementById('ng-loss-val'),
  abToggle:  document.getElementById('ab-toggle'),
  hp:        document.getElementById('hp'),
  lp:        document.getElementById('lp'),
  bits:      document.getElementById('bits'),
  agc:       document.getElementById('agc'),
  loss:      document.getElementById('loss'),
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
  vizMode: 'bars',       // 'bars' or 'spec' (spectrogram)
  sourceName: null,      // name of the loaded clip (file or mic)
  netJitter: 0,          // net_jitter cvar (console-only)
  realOpus: 1,           // snd_real_opus: bundled libopus; 0 explicitly selects approximation
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
    this.activePlayers = [];
    this.maxPlayers = 24;
    this.initialPopulation();
  }
  initialPopulation() { for (let i = 0; i < 12; i++) this.addPlayer(true); }
  start() { if (this.isActive) return; this.isActive = true; this.loop(); }
  stop()  { this.isActive = false; }
  addPlayer(silent = false) {
    if (this.activePlayers.length >= this.maxPlayers) return;
    const pool = TF2_DATA.playerNames.filter(n => !this.activePlayers.includes(n));
    if (!pool.length) return;
    const name = pool[Math.floor(Math.random() * pool.length)];
    this.activePlayers.push(name);
    if (!silent) this.log(`Player ${name} connected`, 'text');
  }
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  getRandomPlayer() { return this.pick(this.activePlayers); }
  triggerKill() {
    if (this.activePlayers.length < 2) return;
    const killer = this.getRandomPlayer();
    let victim = this.getRandomPlayer();
    while (victim === killer) victim = this.getRandomPlayer();
    const weapon = this.pick(TF2_DATA.weapons);
    const isCrit = Math.random() > 0.85;
    this.log(`${killer} killed ${victim} with ${weapon}.${isCrit ? ' (crit)' : ''}`, 'text');
  }
  triggerChat() {
    if (!this.activePlayers.length) return;
    const player = this.getRandomPlayer();
    const msg = this.pick(TF2_DATA.chat);
    const isDead = Math.random() > 0.7;
    const team = Math.random() > 0.8 ? "(TEAM) " : "";
    const prefix = isDead ? "*DEAD* " : "";
    this.log(`${prefix}${team}${player} :  ${msg}`, 'text');
  }
  triggerError()     { this.log(this.pick(TF2_DATA.errors), 'err'); }
  triggerSystem()    { this.log(this.pick(TF2_DATA.system), 'text'); }
  triggerAchievement() {
    if (!this.activePlayers.length) return;
    this.log(`${this.getRandomPlayer()} has earned the achievement ${this.pick(TF2_DATA.achievements)}`, 'ach');
  }
  triggerItem() {
    if (!this.activePlayers.length) return;
    this.log(`${this.getRandomPlayer()} has found: ${this.pick(TF2_DATA.items)}`, 'item');
  }
  loop() {
    if (!this.isActive) return;
    const nextTick = Math.random() * 3500 + 500;
    setTimeout(() => { this.processTick(); this.loop(); }, nextTick);
  }
  processTick() {
    const r = Math.random();
    if      (r < 0.02) this.addPlayer();
    else if (r < 0.30) this.triggerKill();
    else if (r < 0.55) this.triggerChat();
    else if (r < 0.60) this.triggerError();
    else if (r < 0.65) this.triggerAchievement();
    else if (r < 0.70) this.triggerItem();
    else if (r < 0.75) this.triggerSystem();
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
    val: 0, help: 'Late-packet crackle % (buffer-starvation pops, 0-50)',
    action: (v) => {
      const n = parseFloat(v);
      if (!isNaN(n)) state.netJitter = Math.min(50, Math.max(0, n));
    }
  },
  'snd_real_opus': {
    val: 1, help: 'Use bundled real Opus; 0 explicitly selects an approximate effect',
    action: (v) => {
      const n = parseInt(v);
      if (!isNaN(n)) state.realOpus = n ? 1 : 0;
    }
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
        logLine('Dev limits removed. God speed.');
      } else {
        els.gain.setAttribute('max', '5.0');
        els.loss.setAttribute('max', '40');
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
  'volume': {
    val: 1.0, help: 'Audio playback volume (0.0 - 1.0)',
    action: (v) => {
      const val = parseFloat(v);
      if (!isNaN(val)) {
        els.audio.volume = Math.min(1, Math.max(0, val));
        if (els.audioDry) els.audioDry.volume = els.audio.volume;
      }
      else logLine(`Current volume: ${els.audio.volume.toFixed(2)}`, 'text');
    }
  },
  'play':    { help: 'Start playback',   action: () => { if (els.audio.src) els.audio.play().catch(e => logLine(e.message, 'err')); else logLine('No audio loaded.', 'err'); } },
  'stop':    { help: 'Stop playback',    action: () => { els.audio.pause(); els.audio.currentTime = 0; } },
  'restart': { help: 'Restart playback', action: () => { els.audio.currentTime = 0; els.audio.play().catch(() => {}); } },

  /* === Linked cvars (mirror a DOM input) === */
  'voice_overdrive': { help: 'Microphone gain boost (sender)', link: 'gain', flags: FCVAR.CHEAT },
  'voice_scale':     { help: 'Receiver playback gain (0..2)', link: 'voice_scale' },
  'dsp_hpf':         { help: 'Sender high-pass filter cutoff', link: 'hp' },
  'dsp_lpf':         { help: 'Sender low-pass filter cutoff',  link: 'lp' },
  'snd_bits':        { help: 'Codec bitrate scale (16 = stock)', link: 'bits' },
  'snd_agc':         { help: 'Reference-tuned RMS voice leveling for Steam profiles (0 = off)', link: 'agc' },
  'net_fakeloss':    { help: 'Simulated packet loss %',        link: 'loss' },
  'net_split':       { help: 'Packet frame size in ms',        link: 'frameMs' },
  'snd_warble':      { help: 'Enable codec quantization (0 = clean)', link: 'warble_on' },
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
});

function runPreset(name) {
  if (!name) return;
  const cleanName = String(name).replace('exec ', '').replace('preset_', '').replace(/\.cfg$/, '');
  const p = PRESETS[cleanName];
  if (!p) {
    // Fall back to user presets saved via preset_save
    const user = LS.get('tf2ve_presets', {});
    if (user[cleanName]) { applyConfig(user[cleanName]); logLine(`exec user_${cleanName}.cfg`, 'cmd'); return; }
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
  execCommand(`voice_overdrive ${p.gain}`);
  execCommand(`net_fakeloss ${p.loss}`);
  execCommand('snd_bits 16');
  execCommand('snd_warble 1');
  execCommand('snd_agc 1');
  execCommand('snd_real_opus 1');
  execCommand('net_split 20');
  execCommand('net_jitter 0');
  state.sv_cheats = tempCheats;
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
  logLine(`version : 2.0.0.1  / 24 ${CODEC_PROFILES[els.codec.value].sampleRate} secure`);
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
  configControl('frame', els.frameMs),
  configControl('loss', els.loss),
  configControl('warble', els.warble),
  configControl('cdur', els.cDur),
  configControl('cdec', els.cDec),
  configControl('cmix', els.cMix),
  ['real', () => String(state.realOpus),
    v => { state.realOpus = Number(v); cvars.snd_real_opus.val = Number(v); },
    v => ['0', '1'].includes(String(v)) ? String(v) : null],
  ['jit', () => String(state.netJitter),
    (v) => { state.netJitter = Number(v); },
    (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.min(50, Math.max(0, n))) : null; }]
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

function mountSource(mono, sampleRate, name) {
  const duration = mono.length / sampleRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('the clip has no decodable audio');
  if (duration > MAX_AUDIO_SECONDS) throw new Error('the clip exceeds the 10 minute limit');
  state.sourceName = name;
  if (state.dryBlob) URL.revokeObjectURL(state.dryBlob);
  if (state.lastBlob) URL.revokeObjectURL(state.lastBlob);
  state.lastBlob = null;
  state.processedBuffer = null;
  state.decodedSource = { sampleRate, duration, length: mono.length,
    numberOfChannels: 1, getChannelData: () => mono };
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
  setStatus(`${name} · ${duration.toFixed(1)}s · ${sampleRate.toLocaleString()} Hz`, 'success');
  logLine(`FS_MountFile: "${name}" (${duration.toFixed(1)}s) mounted.`, 'sys');
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
    mountSource(TF2Audio.bufferToMono(decoded), decoded.sampleRate, name);
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
    els.mic.textContent = '🎤 Mic';
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

els.conIn.addEventListener('input', () => {
  const val = els.conIn.value;
  els.conHint.replaceChildren();
  if (!val) { updateCompleteBtn(); return; }
  const lowerVal = val.toLowerCase();
  const matches = Object.keys(cvars).filter(k => k.startsWith(lowerVal));
  if (matches.length) {
    const match = matches[0];
    const typedLen = val.length;
    if (typedLen < match.length) {
      const spacer = document.createElement('span');
      spacer.style.color = 'transparent';
      spacer.textContent = match.substring(0, typedLen);
      els.conHint.append(spacer, document.createTextNode(match.substring(typedLen)));
    }
  }
  updateCompleteBtn();
});

// Show the ⇥ tap-complete button whenever a hint is visible (touch
// keyboards have no Tab key).
function updateCompleteBtn() {
  if (!els.conComplete) return;
  els.conComplete.style.display = els.conHint.textContent.trim() ? 'block' : 'none';
}

function completeConsole() {
  const val = els.conIn.value;
  if (!val) return;
  const matches = Object.keys(cvars).filter(k => k.startsWith(val.toLowerCase()));
  if (matches.length === 1) { els.conIn.value = matches[0] + " "; els.conHint.textContent = ""; }
  else if (matches.length > 1) logLine(`> ${matches.join(', ')}`, 'help');
  updateCompleteBtn();
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
      els.conIn.value = ''; els.conHint.textContent = '';
      updateCompleteBtn();
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
      state.cmdIndex = state.cmdHistory.length; els.conIn.value = ''; els.conHint.textContent = '';
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

async function runAudioProcess(source, opts) {
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
      micGain:     Number(els.gain.value),
      voiceScale:  Number(els.voiceScale.value),
      hp:          Number(els.hp.value),
      lp:          Number(els.lp.value),
      bits:        Number(els.bits.value),
      agc:         els.agc.value === '1',
      lossPct:     Number(els.loss.value),
      frameMs:     Number(els.frameMs.value),  // net_split — previously never passed
      enableWarble: els.warble.value === '1',
      jitterPct:   state.netJitter,
      realCodec:   state.realOpus === 1,
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

    // Report the actual processing path, including explicit approximations.
    if (codecKey === 'steam' || codecKey === 'steam_48') {
      logLine(realOpus
        ? `S_Voice: ${codecInfo.version}, ${codecInfo.bitrate / 1000} kbps, 20 ms frames, native PLC`
        : 'S_Voice: approximate effect or codec bypass selected', 'sys');
    }

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

    drawStaticWaveform();
    const method = realOpus ? `Real Opus · ${codecInfo.bitrate / 1000} kbps`
      : (opts.enableWarble ? 'Approximate codec effect' : 'Codec bypassed');
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
/* ------------------------------------------------------------------ */

const ctx = els.canvas.getContext('2d', { alpha: false });

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  // Only touch the backing store when the size REALLY changed — assigning
  // canvas.width clears the canvas, and comparing against fractional dpr
  // sizes failed every frame, wiping the spectrogram history each redraw.
  if (els.canvas.width !== W || els.canvas.height !== H) {
    els.canvas.width = W;
    els.canvas.height = H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { w: rect.width, h: rect.height };
}

function drawGrid(w, h) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
}

function animateSpectrum() {
  if (!state.isPlaying) return;
  const { w, h } = resizeCanvas();
  if (!state.analyser) { drawGrid(w, h); return; }
  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = state.freqData || (state.freqData = new Uint8Array(bufferLength));
  state.analyser.getByteFrequencyData(dataArray);
  if (state.vizMode === 'spec') {
    drawSpectrogramColumn(dataArray, w, h);
    state.animationId = requestAnimationFrame(animateSpectrum);
    return;
  }
  drawGrid(w, h);
  const barWidth = (w / bufferLength) * 2.5;
  let x = 0, sum = 0;
  for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
  const isLoud = (sum / bufferLength) > 60;
  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * h;
    ctx.fillStyle = (isLoud && barHeight > h * 0.6)
      ? `rgb(${barHeight + 100}, 50, 50)`
      : `rgb(50, ${barHeight + 100}, 240)`;
    ctx.fillRect(x, h - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
  state.animationId = requestAnimationFrame(animateSpectrum);
}

function drawStaticWaveform() {
  if (!state.processedBuffer) return;
  const { w, h } = resizeCanvas();
  drawGrid(w, h);
  ctx.fillStyle = '#66c0f4';
  const data = state.processedBuffer;
  const step = Math.max(1, Math.ceil(data.length / w));
  const amp = h / 2;
  for (let i = 0; i < w; i++) {
    let min = 1.0, max = -1.0;
    const startIdx = i * step;
    const endIdx = Math.min(startIdx + step, data.length);
    for (let j = startIdx; j < endIdx; j++) {
      const val = data[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    if (max < min) { min = 0; max = 0; }
    const yTop = (1 - max) * amp;
    const yBot = (1 - min) * amp;
    ctx.fillRect(i, yTop, 1, Math.max(1, yBot - yTop));
  }
}

function drawScrubFrame() {
  if (state.isPlaying || !state.processedBuffer) return;
  const { w, h } = resizeCanvas();
  drawGrid(w, h);
  const pct = els.audio.currentTime / els.audio.duration;
  if (!isFinite(pct) || pct < 0 || pct > 1) return;
  const bufferIdx = Math.floor(pct * state.processedBuffer.length);
  const fftSize = 256, binCount = 128;
  const out = new Float32Array(binCount);
  const twoPi = 2 * Math.PI;
  for (let k = 0; k < binCount; k++) {
    let r = 0, im = 0;
    for (let n = 0; n < fftSize; n++) {
      if (bufferIdx + n >= state.processedBuffer.length) break;
      const x = state.processedBuffer[bufferIdx + n];
      const wn = 0.5 * (1 - Math.cos((twoPi * n) / (fftSize - 1)));
      const theta = (twoPi * k * n) / fftSize;
      r += (x * wn) * Math.cos(theta);
      im += (x * wn) * Math.sin(theta);
    }
    out[k] = Math.sqrt(r * r + im * im);
  }
  const barWidth = (w / binCount) * 2.5;
  let x = 0;
  for (let i = 0; i < binCount; i++) {
    const val = Math.min(1.0, out[i] * 3.5);
    const barHeight = val * h;
    ctx.fillStyle = (barHeight > h * 0.6)
      ? `rgb(${barHeight + 100}, 50, 50)`
      : `rgb(50, ${barHeight + 100}, 240)`;
    ctx.fillRect(x, h - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
}

// Scrolling spectrogram: shift left by an exact integer number of device
// pixels, then paint the newest column on the right.
//
// Blur fix: the old version scrolled by drawing the canvas onto itself with a
// dpr-scaled transform and default (bilinear) smoothing, so source and dest
// widths never matched exactly. Every pixel got re-resampled ~60x/second and
// the tiny errors accumulated into horizontal motion blur. Here we drop to raw
// device-pixel space, turn smoothing OFF, and copy a block whose source and
// destination dimensions are identical — a 1:1 integer translation with zero
// resampling, so columns stay razor-crisp no matter how long it scrolls.
function drawSpectrogramColumn(dataArray, w, h) {
  const cw = els.canvas.width;                    // backing store, device px
  const ch = els.canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const shift = Math.max(1, Math.round(dpr));     // integer px/frame == 1 CSS px

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);             // work in raw device pixels
  ctx.imageSmoothingEnabled = false;              // no bilinear filtering

  // Exact 1:1 copy (src size === dest size) shifted left by `shift` px.
  ctx.drawImage(els.canvas, shift, 0, cw - shift, ch, 0, 0, cw - shift, ch);

  // Blank the freed strip on the right before painting the new column.
  ctx.fillStyle = '#000';
  ctx.fillRect(cw - shift, 0, shift, ch);

  const bins = dataArray.length;
  const rowH = ch / bins;
  for (let i = 0; i < bins; i++) {
    const v = dataArray[i];
    if (v < 6) continue;
    ctx.fillStyle = `hsl(${Math.max(0, 240 - v * 1.1)}, 90%, ${8 + (v / 255) * 45}%)`;
    ctx.fillRect(cw - shift, ch - (i + 1) * rowH, shift, rowH + 0.5);
  }
  ctx.restore();                                  // back to the dpr transform
}

// Segmented BARS | SPEC control: light the active side, expose it to
// assistive tech, and reset the canvas for the chosen mode.
function setVizMode(mode) {
  if (state.vizMode === mode) return;
  state.vizMode = mode;
  const isSpec = mode === 'spec';
  if (els.vizBars) {
    els.vizBars.classList.toggle('active', !isSpec);
    els.vizBars.setAttribute('aria-pressed', String(!isSpec));
  }
  if (els.vizSpec) {
    els.vizSpec.classList.toggle('active', isSpec);
    els.vizSpec.setAttribute('aria-pressed', String(isSpec));
  }
  const { w, h } = resizeCanvas();
  if (isSpec) {
    // Start the spectrogram from a clean black field so the bar grid's
    // centre line doesn't scroll across it as a stray streak.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  } else {
    drawGrid(w, h);
    if (!state.isPlaying) drawStaticWaveform();
  }
}

if (els.vizBars) els.vizBars.addEventListener('click', () => setVizMode('bars'));
if (els.vizSpec) els.vizSpec.addEventListener('click', () => setVizMode('spec'));

els.audio.addEventListener('play', () => {
  if (!state.audioCtx) {
    try {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 256;
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
      state.analyser = null;   // visualizer off; playback itself unaffected
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  if (els.audioDry && els.audioDry.src) { syncDry(); els.audioDry.play().catch(() => {}); }
  state.isPlaying = true;
  cancelAnimationFrame(state.animationId);
  animateSpectrum();
});
els.audio.addEventListener('pause',  () => { if (els.audioDry) els.audioDry.pause(); state.isPlaying = false; cancelAnimationFrame(state.animationId); drawScrubFrame(); });
els.audio.addEventListener('ended',  () => { if (els.audioDry) els.audioDry.pause(); state.isPlaying = false; cancelAnimationFrame(state.animationId); drawStaticWaveform(); });
els.audio.addEventListener('seeking', drawScrubFrame);
els.audio.addEventListener('seeked',  () => { syncDry(); drawScrubFrame(); });
window.addEventListener('resize', () => { if (!state.isPlaying) drawStaticWaveform(); });

/* ------------------------------------------------------------------ */
/* Net graph (only spins when visible)                                */
/* ------------------------------------------------------------------ */

let lastTime = performance.now(), frameCount = 0, netGraphId = 0;
function updateNetGraph() {
  netGraphId = requestAnimationFrame(updateNetGraph);
  const now = performance.now();
  frameCount++;
  if (now - lastTime < 500) return;
  if (els.ng.style.display !== 'none') {
    const fps = Math.round(frameCount * 2);
    els.ngFps.textContent = fps;
    const lerpBase = parseFloat(els.frameMs.value) * 2;
    els.ngLerp.textContent = (lerpBase + (Math.random() * 2)).toFixed(1);
    els.ngPing.textContent = Math.floor(Math.random() * 15) + 5;
    els.ngLoss.textContent = els.loss.value;
    els.ngFill.style.width = Math.min(100, (fps / 60) * 100) + '%';
    els.ngFill.style.background = (fps < 30) ? '#ff4040' : '#a4d007';
  }
  frameCount = 0;
  lastTime = now;
}
updateNetGraph();

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

  const bootLogs = [
    { t: "Valve Software - Source Engine [ Build 22050 ]", c: 'text' },
    { t: "Heap: 256.00 Mb", c: 'text' },
    { t: "Parsed 358 text messages", c: 'text' },
    { t: "execing autoexec.cfg", c: 'text' },
    { t: "cc_lang_listener: loading linguistics_en.txt", c: 'text' },
    { t: "Sound System: Init (2 channels, 16bit)", c: 'sys' },
    { t: `sv_voicecodec: ${(CODEC_PROFILES[els.codec.value] || CODEC_PROFILES.celt_22).displayName}`, c: 'cmd' },
    { t: "Parallel processing initialized", c: 'text' },
    { t: "Type 'help' for commands. Try 'exec preset_spam' for the classic TF2 sound.", c: 'sys' },
    { t: "System Ready.", c: 'sys' }
  ];
  let delay = 0;
  bootLogs.forEach(line => { setTimeout(() => logLine(line.t, line.c), delay); delay += Math.random() * 150 + 50; });
  setTimeout(() => { if (state.simEnabled) simulator.start(); }, delay + 500);
})();
