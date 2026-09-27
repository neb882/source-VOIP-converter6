/* One call that sets up a mono encoder for JavaScript. kbps > 0 selects CBR
 * at that bitrate; otherwise VBR at quality vbrQuality (0 = best, as lame -V 0).
 * Messages go nowhere: the defaults print to stderr, which this build lacks. */
#include "lame.h"

static void quiet(const char *format, va_list ap) { (void)format; (void)ap; }

lame_t tf2_mp3_create(int sampleRate, int kbps, int vbrQuality) {
  lame_t g = lame_init();
  if (!g) return 0;
  lame_set_errorf(g, quiet);
  lame_set_debugf(g, quiet);
  lame_set_msgf(g, quiet);
  lame_set_num_channels(g, 1);
  lame_set_mode(g, MONO);
  lame_set_in_samplerate(g, sampleRate);
  lame_set_out_samplerate(g, sampleRate);
  if (kbps > 0) {
    lame_set_VBR(g, vbr_off);
    lame_set_brate(g, kbps);
  } else {
    lame_set_VBR(g, vbr_default);
    lame_set_VBR_quality(g, (float)vbrQuality);
  }
  if (lame_init_params(g) < 0) { lame_close(g); return 0; }
  return g;
}
