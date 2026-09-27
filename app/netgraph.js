/* TF2 Voice Emulator, app/netgraph.js: The net_graph overlay.
 * One of the page scripts that were script.js, loaded in order by
 * index.html (core, console, source, render, meter, realtake,
 * visualizer, netgraph, boot); they share their top-level names. */

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
