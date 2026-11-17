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
- **Cut using AI mode — no key needed from you**: the page computes
  analysis data in your browser (loudness buckets, speech spans, your
  pasted transcript if any, and the local ranked moments) and POSTs
  only that data — never any video bytes — to our own server
  (`https://apiurl.online/viralclips/api/analyse.php`, one constant
  at the top of `app.js`). Muse analyses the request there. The page
  then polls `result.php?id=...` every 10 seconds and shows "Muse is
  analysing your video..." until the ranked moments come back, and
  cuts them exactly like Full Cut. If the server is not live yet, the
  page says so plainly ("AI analysis server is not live yet — use
  Full Cut for now") and falls back to Full Cut local scoring. If
  Muse's analysis fails or takes too long (5 minutes), it also falls
  back to Full Cut and says so. Nothing is ever faked.
- **Cutting to 9:16 vertical (720x1280)** in the browser with ffmpeg.wasm
  (loaded from the unpkg CDN when you press Make clips). Hook titles are
  burned in for the first 2.5 seconds; transcript captions are burned in
  when you pasted a transcript. If the caption font cannot load, clips are
  still cut correctly and the page says captions were skipped.
- **Download each clip** as an `.mp4` straight from the page.

## What does NOT work on a static page, and why

- **YouTube / TikTok link download.** A static GitHub Pages site cannot
  download YouTube or TikTok videos directly — the browser blocks it
  (CORS / no server to fetch from). So the page sends the link to our
  own server (`POST apiurl.online/viralclips/api/download.php`), where
  the worker resolves it to a direct video URL with yt-dlp (YouTube
  and TikTok both work; videos up to 30 minutes). The page then fetches
  that direct URL itself, from the user's own connection, and the file
  goes into the same pipeline. If any step fails, the page shows an
  honest message: download the video yourself and upload the file
  instead — that path works fully in your browser. Nothing is faked:
  if the link cannot be fetched, the page says so. (The public
  download service the page used to call now needs an API key, and
  YouTube is disabled on its main instance — that is why the server
  path exists.)
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
- Cut using AI sends only analysis data to our server (see the AI bullet
  above). Your video file never leaves your computer, and you need no
  key of any kind. Full Cut sends nothing anywhere.

## Files

- `index.html` — the whole page (landing + app)
- `app.js` — all logic: audio analysis, scoring, AI server POST + polling, link attempt, ffmpeg.wasm cutting
- `style.css` — styling
- `README-WEB.md` — this file
- `../server/` — the AI backend (local files only, not deployed yet):
  `analyse.php` (queues requests), `result.php` (returns results),
  `README-SERVER.md` (queue format + the worker contract for Muse)

No build step. Full Cut needs no server at all; Cut using AI uses our
own server (see `../server/`). No dependencies to install.

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
- ffmpeg.wasm cutting was NOT tested end-to-end here: it needs a real
  browser with network access to the CDN. The AI server flow was also
  NOT tested end-to-end: the backend is not deployed yet, so the page
  will show the honest "server is not live yet" message and fall back
  to Full Cut. Still to prove: deploy `server/` to apiurl.online and
  run the worker, then in a real browser load the page, upload a short
  video, analyse in Cut using AI mode, watch the poll return ranked
  moments, press Make clips, download a clip and check it is 720x1280
  with the right duration. Full Cut in a real browser is still to be
  proved the same way.
