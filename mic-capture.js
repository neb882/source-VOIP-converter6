// Capture uncompressed mono PCM; the converter performs the only codec pass.
class MicCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.limit = options.processorOptions.maxSamples;
    this.count = 0;
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.done = false;
    this.port.onmessage = e => { if (e.data === 'stop') this.finish(); };
  }
  flush() {
    if (!this.used) return;
    const data = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'samples', data }, [data.buffer]);
    this.used = 0;
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.flush();
    this.port.postMessage({ type: 'complete' });
  }
  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length && this.count < this.limit; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.buffer[this.used++] = sample / channels.length;
      this.count++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.count >= this.limit) this.finish();
    return !this.done;
  }
}
registerProcessor('mic-capture', MicCapture);
