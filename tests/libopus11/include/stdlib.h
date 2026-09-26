/* Minimal freestanding libc for the libopus 1.1 WebAssembly build (see ../libc.c). */
#ifndef OC_STDLIB_H
#define OC_STDLIB_H
#include <stddef.h>
void *malloc(size_t size);
void *calloc(size_t n, size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
void abort(void) __attribute__((noreturn));
static inline int abs(int x) { return x < 0 ? -x : x; }
#endif
