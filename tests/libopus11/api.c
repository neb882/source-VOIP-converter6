/* Non-variadic entry points for JavaScript: opus_*_ctl take varargs, which a
 * WebAssembly caller cannot pass directly. */
#include "opus.h"

int oc_encoder_set(OpusEncoder *st, int request, int value) { return opus_encoder_ctl(st, request, value); }
int oc_encoder_get(OpusEncoder *st, int request) {
  opus_int32 value = 0;
  int err = opus_encoder_ctl(st, request, &value);
  return err == OPUS_OK ? value : err;
}
int oc_decoder_set(OpusDecoder *st, int request, int value) { return opus_decoder_ctl(st, request, value); }
