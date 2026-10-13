# Test fixtures

`fixtures/media/` is generated, not committed. Run:

```bash
pnpm fixtures          # skip files that already exist
pnpm fixtures --force  # regenerate everything
```

All media is synthesized by ffmpeg from its built-in `lavfi` sources (test
patterns, color bars, a Mandelbrot zoom, sine tones). It contains no third-party
content and is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

| File             | Contents                                                                 | Used by                    |
| ---------------- | ------------------------------------------------------------------------ | -------------------------- |
| `testsrc-5s.mp4` | 640×360 test pattern, 30 fps, 440 Hz tone, H.264/AAC                     | general editing + export   |
| `beeps-12s.mp4`  | SMPTE bars; audio alternates 2 s tone / 1 s silence                      | `detect_silence`, waveform |
| `scenes-6s.mp4`  | three 2 s shots (test pattern, Mandelbrot, HD bars), cuts at 2 s and 4 s | `detect_scenes`            |
| `tone-3s.wav`    | 3 s 523 Hz tone, PCM                                                     | audio tracks               |
| `still.png`      | single test-pattern frame                                                | image clips                |

Speech fixtures for transcription are not generated (there is no free,
license-clean speech synthesizer available in every environment); the
transcript tests use a fake transcriber, and real Whisper runs are verified
manually.
