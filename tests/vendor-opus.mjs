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
