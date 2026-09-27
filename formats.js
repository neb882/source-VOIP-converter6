/* Download formats. Every render is kept as a 16-bit mono WAV, and the other
 * formats are made from that WAV when a file is saved:
 *   - FLAC: lossless, via flac.js (decodes to the same samples as the WAV)
 *   - MP3: LAME 3.100 at -V 0, via vendor/lame (loaded on first use); rates
 *     MP3 cannot carry are resampled to 48 or 44.1 kHz first
 * Runs in the page and in audio-worker.js.
 *
 * TF2Formats.FORMATS[key] -> { label, ext, mime }
 * TF2Formats.readWav(bytes) -> { samples: Int16Array, sampleRate }
 * TF2Formats.fromWav(wavBytes, key) -> Promise<Uint8Array>
 */
(function () {
  'use strict';

  const FORMATS = {
    wav:  { label: 'WAV',  ext: 'wav',  mime: 'audio/wav' },
    flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac' },
    mp3:  { label: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg' }
  };
  const MP3_RATES = [32000, 44100, 48000];

  // 16-bit mono PCM WAV, as TF2Audio.encodeWav writes it.
  function readWav(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
    let sampleRate = 0, samples = null;
    for (let o = 12; o + 8 <= b.length;) {
      const id = tag(o), size = view.getUint32(o + 4, true);
      if (id === 'fmt ') {
        if (view.getUint16(o + 8, true) !== 1 || view.getUint16(o + 10, true) !== 1 || view.getUint16(o + 22, true) !== 16) {
          throw new Error('only 16-bit mono PCM WAV can be converted');
        }
        sampleRate = view.getUint32(o + 12, true);
      } else if (id === 'data') {
        const len = Math.min(size, b.length - o - 8) & ~1;
        samples = new Int16Array(len / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(o + 8 + 2 * i, true);
      }
      o += 8 + size + (size & 1);
    }
    if (!sampleRate || !samples) throw new Error('WAV file has no fmt or data chunk');
    return { samples, sampleRate };
  }

  let lamePromise = null;
  function loadLame() {
    if (!lamePromise) {
      lamePromise = import('./vendor/lame/index.mjs').catch((error) => {
        lamePromise = null;
        throw new Error('The MP3 encoder could not load. Serve the complete folder over HTTP(S). ' + error.message);
      });
    }
    return lamePromise;
  }

  async function toMp3(samples, sampleRate) {
    if (!MP3_RATES.includes(sampleRate)) {
      const target = sampleRate % 11025 === 0 ? 44100 : 48000;
      const float = new Float32Array(samples.length);
      for (let i = 0; i < float.length; i++) float[i] = samples[i] / 32768;
      samples = TF2Audio.toInt16(TF2Audio.resampleSinc(float, sampleRate, target));
      sampleRate = target;
    }
    return (await loadLame()).encodeMp3(samples, sampleRate, { vbrQuality: 0 });
  }

  async function fromWav(wavBytes, key) {
    const bytes = wavBytes instanceof Uint8Array ? wavBytes : new Uint8Array(wavBytes);
    if (key === 'wav') return bytes;
    const { samples, sampleRate } = readWav(bytes);
    if (key === 'flac') return TF2Flac.encode(samples, sampleRate);
    if (key === 'mp3') return toMp3(samples, sampleRate);
    throw new RangeError(`Unknown download format "${key}"`);
  }

  const TF2Formats = { FORMATS, readWav, fromWav };
  if (typeof window !== 'undefined') window.TF2Formats = TF2Formats;
  else if (typeof self !== 'undefined') self.TF2Formats = TF2Formats;
  if (typeof module !== 'undefined' && module.exports) module.exports = TF2Formats;
})();
