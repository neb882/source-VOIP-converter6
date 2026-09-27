/* Live monitor, audio thread: sends the microphone to live-worker.js in
 * 20 ms blocks and plays what comes back from a small jitter buffer.
 * Playback starts (and restarts after running dry) once `prebuffer`
 * samples are queued. When a stall (a settings change rebuilding the
 * chain) leaves more than 2.5 times that queued, the oldest audio is
 * skipped, so latency does not grow. */
class LiveMonitorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.block = o.block || 960;
    this.channel = o.channel || 'left';
    this.prebuffer = o.prebuffer || 1920;
    this.input = new Float32Array(this.block);
    this.filled = 0;
    this.chunks = [];
    this.offset = 0;      // read position in chunks[0]
    this.queued = 0;
    this.playing = false;
    this.underruns = 0;
    this.skips = 0;
    this.sent = 0;
    this.played = 0;
    this.stopped = false;
    this.bridge = null;
    this.lastReport = 0;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'bridge') {
        this.bridge = message.port;
        this.bridge.onmessage = (e) => {
          if (e.data && e.data.type === 'out') {
            const samples = new Float32Array(e.data.samples);
            this.chunks.push(samples);
            this.queued += samples.length;
          }
        };
      } else if (message.type === 'channel') {
        this.channel = message.channel;
      } else if (message.type === 'stop') {
        this.stopped = true;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0], out = outputs[0][0];
    if (input && input.length && this.bridge) {
      const left = input[0], right = input[1] || input[0];
      for (let i = 0; i < left.length; i++) {
        this.input[this.filled++] = this.channel === 'right' ? right[i] : this.channel === 'mix' ? (left[i] + right[i]) / 2 : left[i];
        if (this.filled === this.block) {
          this.bridge.postMessage({ type: 'in', samples: this.input.buffer }, [this.input.buffer]);
          this.sent += this.block;
          this.input = new Float32Array(this.block);
          this.filled = 0;
        }
      }
    }
    if (this.queued > this.prebuffer * 2.5) {
      let drop = this.queued - this.prebuffer;
      this.queued -= drop;
      this.skips++;
      while (drop > 0) {
        const rest = this.chunks[0].length - this.offset;
        if (rest <= drop) { drop -= rest; this.chunks.shift(); this.offset = 0; }
        else { this.offset += drop; drop = 0; }
      }
    }
    if (!this.playing && this.queued >= this.prebuffer) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || !this.queued) { out[i] = 0; continue; }
      const chunk = this.chunks[0];
      out[i] = chunk[this.offset++];
      this.queued--;
      this.played++;
      if (this.offset >= chunk.length) { this.chunks.shift(); this.offset = 0; }
      if (!this.queued) { this.playing = false; this.underruns++; }
    }
    if (currentTime - this.lastReport > 0.1) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'stats', queued: this.queued, underruns: this.underruns, skips: this.skips, sent: this.sent, played: this.played });
    }
    return !this.stopped;
  }
}

registerProcessor('tf2-live-monitor', LiveMonitorProcessor);
