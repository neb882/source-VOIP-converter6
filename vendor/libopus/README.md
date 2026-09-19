# Bundled Opus runtime

- Wrapper: libopus-wasm 0.4.0, https://github.com/openclaw/libopus-wasm
- Codec reported by the binary: libopus 1.6.1
- Source license: https://github.com/xiph/opus/blob/v1.6.1/COPYING
- npm archive integrity: `sha512-k7XznZMcDSgIl7uHdiCdIPaPfVLslf3C90jcJIEiC5OLK2Qy+M2CMmeAokDca6bbYRnSCVZ9/sUEOSfDrX60Qw==`

The runtime and embedded WebAssembly are copied unmodified. `dist/index.js`
is named `index.mjs` here for consistent Node/browser module loading. Reproduce
with `pnpm install --frozen-lockfile` then `pnpm vendor:opus`. Verify with
`pnpm test:vendor`. Retain both license files and the third-party notices.

These files are required on GitHub Pages, including for offline conversion.
They are not disposable development dependencies.
