// Build CELT 0.11 (float) to WebAssembly for the vaudio_celt profile.
//
//   node tests/celt011/build.mjs [celt-0.11.0-checkout] [musl-1.2.5-checkout]
//
// Source's vaudio_celt is CELT 0.11 in a custom mode: 22050 Hz, 512-sample
// frames, 64-byte packets, complexity 10 (tests/LEGACY_CODECS.md). This builds
// the tree Mumble ships as celt-0.11.0, which the public CS:GO voice decoders
// use, with custom modes enabled. Same toolchain as tests/libopus11/build.mjs:
// git, clang with the wasm32 target and wasm-ld; its minimal libc and musl's
// libm are compiled in, so the module has no imports. Checkouts not given are
// cloned at the pinned commits. Writes vendor/celt-0.11/celt-0.11.wasm.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'e18de7747fb1655e66bf8d291560587036bfe53c';
const MUSL_TAG = 'v1.2.5', MUSL_COMMIT = '0784374d561435f7c787a555aeab8ede699ed298';
// musl's double-precision functions that CELT calls, and their helpers.
const MUSL_MATH = ['exp', 'exp_data', 'exp2', 'log', 'log_data', 'log10', 'pow', 'pow_data', 'cos', '__cos', '__sin',
  'sin', '__rem_pio2', '__rem_pio2_large', 'atan2', 'atan', '__math_oflow', '__math_uflow', '__math_xflow',
  '__math_invalid', '__math_divzero', 'scalbn', 'floor', 'fabs'];
const SOURCES = ['bands', 'celt', 'cwrs', 'entcode', 'entdec', 'entenc', 'header', 'kiss_fft', 'laplace', 'mathops',
  'mdct', 'modes', 'pitch', 'plc', 'quant_bands', 'rate', 'vq'];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const libc = path.join(here, '../libopus11');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'celt011-'));
function checkout(given, name, url, commit, tag) {
  const dir = given || path.join(tmp, name);
  if (!given) {
    run('git', ['clone', '--quiet', ...(tag ? ['--depth', '1', '--branch', tag] : []), url, dir]);
    if (!tag) run('git', ['-C', dir, 'checkout', '--quiet', commit]);
  }
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
  if (head !== commit) throw new Error(`Expected ${name} at ${commit}, found ${head}`);
  return dir;
}
const src = checkout(process.argv[2], 'celt', 'https://github.com/mumble-voip/celt-0.11.0.git', COMMIT);
const musl = checkout(process.argv[3], 'musl', 'https://git.musl-libc.org/git/musl', MUSL_COMMIT, MUSL_TAG);

const sources = [...SOURCES.map(s => path.join(src, 'libcelt', `${s}.c`)), path.join(libc, 'libc.c'), path.join(here, 'api.c')];
const cflags = ['--target=wasm32', '-O2', '-nostdlibinc', '-isystem', path.join(libc, 'include'), `-I${path.join(src, 'libcelt')}`,
  '-DCUSTOM_MODES', '-DVAR_ARRAYS', '-DHAVE_LRINTF', '-ffp-contract=off', '-w'];
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
const exports = ['cc_mode_create', 'cc_mode_overlap', 'celt_mode_destroy', 'cc_encoder_create', 'cc_encoder_set',
  'celt_encoder_destroy', 'celt_encode_float', 'cc_decoder_create', 'celt_decoder_destroy', 'celt_decode_float', 'malloc', 'free'];
const wasm = path.join(tmp, 'celt.wasm');
run('wasm-ld', ['--no-entry', '--stack-first', '-z', 'stack-size=1048576', '--gc-sections',
  ...exports.map(e => `--export=${e}`), ...objects, '-o', wasm]);

const bytes = fs.readFileSync(wasm);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => `${i.module}.${i.name}`);
if (imports.length) throw new Error(`Unexpected imports: ${imports.join(', ')}`);
const clang = run('clang', ['--version']).split('\n')[0];
const out = path.join(root, 'vendor/celt-0.11/celt-0.11.wasm.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(src, 'COPYING'), path.join(root, 'vendor/celt-0.11/COPYING.celt'));
fs.writeFileSync(out, `// CELT 0.11 (mumble-voip/celt-0.11.0 ${COMMIT}, custom modes) with musl 1.2.5 libm\n` +
  `// (${MUSL_COMMIT}) as WebAssembly, built by tests/celt011/build.mjs with ${clang}.\n` +
  `export default '${bytes.toString('base64')}';\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${bytes.length} bytes of wasm, ${sources.length + MUSL_MATH.length} sources, no imports`);
