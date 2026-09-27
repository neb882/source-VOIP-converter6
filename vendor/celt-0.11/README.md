# CELT 0.11 (WebAssembly)

This folder holds the codec for the `vaudio_celt` and `vaudio_celt_high` profiles. Source's engine CELT codecs are CELT 0.11 in a custom mode (see `tests/LEGACY_CODECS.md`), not the CELT layer of Opus.

- `celt-0.11.wasm.mjs`: the module, base64 encoded. It contains:
  - CELT from [mumble-voip/celt-0.11.0](https://github.com/mumble-voip/celt-0.11.0) at commit `e18de7747fb1655e66bf8d291560587036bfe53c`, float build with custom modes. This is the tree Mumble ships as CELT 0.11.0 and the public CS:GO voice decoders build against.
  - the musl 1.2.5 math functions it needs, at commit `0784374d561435f7c787a555aeab8ede699ed298`, and the small C library from `tests/libopus11/libc.c`

  The module has no imports, so it gives the same output in every browser.
- `index.mjs`: `createCodec(rate, frameSize, { packetBytes, complexity })` returns a mono encoder and decoder pair: fixed-size packets, the decoder's own loss concealment, and `restart()` for a new talk spurt.
- `COPYING.celt`: CELT license (BSD). `COPYRIGHT.musl`: musl license (MIT).

To rebuild the module, run `node tests/celt011/build.mjs`. It needs git, clang with the wasm32 target, and wasm-ld; no Emscripten.

Built with Ubuntu clang 18.1.3, `celt-0.11.wasm.mjs` has SHA-256 `6f2522f50db3167cbff36e73518cbeda55db720a71219cef35923ce0c9c756e5` (the WebAssembly inside it: `2947bcd94aff0303ccfec291bf71bbfdbd764101a7053fadea582fc32a7b8770`, 113 290 bytes). `pnpm test:vendor` checks it.
