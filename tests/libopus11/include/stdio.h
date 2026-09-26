/* libopus only prints from debug and assertion code, which this build leaves out. */
#ifndef OC_STDIO_H
#define OC_STDIO_H
typedef struct OC_FILE FILE;
extern FILE *stderr;
int fprintf(FILE *stream, const char *format, ...);
int printf(const char *format, ...);
#endif
