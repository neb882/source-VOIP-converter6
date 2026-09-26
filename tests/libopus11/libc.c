/* The few C library functions libopus needs, for a freestanding WebAssembly build.
 * The allocator keeps freed blocks on a free list for reuse: the app creates and
 * destroys same-sized encoders and decoders for every talk spurt. */
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

extern unsigned char __heap_base;
static unsigned char *heap_top = &__heap_base;
typedef struct Block { size_t size; struct Block *next; } Block;
#define HEADER ((sizeof(Block) + 15) & ~(size_t)15)
static Block *free_list = NULL;

void *malloc(size_t size) {
  size = (size + 15) & ~(size_t)15;
  Block **link = &free_list;
  for (Block *b = free_list; b; link = &b->next, b = b->next) {
    if (b->size >= size && b->size <= 2 * size + 256) { *link = b->next; return (unsigned char *)b + HEADER; }
  }
  unsigned char *start = (unsigned char *)(((size_t)heap_top + 15) & ~(size_t)15);
  unsigned char *end = start + HEADER + size;
  size_t have = __builtin_wasm_memory_size(0) * 65536;
  if ((size_t)end > have) {
    size_t pages = ((size_t)end - have + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
  }
  heap_top = end;
  Block *b = (Block *)start; b->size = size; b->next = NULL;
  return start + HEADER;
}
void free(void *ptr) {
  if (!ptr) return;
  Block *b = (Block *)((unsigned char *)ptr - HEADER);
  b->next = free_list; free_list = b;
}
void *calloc(size_t n, size_t size) {
  void *p = malloc(n * size);
  if (p) memset(p, 0, n * size);
  return p;
}
void *realloc(void *ptr, size_t size) {
  if (!ptr) return malloc(size);
  Block *b = (Block *)((unsigned char *)ptr - HEADER);
  if (b->size >= size) return ptr;
  void *p = malloc(size);
  if (p) { memcpy(p, ptr, b->size); free(ptr); }
  return p;
}
void abort(void) { __builtin_trap(); }

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst; const unsigned char *s = src;
  while (n--) *d++ = *s++;
  return dst;
}
void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = dst; const unsigned char *s = src;
  if (d < s) { while (n--) *d++ = *s++; }
  else { d += n; s += n; while (n--) *--d = *--s; }
  return dst;
}
void *memset(void *dst, int c, size_t n) {
  unsigned char *d = dst;
  while (n--) *d++ = (unsigned char)c;
  return dst;
}
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (; n; n--, x++, y++) if (*x != *y) return *x - *y;
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
