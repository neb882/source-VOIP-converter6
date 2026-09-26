/* Math for the libopus 1.1 WebAssembly build. Square root, absolute value,
 * rounding and floor/ceil map to WebAssembly instructions; the transcendental
 * functions are musl's, compiled into the module (see ../build.mjs), so the
 * output is the same in every browser. */
#ifndef OC_MATH_H
#define OC_MATH_H
#define M_PI 3.14159265358979323846
#define HUGE_VAL __builtin_huge_val()
double exp(double x);
double exp2(double x);
double log(double x);
double pow(double x, double y);
double cos(double x);
double sin(double x);
double tan(double x);
double atan(double x);
double atan2(double y, double x);
double log10(double x);
double tanh(double x);
static inline double sqrt(double x) { return __builtin_sqrt(x); }
static inline float sqrtf(float x) { return __builtin_sqrtf(x); }
static inline double fabs(double x) { return __builtin_fabs(x); }
static inline float fabsf(float x) { return __builtin_fabsf(x); }
static inline double floor(double x) { return __builtin_floor(x); }
static inline float floorf(float x) { return __builtin_floorf(x); }
static inline double ceil(double x) { return __builtin_ceil(x); }
static inline float ceilf(float x) { return __builtin_ceilf(x); }
static inline long lrintf(float x) { return (long)__builtin_rintf(x); }
static inline long lrint(double x) { return (long)__builtin_rint(x); }
static inline float expf(float x) { return (float)exp(x); }
static inline float logf(float x) { return (float)log(x); }
static inline float powf(float x, float y) { return (float)pow(x, y); }
static inline float cosf(float x) { return (float)cos(x); }
static inline float sinf(float x) { return (float)sin(x); }
static inline float atanf(float x) { return (float)atan(x); }
static inline float atan2f(float y, float x) { return (float)atan2(y, x); }
static inline float log10f(float x) { return (float)log10(x); }
static inline float tanhf(float x) { return (float)tanh(x); }
#endif
