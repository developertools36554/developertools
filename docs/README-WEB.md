# ViralClips Web — use it directly in the browser, no download needed

A static single-page app. Open `index.html` (or the GitHub Pages URL) and cut
clips in your browser. Fully own code.

## What works fully in the browser

- **Upload a video file** (MP4, WebM, MOV). The file never leaves your
  computer — analysis and cutting both happen on your device.
- **Full Cut mode**: the page reads the video's loudness and speech pattern
  with the Web Audio API and scores moments with our own formula
  (speech density 40 + speech onsets / word rate 20 + first-2-seconds
  loudness 10 + hook words 10 + keyword hits 10 + clean start 5 + early
  position 5 = 100). Top moments are picked so they do not overlap by more
  than half. No key needed.
- **Cut using AI mode**: the page sends the ranked moment list (timestamps,
  local scores, hook titles, and your pasted transcript if any) to the AI
  provider you chose — Gemini, OpenAI or Groq — using YOUR OWN key, and the
  AI re-ranks the moments. The key is stored only in your browser
  (localStorage) and is sent only to that provider. If there is no key, the
  page says so plainly and offers Full Cut instead. If the AI call fails,
  it falls back to local scoring and says so.
- **Cutting to 9:16 vertical (720x1280)** in the browser with ffmpeg.wasm
  (loaded from the unpkg CDN when you press Make clips). Hook titles are
  burned in for the first 2.5 seconds; transcript captions are burned in
  when you pasted a transcript. If the caption font cannot load, clips are
  still cut correctly and the page says captions were skipped.
- **Download each clip** as an `.mp4` straight from the page.

## What does NOT work on a static page, and why

- **YouTube / TikTok link download.** A static GitHub Pages site cannot
  download YouTube or TikTok videos directly — the browser blocks it
  (CORS / no server to fetch from). The page tries a public download
  service (Cobalt public API) first. If that returns a file the browser
  can fetch, the file goes into the same pipeline. If it fails, the page
  shows an honest message: download the video yourself and upload the
  file instead — that path works fully in the browser. Nothing is faked:
  if the link cannot be fetched, the page says so.
- **Automatic transcription.** The Web Speech API listens through the
  microphone, not through a video file, so a static page cannot reliably
  transcribe a file by itself. The page offers an experimental
  listen-while-playing button (Chrome/Edge only), but the reliable way is
  to paste a transcript in the optional box. Without a transcript, clips
  are scored from loudness and speech only, and that still works.
- **ffmpeg.wasm needs the CDN.** The cutter loads from unpkg when you press
  Make clips. If the CDN is blocked or you are offline, the page shows a
  clear error instead of a blank page — analysis and scoring still work,
  only cutting waits on the cutter loading.

## Honest limits

- No score can guarantee a clip will go viral. The score only ranks the
  moments most likely to hold a stranger's attention.
- Only clip videos you made yourself, or videos you have permission to use.
- AI mode costs whatever your own AI provider charges for your key; the
  page itself charges nothing and sends nothing anywhere else.

## Files

- `index.html` — the whole page (landing + app)
- `app.js` — all logic: audio analysis, scoring, AI calls, link attempt, ffmpeg.wasm cutting
- `style.css` — styling
- `README-WEB.md` — this file

No build step. No server. No dependencies to install.

## Enable GitHub Pages

1. In the repo, copy this `web/` folder to `docs/` at the repo root
   (GitHub Pages serves the `docs/` folder).
2. GitHub repo → Settings → Pages → Build and deployment → Source:
   **Deploy from a branch** → Branch: `main`, Folder: `/docs` → Save.
3. The site goes live at `https://developertools36554.github.io/developertools/`
   (replace with the real repo owner/name if different).

## Testing done

- `node --check app.js` — syntax valid.
- HTML checked with Python's html.parser — parses cleanly, all element
  IDs referenced in `app.js` exist in `index.html` (checked by script).
- ffmpeg.wasm cutting and the AI calls were NOT tested end-to-end here:
  they need a real browser with network access to the CDN and to an AI
  provider. Still to prove in a real browser: load the page, upload a
  short video, analyse in both modes, press Make clips, download a clip
  and check it is 720x1280 with the right duration.
