# Making the narration in Azure Speech Studio

The same route as pantheon-continuation1's audiobook: paste the text, pick a neural voice, export the audio.

## Text

Paste all of [`azure.txt`](azure.txt). It is generated from [`script.md`](script.md) by `node scripts/export-azure.mjs`, so edit the script, not the text file.

Some things are spelled for the voice rather than for the page: "Voice loopback, one", "Source TV", and the numbers written out. The film sets them properly on screen.

## Voice

A calm, dry documentary read, unhurried but not slow. Voices worth trying first:
- **en-US-AndrewMultilingualNeural:** warm and even.
- **en-US-BrianMultilingualNeural:** drier.
- **en-GB-RyanNeural:** British and precise.

Pick whichever sounds most like someone explaining a measurement they're quietly proud of. Keep the default speed, or at most −5%. The film is timed to the narration, so any pace works, but a rushed read makes the numbers hard to follow.

## Export

- **Format:** WAV, 24 kHz, 16-bit, mono (Riff24Khz16BitMonoPcm, or whatever your export dialog calls 24 kHz mono PCM). 24 kHz is Steam's own voice codec rate, so the emulator uses the narration as it is, with no resampling.
- **Files:** one file for the whole narration is simplest. One file per chapter also works: name them `00-open.wav` … `08-predict.wav` in script order.

## Checking a take

1. **Every word is clear.** The film syncs its type word by word.
2. **No words are changed or skipped.** If the voice reads a number oddly, respell it in `script.md`, re-export, and regenerate that paragraph.
3. **Chapter ends have a pause.** The plates cut there. Azure's default paragraph pause is enough.

## What to send back

The WAV file(s). Attach them in the session or commit them to `film/audio/narration/`. They are the one ingredient the film can't make itself; everything else (processing, score, mix, pictures) is generated from them and from the repository.
