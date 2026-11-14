# REST IN PUMP trailer

A 95-second, 1920x1080, 30 fps trailer rendered from the real game scene (H.264 video, 48 kHz stereo AAC, about -15 LUFS).

## What is where

| Path | What |
|---|---|
| `../client/src/film/film.ts` | The trailer itself: the timeline, owl choreography, camera shots, titles, letterbox, NFT card, revenue flow, end card. Runs in the game at `/?film`. |
| `../client/src/film/script.ts` | Narration lines: start time, mood, on-screen wording, and the wording sent to the voice. |
| `render.mjs` | Renders frame by frame through Playwright and FFmpeg, builds the soundtrack, muxes the MP4. |
| `mix.js` | The soundtrack, built offline in the page with Web Audio: music placement, sound effects, narration, ducking. |
| `voice-local.mjs` | Generates the narration on this machine with Kokoro (free, open source, no account) into `voice/`. Used for the current cut. |
| `voice.mjs` | The same with ElevenLabs instead (needs `ELEVENLABS_API_KEY` in `trailer/.env`), for a more expressive read later. |
| `voice/` | Narration MP3s, one per line (`01.mp3` ... `21.mp3`). |
| `out/` | Renders (git-ignored): `REST-IN-PUMP-Trailer.mp4`, its silent video, its WAV, stills, section renders. |

## Render it again

```bash
cd trailer
npm install
npx playwright install chromium
node voice-local.mjs           # narration with Kokoro (first run downloads its ~90 MB model)
node render.mjs                # full trailer -> out/REST-IN-PUMP-Trailer.mp4 (about 8 minutes)
```

Faster loops while editing:

```bash
node render.mjs --from 20 --to 34          # one section, with sound
node render.mjs --stills 5,13,27,64        # single frames
node render.mjs --audio-only               # re-mix sound onto the last full video
node voice-local.mjs --only 07             # redo one narration line
node voice-local.mjs --voice bm_george     # try another Kokoro voice (default am_michael)
```

`render.mjs` builds the client, starts its own game server on port 8797 with an in-memory database (no real graves, payments or wallets are touched), and opens `/?film&capture` in headless Chromium. Each frame is stepped by the film's clock, so the result is smooth whatever the machine's speed. On Windows setups that block `chrome.exe`, it uses Playwright's headless shell build; `CHROMIUM_PATH` can point it at another browser.

To change the story, edit `film.ts` (events in `setup()`, cameras in `shot()`, text in `overlay()`) and the narration timing in `script.ts`. Both voice scripts report any line that would overlap the next one.

A recorded voice (yours or a voice actor's) can replace the generated one: save each line as `voice/01.mp3` ... `voice/21.mp3` and run `node render.mjs --audio-only`.

## Audio sources and licensing

| Part | Source |
|---|---|
| Opening organ theme (`theme.mp3`) and bouncy track (`dance.mp3`) | The game's own music in `client/public/audio`, supplied by the project team |
| Owl crying (`cry.mp3`) | The game's own sound |
| Wind, hope build, riser, crow, steps, chimes, candle, pops, boing, record scratch, whooshes, impacts, UI clicks, bell, level-up fanfare, coins, ending chord | Original, synthesized in `mix.js` for this trailer |
| Narration | Kokoro-82M text to speech (voice `am_michael`), Apache 2.0 licence, generated locally; commercial use allowed. Optional: ElevenLabs via `voice.mjs`, covered by that account's plan terms |

No commercial songs or stock clips are used.

## What is staged

Everything in the trailer is in-engine footage of the real game (world, owls, emotes, graves, gift items, level designs, the real "Dig a grave" dialog with the real coin search and NFT preview, and the real Memorial NFT artwork). The owls and graves are placed by the timeline, not by live players, and the gameplay montage says "In-engine footage · staged". No payment is made: the dialog stops at its "Connect wallet & bury it" step.
