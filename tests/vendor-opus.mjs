// Copy the pinned runtime verbatim; --check verifies the checked-in assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'node_modules/libopus-wasm');
const target = path.join(root, 'vendor/libopus');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (pkg.version !== '0.4.0') throw new Error('Expected libopus-wasm 0.4.0');
const files = {
  'dist/index.js': 'index.mjs',
  'dist/generated/libopus.generated.mjs': 'generated/libopus.generated.mjs',
  'LICENSE': 'LICENSE',
  'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md'
};
for (const [from, to] of Object.entries(files)) {
  const dest = path.join(target, to);
  if (process.argv.includes('--check')) {
    if (!fs.readFileSync(path.join(source, from)).equals(fs.readFileSync(dest))) {
      throw new Error(`Vendored Opus differs from the pinned package: ${to}`);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, from), dest);
  }
}
console.log('Opus runtime matches libopus-wasm 0.4.0.');

// The libopus 1.1.5 build for the Steam profile comes from tests/libopus11/build.mjs,
// which needs clang and wasm-ld; here only its recorded hash is checked.
if (process.argv.includes('--check')) {
  const { createHash } = await import('node:crypto');
  const built = fs.readFileSync(path.join(root, 'vendor/libopus-1.1/libopus-1.1.5.wasm.mjs'));
  const expected = 'b7a03edba67393bbe23b3c531486f1e56f9ebdba3727e2b90c97025821f718d0';
  if (createHash('sha256').update(built).digest('hex') !== expected) {
    throw new Error('vendor/libopus-1.1/libopus-1.1.5.wasm.mjs differs from the recorded build');
  }
  console.log('libopus 1.1.5 build matches its recorded hash.');
  // Likewise the CELT 0.11 build (tests/celt011/build.mjs) for vaudio_celt.
  const celt = fs.readFileSync(path.join(root, 'vendor/celt-0.11/celt-0.11.wasm.mjs'));
  if (createHash('sha256').update(celt).digest('hex') !== '6f2522f50db3167cbff36e73518cbeda55db720a71219cef35923ce0c9c756e5') {
    throw new Error('vendor/celt-0.11/celt-0.11.wasm.mjs differs from the recorded build');
  }
  console.log('CELT 0.11 build matches its recorded hash.');
}
