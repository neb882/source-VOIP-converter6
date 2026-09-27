/* config.h for the LAME 3.100 WebAssembly build (see build.mjs): what
 * ./configure detects on a C99 system, without the x86 SIMD and host I/O
 * options. TAKEHIRO_IEEE754_HACK and USE_FAST_LOG are configure's defaults. */
#define STDC_HEADERS 1
#define HAVE_MEMCPY 1
#define HAVE_STRCHR 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_ERRNO_H 1
#define HAVE_INT8_T 1
#define HAVE_INT16_T 1
#define HAVE_INT32_T 1
#define HAVE_INT64_T 1
#define HAVE_UINT8_T 1
#define HAVE_UINT16_T 1
#define HAVE_UINT32_T 1
#define HAVE_UINT64_T 1
typedef float ieee754_float32_t;
typedef double ieee754_float64_t;
#define TAKEHIRO_IEEE754_HACK 1
#define USE_FAST_LOG 1
#define LAME_LIBRARY_BUILD 1
#define PACKAGE "lame"
#define PACKAGE_VERSION "3.100"
#define VERSION "3.100"
