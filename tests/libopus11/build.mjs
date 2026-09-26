// Build libopus 1.1.5 (float) to WebAssembly for the Steam profile.
//
//   node tests/libopus11/build.mjs [opus-1.1.5-checkout] [musl-1.2.5-checkout]
//
// Steam's voice packets match libopus 1.1.x (tests/REFERENCE_2026.md, finding 16),
// so the Steam profile encodes and decodes with this release. Needs git, clang
// with the wasm32 target, and wasm-ld; no Emscripten. The few libm functions
// libopus needs come from musl and are compiled in, so the module has no imports
// and gives the same output in every browser. Checkouts not given are cloned at
// the pinned commits. Writes vendor/libopus-1.1/libopus-1.1.5.wasm.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v1.1.5', COMMIT = 'd3977edab4cbfeafd3650b572c78711e0b04a5f8';
const MUSL_TAG = 'v1.2.5', MUSL_COMMIT = '0784374d561435f7c787a555aeab8ede699ed298';
// musl's double-precision functions that libopus calls, and their helpers.
const MUSL_MATH = ['exp', 'exp_data', 'exp2', 'log', 'log_data', 'log10', 'pow', 'pow_data', 'cos', '__cos', '__sin',
  '__rem_pio2', '__rem_pio2_large', 'atan2', 'atan', '__math_oflow', '__math_uflow', '__math_xflow', '__math_invalid',
  '__math_divzero', 'scalbn', 'floor', 'fabs'];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opus11-'));
function checkout(given, name, url, tag, commit) {
  const dir = given || path.join(tmp, name);
  if (!given) run('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, url, dir]);
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
  if (head !== commit) throw new Error(`Expected ${name} ${tag} at ${commit}, found ${head}`);
  return dir;
}
const src = checkout(process.argv[2], 'opus', 'https://github.com/xiph/opus.git', TAG, COMMIT);
const musl = checkout(process.argv[3], 'musl', 'https://git.musl-libc.org/git/musl', MUSL_TAG, MUSL_COMMIT);

// Source lists from the release's automake fragments: the float build, no SIMD.
const vars = {};
for (const mk of ['celt_sources.mk', 'silk_sources.mk', 'opus_sources.mk']) {
  const text = fs.readFileSync(path.join(src, mk), 'utf8').replace(/\\\n/g, ' ');
  for (const m of text.matchAll(/^(\w+)\s*=\s*(.*)$/gm)) vars[m[1]] = m[2].split(/\s+/).filter(Boolean);
}
const sources = [...vars.CELT_SOURCES, ...vars.SILK_SOURCES, ...vars.SILK_SOURCES_FLOAT, ...vars.OPUS_SOURCES,
  ...vars.OPUS_SOURCES_FLOAT].map(s => path.join(src, s));
sources.push(path.join(here, 'libc.c'), path.join(here, 'api.c'));

const cflags = ['--target=wasm32', '-O2', '-nostdlibinc', '-isystem', path.join(here, 'include'),
  ...['include', 'celt', 'silk', 'silk/float'].map(d => `-I${path.join(src, d)}`),
  '-DOPUS_BUILD', '-DVAR_ARRAYS', '-DHAVE_LRINTF', '-DPACKAGE_VERSION="1.1.5"', '-ffp-contract=off', '-w'];
const objects = sources.map((s, i) => {
  const o = path.join(tmp, `${i}.o`);
  run('clang', [...cflags, '-c', s, '-o', o]);
  return o;
});
// musl's own headers, with arm's 32-bit type definitions (ILP32, FLT_EVAL_METHOD 0).
const bits = path.join(tmp, 'musl-bits/bits');
fs.mkdirSync(bits, { recursive: true });
fs.writeFileSync(path.join(bits, 'alltypes.h'), run('sed', ['-f', path.join(musl, 'tools/mkalltypes.sed'),
  path.join(musl, 'arch/arm/bits/alltypes.h.in'), path.join(musl, 'include/alltypes.h.in')]));
const muslFlags = ['--target=wasm32', '-O2', '-nostdinc', '-ffreestanding', '-std=c99', '-D_XOPEN_SOURCE=700', '-w',
  ...['arch/arm', 'arch/generic'].map(d => `-I${path.join(musl, d)}`), `-I${path.dirname(bits)}`,
  ...['src/include', 'src/internal', 'include'].map(d => `-I${path.join(musl, d)}`)];
for (const f of MUSL_MATH) {
  const o = path.join(tmp, `musl_${f}.o`);
  run('clang', [...muslFlags, '-c', path.join(musl, 'src/math', `${f}.c`), '-o', o]);
  objects.push(o);
}
const exports = ['opus_encoder_create', 'opus_encoder_destroy', 'opus_encode_float', 'opus_decoder_create',
  'opus_decoder_destroy', 'opus_decode_float', 'opus_get_version_string', 'oc_encoder_set', 'oc_encoder_get',
  'oc_decoder_set', 'malloc', 'free'];
const wasm = path.join(tmp, 'libopus.wasm');
run('wasm-ld', ['--no-entry', '--stack-first', '-z', 'stack-size=1048576',
  ...exports.map(e => `--export=${e}`), ...objects, '-o', wasm]);

const bytes = fs.readFileSync(wasm);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => `${i.module}.${i.name}`);
if (imports.length) throw new Error(`Unexpected imports: ${imports.join(', ')}`);
const clang = run('clang', ['--version']).split('\n')[0];
const out = path.join(root, 'vendor/libopus-1.1/libopus-1.1.5.wasm.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `// libopus 1.1.5 (${COMMIT}) with musl 1.2.5 libm (${MUSL_COMMIT})\n` +
  `// as WebAssembly, built by tests/libopus11/build.mjs with ${clang}.\n` +
  `export default '${bytes.toString('base64')}';\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${bytes.length} bytes of wasm, ${sources.length + MUSL_MATH.length} sources, no imports`);
