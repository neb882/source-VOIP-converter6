/* TF2 Voice Emulator, app/console.js: The developer console: utilities, cvars, command dispatch, share links, presets and history.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

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
  'voice_retime':    { help: "TF2's early talk-spurt starts after short silences (1), or the source's timing (0)", link: 'retime' },
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
    ['Codec', !codecOn ? 'bypassed' : codec.engine === 'celt011'
      ? `CELT 0.11 ${codec.codecRate / 1000} kHz · ${Math.max(8, Math.round(codec.packetBytes * bits / 16))}-byte packets of ${(1000 * codec.frameSize / codec.codecRate).toFixed(1)} ms`
      : `Opus ${codec.codecRate / 1000} kHz · ${codec.encoder?.vbr ? 'VBR ' : ''}${kbps} kbps${codec.encoder?.dtx ? ' · DTX' : ''} · ${mode}`, codecOn ? '' : 'off'],
    ['Network', `${packetMs} ms packets · ${loss}% lost${jitter > 0 ? ` · ${jitter} ms jitter` : ''}`, loss > 0 || jitter > 0 ? 'hot' : ''],
    ['Receiver', `${agcOn ? `auto-gain ≤${maxGain}× · int16 clip` : 'unity gain · int16 clip'}${els.retime && els.retime.value === '1' ? ' · spurts re-timed' : ''}`, ''],
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
  configControl('jit', els.jitter),
  configControl('retime', els.retime)
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
