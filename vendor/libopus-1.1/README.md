# libopus 1.1.5 (WebAssembly)

This folder holds the codec for the Steam profile. Steam's own voice packets match libopus 1.1.x: frame sizes, DTX decisions, and decoded spectrum and comfort noise (see `tests/REFERENCE_2026.md`, finding 16). The other profiles keep libopus 1.6.1 from `../libopus`.

- `libopus-1.1.5.wasm.mjs`: the module, base64 encoded. It contains:
  - libopus 1.1.5 at commit `d3977edab4cbfeafd3650b572c78711e0b04a5f8`, float build without SIMD
  - the musl 1.2.5 math functions it needs, at commit `0784374d561435f7c787a555aeab8ede699ed298`

  The module has no imports, so it gives the same output in every browser.
- `index.mjs`: a loader with the subset of the libopus-wasm API that `opus-codec.mjs` uses.
- `COPYING.opus`: libopus license (BSD). `COPYRIGHT.musl`: musl license (MIT).

To rebuild the module, run `node tests/libopus11/build.mjs`. It needs git, clang with the wasm32 target, and wasm-ld; no Emscripten.

Built with Ubuntu clang 18.1.3, the module's SHA-256 is `b7a03edba67393bbe23b3c531486f1e56f9ebdba3727e2b90c97025821f718d0`. On the SourceTV test packets its output is bit-exact with a native gcc build of the same release.
