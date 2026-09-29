# voice_loopback 1: narration

The narration's source text. `scripts/export-azure.mjs` turns it into `azure.txt`, the paste-ready text for Azure Speech Studio, without the markup below.

- `## id: title` starts a chapter. The id is the plate that carries it (`docs/TREATMENT.md`).
- `{{cue …}}text{{/cue}}` marks words the soundtrack plays through the emulator (`audio/mix.mjs`), with the settings named in the cue. The narrator reads them normally; the processing happens in the mix.
- `{{insert …}}` places a sound that is not the narrator, such as a test tone.
- `<!-- … -->` is a note for the edit, not spoken.

Numbers are written as they should be spoken. Every fact is in `docs/DETAILS.md` with its source in the repository.

## open: Voice loopback

In Team Fortress 2, there is a console command that lets you hear yourself the way everyone else does.

Voice loopback, one.

{{cue loopback}}And this is what comes back. A little late. A little crushed. Unmistakable.{{/cue}}

This project set out to make any sound come back exactly like that. Not roughly. Exactly: to a fraction of a decibel, measured against the real thing.

## signal: The test signal

You can't measure a voice with a voice. So the work began with a signal built for measuring. Sine tones climbing in six-decibel steps. Bursts of noise. A sweep from twenty hertz to twenty kilohertz. Clicks. And a synthetic vowel. A hundred and forty-three seconds, played into the game as if it were a microphone, and recorded coming out the other side.

## gate: The gate

The first thing Steam decides is whether you're talking at all. It cuts your voice into frames of twenty milliseconds, and a frame quieter than minus thirty-nine and a half decibels is never sent. {{cue gate quiet=-32}}So if I say this quietly,{{/cue}} nothing arrives.

When a frame does cross the line, Steam sends it along with the six frames before it: a hundred and twenty milliseconds from before you started to speak. And it holds the gate open for four hundred and forty milliseconds after you stop.

## codec: The codec

Then comes Opus. Twenty-four kilohertz, thirty-two kilobits a second, fifty frames every second.

Which Opus? Every release from one point one to one point six was built and given the same signal to encode. Only the one point one family makes Steam's decisions: it goes silent on six hundred and twenty-seven of the six hundred and ninety-three frames where Steam did. Later releases manage fewer than a hundred. So that is the release the emulator runs, compiled to WebAssembly.

Opus has one habit you can hear. Hold a steady tone, {{insert dtx}} and after about four tenths of a second it decides you've stopped. It sends a single byte, and the listener hears comfort noise instead of you.

## packets: The packets

To see exactly what Steam sends, a Source TV demo recorded every packet as the server received it. Five thousand one hundred and nine frames, in twenty talk spurts. Six hundred and ninety-three of them were that single byte.

## receiver: The receiver

On the listener's side, the game turns you up or down a hundred and twenty-eight samples at a time, blending how loud you are on average with how loud you peak. Voice scale enters that arithmetic twice. {{cue clamp scale=2}}Set it to two, and every peak slams into the ceiling.{{/cue}}

That ceiling is sixteen-bit full scale, times your volume setting. At volume point one five, it's minus sixteen and a half decibels. Anything louder is flattened.

## gap: The gap

One more thing. After every sentence, the sender adds sixty-two and a half milliseconds of silence. {{cue gap}}If your next words arrive while your last ones are still waiting to be played, the game doesn't wait. It appends you.{{/cue}} The pause disappears.

## result: The result

Put together, the emulator follows a real recording to within about four tenths of a decibel, fifty milliseconds at a time. Given Steam's own packets, it tracks the listener to within a seventh of a decibel.

It runs in a browser. Live, through your microphone. On a video, without touching the picture. On a demo, straight from Steam's packets.

## predict: The prediction

A model fitted to its data should match that data. The harder test is data it has never seen. So six recordings that nobody has made yet were predicted in advance, and the predictions were sealed with a hash.

Two old codecs. Twice the voice scale. A different gain law. A lower cap on the gain. And full volume. When they're recorded, the model will be right, or it will be wrong, in public.

{{cue loopback}}Voice loopback, one.{{/cue}}
