# LAME 3.100 (WebAssembly)

This folder holds the MP3 encoder behind the MP3 download option. MP3 files are VBR at LAME's highest VBR setting (`lame -V 0`, mono).

- `lame-3.100.wasm.mjs`: the module, base64 encoded. It contains:
  - libmp3lame from the unmodified LAME 3.100 release, `lame-3.100.tar.gz` (SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`, from https://lame.sourceforge.io)
  - the musl 1.2.5 math functions it needs, at commit `0784374d561435f7c787a555aeab8ede699ed298`

  The module has no imports.
- `index.mjs`: a loader with `encodeMp3(int16Samples, sampleRate)`. The file starts with LAME's Xing/Info tag, which gives players the exact length (gapless).
- `COPYING.lame`: the LAME license, the GNU LGPL version 2. `COPYRIGHT.musl`: the musl license (MIT).

LAME is a separate module that the app loads only when an MP3 is saved. You can rebuild it from the release sources, or replace it with another build: run `node tests/lame/build.mjs`. The build uses `tests/lame/` (a `config.h`, a small C wrapper and C library shims) and `tests/libopus11/libc.c`. It needs curl, tar, git, clang with the wasm32 target, and wasm-ld; no Emscripten.

Built with Ubuntu clang 18.1.3, the module's SHA-256 is `732c2c129f88e92eae1542783ddb1d299c908a0cb49ea4224f46766761c92877`. Its MP3s are byte-identical to a native gcc build of the same sources.
