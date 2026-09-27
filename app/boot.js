/* TF2 Voice Emulator, app/boot.js: Boot: restores history and shared settings, starts the console.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

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
