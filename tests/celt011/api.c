/* Entry points for JavaScript: CELT's ctl calls take varargs, which a
 * WebAssembly caller cannot pass, and its create calls report errors
 * through a pointer. Mono only, as Source's vaudio_celt. */
#include "celt.h"
#include "modes.h"

CELTMode *cc_mode_create(int rate, int frame) {
  int error = 0;
  CELTMode *mode = celt_mode_create(rate, frame, &error);
  return error == CELT_OK ? mode : 0;
}
/* The codec's delay in samples: the MDCT window overlap. */
int cc_mode_overlap(const CELTMode *mode) { return mode->overlap; }
CELTEncoder *cc_encoder_create(const CELTMode *mode) {
  int error = 0;
  CELTEncoder *st = celt_encoder_create_custom(mode, 1, &error);
  return error == CELT_OK ? st : 0;
}
int cc_encoder_set(CELTEncoder *st, int request, int value) { return celt_encoder_ctl(st, request, value); }
CELTDecoder *cc_decoder_create(const CELTMode *mode) {
  int error = 0;
  CELTDecoder *st = celt_decoder_create_custom(mode, 1, &error);
  return error == CELT_OK ? st : 0;
}
