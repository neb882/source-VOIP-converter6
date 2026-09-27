// Build the LAME 3.100 MP3 encoder to WebAssembly for the MP3 download option.
//
//   node tests/lame/build.mjs [lame-3.100.tar.gz] [musl-1.2.5-checkout]
//
// Needs curl, tar, git, clang with the wasm32 target, and wasm-ld; no
// Emscripten. Same approach as tests/libopus11/build.mjs: the release sources
// unchanged, musl's headers and the libm functions LAME calls compiled in, so
// the module has no imports. The release tarball is checked against its
// SHA-256; inputs not given are downloaded. Writes vendor/lame/lame-3.100.wasm.mjs.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz';
const SHA256 = 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e';
const MUSL_TAG = 'v1.2.5', MUSL_COMMIT = '0784374d561435f7c787a555aeab8ede699ed298';
// libmp3lame's sources (libmp3lame/Makefile.am); mpglib_interface.c is empty
// without the decoder.
const SOURCES = ['VbrTag', 'bitstream', 'encoder', 'fft', 'gain_analysis', 'id3tag', 'lame', 'newmdct', 'presets',
  'psymodel', 'quantize', 'quantize_pvt', 'reservoir', 'set_get', 'tables', 'takehiro', 'util', 'vbrquantize',
  'version', 'mpglib_interface'];
// musl's math functions that LAME calls, and their helpers.
const MUSL_MATH = ['exp', 'exp_data', 'exp2', 'log', 'log_data', 'log10', 'pow', 'pow_data', 'cos', 'sin', '__cos',
  '__sin', '__rem_pio2', '__rem_pio2_large', 'atan', '__math_oflow', '__math_uflow', '__math_xflow',
  '__math_invalid', '__math_divzero', 'scalbn', 'floor', 'fabs', 'powf', 'powf_data', 'exp2f_data',
  '__math_oflowf', '__math_uflowf', '__math_xflowf', '__math_invalidf', '__math_divzerof', 'log10f'];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lame-'));
const tarball = process.argv[2] || path.join(tmp, 'lame-3.100.tar.gz');
if (!process.argv[2]) run('curl', ['-sSfL', '-o', tarball, URL]);
const hash = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
if (hash !== SHA256) throw new Error(`Expected lame-3.100.tar.gz with SHA-256 ${SHA256}, found ${hash}`);
run('tar', ['xzf', tarball, '-C', tmp]);
const src = path.join(tmp, 'lame-3.100');

let musl = process.argv[3];
if (!musl) {
  musl = path.join(tmp, 'musl');
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', MUSL_TAG, 'https://git.musl-libc.org/git/musl', musl]);
}
const head = run('git', ['-C', musl, 'rev-parse', 'HEAD']).trim();
if (head !== MUSL_COMMIT) throw new Error(`Expected musl ${MUSL_TAG} at ${MUSL_COMMIT}, found ${head}`);

// musl's own headers, with arm's 32-bit type definitions (ILP32, FLT_EVAL_METHOD 0).
const bits = path.join(tmp, 'musl-bits/bits');
fs.mkdirSync(bits, { recursive: true });
fs.writeFileSync(path.join(bits, 'alltypes.h'), run('sed', ['-f', path.join(musl, 'tools/mkalltypes.sed'),
  path.join(musl, 'arch/arm/bits/alltypes.h.in'), path.join(musl, 'include/alltypes.h.in')]));
const muslInclude = [...['arch/arm', 'arch/generic'].map(d => `-I${path.join(musl, d)}`), `-I${path.dirname(bits)}`];
const lameFlags = ['--target=wasm32', '-O2', '-nostdinc', '-isystem', path.join(run('clang', ['-print-resource-dir']).trim(), 'include'),
  ...muslInclude, `-I${path.join(musl, 'include')}`, `-I${here}`, `-I${path.join(src, 'include')}`, `-I${path.join(src, 'libmp3lame')}`,
  '-DHAVE_CONFIG_H', '-DNDEBUG', '-ffp-contract=off', '-w'];
const objects = [];
const compile = (flags, file, name) => {
  const o = path.join(tmp, `${name}.o`);
  run('clang', [...flags, '-c', file, '-o', o]);
  objects.push(o);
};
for (const s of SOURCES) compile(lameFlags, path.join(src, 'libmp3lame', `${s}.c`), s);
compile(lameFlags, path.join(here, 'api.c'), 'api');
compile(lameFlags, path.join(here, 'libc.c'), 'libc');
compile(['--target=wasm32', '-O2', '-nostdlibinc', '-isystem', path.join(here, '../libopus11/include'), '-w'],
  path.join(here, '../libopus11/libc.c'), 'libc_alloc');
const muslFlags = ['--target=wasm32', '-O2', '-nostdinc', '-ffreestanding', '-std=c99', '-D_XOPEN_SOURCE=700', '-w',
  ...muslInclude, ...['src/include', 'src/internal', 'include'].map(d => `-I${path.join(musl, d)}`)];
for (const f of MUSL_MATH) compile(muslFlags, path.join(musl, 'src/math', `${f}.c`), `musl_${f}`);

const exports = ['tf2_mp3_create', 'lame_encode_buffer', 'lame_encode_flush', 'lame_get_lametag_frame', 'lame_close',
  'get_lame_version', 'malloc', 'free'];
const wasm = path.join(tmp, 'lame.wasm');
run('wasm-ld', ['--no-entry', '--stack-first', '-z', 'stack-size=1048576',
  ...exports.map(e => `--export=${e}`), ...objects, '-o', wasm]);

const bytes = fs.readFileSync(wasm);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => `${i.module}.${i.name}`);
if (imports.length) throw new Error(`Unexpected imports: ${imports.join(', ')}`);
const clang = run('clang', ['--version']).split('\n')[0];
const out = path.join(root, 'vendor/lame/lame-3.100.wasm.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `// LAME 3.100 (lame-3.100.tar.gz, SHA-256 ${SHA256})\n` +
  `// with musl 1.2.5 libm (${MUSL_COMMIT}) as WebAssembly,\n` +
  `// built by tests/lame/build.mjs with ${clang}.\n` +
  `export default '${bytes.toString('base64')}';\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${bytes.length} bytes of wasm, ${objects.length} objects, no imports; ` +
  `SHA-256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
