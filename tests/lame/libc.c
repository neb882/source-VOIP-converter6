/* The rest of the C library LAME's encoder links against, for a freestanding
 * WebAssembly build; allocation and memory functions come from
 * ../libopus11/libc.c. Printing goes nowhere (api.c sets no-op report
 * callbacks), and ID3 tags, the only users of sprintf, are never written. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>

FILE *const stdout = 0, *const stderr = 0;
int vfprintf(FILE *restrict f, const char *restrict format, va_list ap) { (void)f; (void)format; (void)ap; return 0; }
int fflush(FILE *f) { (void)f; return 0; }
int sprintf(char *restrict s, const char *restrict format, ...) { (void)format; s[0] = 0; return 0; }
_Noreturn void exit(int code) { (void)code; __builtin_trap(); }

int tolower(int c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; }
char *strncpy(char *restrict d, const char *restrict s, size_t n) {
  size_t i = 0;
  for (; i < n && s[i]; i++) d[i] = s[i];
  for (; i < n; i++) d[i] = 0;
  return d;
}

/* Insertion sort: LAME sorts one scalefactor band at a time (at most 192
 * floats), and equal floats are interchangeable, so the result is exact. */
void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *)) {
  unsigned char *a = base, tmp[16];
  if (size > sizeof tmp) __builtin_trap();
  for (size_t i = 1; i < n; i++) {
    memcpy(tmp, a + i * size, size);
    size_t j = i;
    for (; j > 0 && cmp(a + (j - 1) * size, tmp) > 0; j--) memcpy(a + j * size, a + (j - 1) * size, size);
    memcpy(a + j * size, tmp, size);
  }
}
