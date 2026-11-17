# ViralClips AI server — queue + worker contract

Local files only. **Do NOT deploy from here** — deployment to
`apiurl.online` is a separate step. Copy this whole `server/` folder to
`viralclips/api/` on the server so the endpoints are:

- `POST https://apiurl.online/viralclips/api/analyse.php`
- `GET  https://apiurl.online/viralclips/api/result.php?id=<request id>`

The web page's endpoint is a single constant in `web/app.js`
(`MUSE_API_BASE`); change it there if the server moves. No secrets and
no keys live anywhere in this code — the worker (Muse) is the one who
analyses; the user never supplies a key.

## How a request flows

1. The page computes analysis data **in the browser** (loudness,
   speech spans, transcript, local moments) and POSTs it as JSON to
   `analyse.php`. **No video bytes are ever sent.** The POST body is:

```json
{
  "id": "client-generated request id, e.g. a UUID",
  "mode": "ai",
  "duration": 90.01,
  "file_name": "my-video",
  "speech_spans": [{"start": 0.5, "end": 4.25}],
  "loudness_buckets": [0.0, 0.42, 0.91],
  "bucket_sec": 0.25,
  "transcript": "optional pasted transcript text",
  "clip_count": 3,
  "clip_len": 30,
  "local_moments": [{"start": 0, "end": 30, "score": 46, "title": "...", "reason": "..."}]
}
```

2. `analyse.php` validates everything (see limits below), stores the
   request as `queue/<id>.json` with `"status": "queued"`, and returns
   `{"ok": true, "id": "...", "status": "queued"}`. Validation failures
   return `{"ok": false, "error": "<code>"}` with HTTP 400/405/413.
3. The page polls `result.php?id=<id>` every 10 seconds and shows
   "Muse is analysing your video..." while it waits.
4. The worker reads the queued request, analyses it, and writes
   `queue/<id>.result.json`. The next poll then returns the result.
5. The page validates the moments, shows the ranked clips, and cuts
   them with ffmpeg.wasm exactly as Full Cut does.

## Queue file format

`queue/<id>.json` (written by `analyse.php`):

```json
{
  "id": "...",
  "status": "queued",
  "created_at": "2026-11-17T21:00:00+00:00",
  "request": { "mode": "ai", "duration": 90.01, "file_name": "...",
    "speech_spans": [{"start": 0.5, "end": 4.25}],
    "loudness_buckets": [0.0, 0.42, 0.91], "bucket_sec": 0.25,
    "transcript": "...", "clip_count": 3, "clip_len": 30,
    "local_moments": [{"start": 0, "end": 30, "score": 46, "title": "...", "reason": "..."}] }
}
```

`queue/<id>.result.json` (written by the worker):

```json
{
  "status": "done",
  "id": "...",
  "moments": [
    {"start_sec": 12.5, "end_sec": 42.5, "score": 88,
     "title": "Short hook title", "reason": "One short sentence."}
  ]
}
```

On failure the worker writes `{"status": "error", "id": "...",
"error": "short human-readable reason"}` instead.

## Validation limits (enforced by analyse.php)

- `id`: `^[A-Za-z0-9][A-Za-z0-9-]{7,63}$` — this also blocks path
  traversal, since the id is used as a file name.
- `mode`: must be `"ai"`.
- `duration`: 1–14400 seconds.
- `clip_count`: 1–10. `clip_len`: 30, 45 or 60.
- `speech_spans`: at most 10000 spans, each `0 <= start < end <= duration`.
- `loudness_buckets`: at most 20000 numbers, each clamped to 0–1.
- `transcript`: plain text, HTML tags stripped, at most 20000 chars.
- `local_moments`: at most 50, each inside the video, score clamped 0–100.
- Whole POST body: at most 2,000,000 bytes.

## Processing contract for the worker (Muse)

The worker picks up each `queue/<id>.json` whose `"status"` is
`"queued"`. For each one:

1. Read the request. Judge the moments from **only** the data given:
   the transcript (words, questions, hook words, numbers, surprising
   or emotional lines), the speech spans (where people are actually
   talking), the loudness buckets (energy peaks, especially in the
   first 2 seconds of a candidate moment), and the local moments
   (the page's own scores — use them as a starting point, re-rank
   them, do not just copy them). Never invent words, quotes or events
   that are not in the transcript or the local moments.
2. Pick `clip_count` moments. Prefer strong hooks, questions,
   surprising or emotional moments, and clear punchy lines — the
   moments most likely to hold a stranger's attention in the first
   2 seconds.
3. Rules for the moments you return:
   - `start_sec` / `end_sec` must be inside the video
     (`0 <= start_sec < end_sec <= duration`).
   - Each moment must be at most `clip_len` seconds long and at
     least 5 seconds long.
   - `score` is an integer 0–100.
   - `title` is a short hook title (at most 80 characters).
   - `reason` is one short sentence saying why this moment was picked.
   - Moments must not overlap each other by more than half their length.
4. Write `queue/<id>.result.json` atomically (write a temp file in
   the same directory, then rename it over the result file) with
   `{"status": "done", "id": "<id>", "moments": [...]}`. On any
   failure, write `{"status": "error", "id": "<id>", "error": "..."}`.
   Do not delete the request file.
5. If a request is older than 1 hour and still queued, treat it as
   stale: write an error result (`"error": "analysis timed out"`)
   so the page stops polling it.

## Link downloads (download.php)

The page cannot download YouTube/TikTok links by itself: the public
download service it used to call now needs an API key, and YouTube is
disabled on that service's main instance. So links go through our own
server instead:

- `POST https://apiurl.online/viralclips/api/download.php` with
  `{"id": "<request id>", "url": "<YouTube or TikTok link>"}`.
  Only YouTube (`youtube.com`, `youtu.be`) and TikTok (`tiktok.com`)
  hosts are accepted. The endpoint validates the id and URL and
  stores `queue/<id>.json` with
  `{"status": "queued", "request": {"kind": "download", "url": "..."}}`.
  It returns `{"ok": true, "id": "...", "status": "queued"}`.
- The page polls `result.php?id=<id>` (same endpoint as AI results).
  A done download result is
  `{"status": "done", "id": "...", "url": "<direct video URL>",
    "title": "...", "duration": <seconds>}` — `result.php` passes
  `url`/`title`/`duration` through only when the worker wrote them.
  An error result is `{"status": "error", "id": "...", "error": "..."}`.
- The page then fetches the direct URL itself (from the user's own
  connection) and loads the file for analysis/cutting, exactly as if
  the user had uploaded it. No video bytes ever pass through our server.

### Download worker contract (Muse)

The worker picks up each `queue/<id>.json` whose request has
`"kind": "download"` and no `<id>.result.json` yet:

1. Run yt-dlp on this VM (binary `~/tools/yt-dlp`, Node is the JS
   runtime — pass `--js-runtimes node`):
   `yt-dlp --js-runtimes node --no-playlist --get-url --get-title --get-duration --format "best[height<=720][ext=mp4][vcodec^=h264]/best[ext=mp4][vcodec^=h264]/best[ext=mp4]/best" "<url>"`
   with a 120-second timeout. Do NOT download the video — only resolve
   the direct URL. Parse the output robustly: the URL is the line
   starting with `http`, the duration is the `M:SS` / `H:M:SS` line,
   the title is the remaining line.
2. If the duration is over 1800 seconds (30 minutes), write an error
   result (`"error": "video is too long (max 30 minutes)"`) — the
   in-browser cutter cannot handle longer videos.
3. On success write `queue/<id>.result.json` atomically with
   `{"status": "done", "id": "<id>", "url": "<direct URL>",
     "title": "<title>", "duration": <seconds>}`. On any failure write
   `{"status": "error", "id": "<id>", "error": "<short reason>"}`.
   Do not delete the request file.
4. If a download request is older than 1 hour and still queued, treat
   it as stale: write an error result (`"error": "download timed out"`).

Proven 2026-11-17: yt-dlp on this VM resolves both YouTube
(`aqz-KE-bpKQ` → googlevideo URL) and TikTok (`@my.petsie` video →
tiktokcdn URL) with this format selector, and a direct URL fetched
from a DIFFERENT IP/network (Darren's laptop) returns HTTP 206 with
real bytes — so the browser can fetch the resolved URL itself.

## Deployment (separate step, not done from here)

1. Copy `analyse.php`, `result.php` and the `queue/` folder to
   `viralclips/api/` on apiurl.online (keep `queue/.htaccess` — it
   blocks browsers from fetching queued requests directly).
2. Make `queue/` writable by PHP (e.g. `chmod 755`, owned by the web
   user). No database is needed. PHP 7.4+ is enough.
3. Check `POST https://apiurl.online/viralclips/api/analyse.php`
   with a small test JSON returns `{"ok": true, ...}`, and that
   `GET result.php?id=<that id>` returns `{"status": "queued", ...}`.
4. Start the worker (Muse) against the queue. Until the worker is
   running, Cut using AI will show the page's honest message that
   the AI server is not live yet, and Full Cut keeps working fully
   in the browser.

## Security notes

- The request id is the only user-controlled part of a file name, and
  it is restricted to letters, digits and `-` — no `/`, no `..`.
- No file uploads are accepted: the endpoints read JSON only.
- CORS is open (`Access-Control-Allow-Origin: *`) so the GitHub Pages
  site can call the API from any origin. That is deliberate: the API
  takes no secrets, so there is nothing to steal — but keep the queue
  directory blocked from direct web access (`.htaccess`).
- Requests are small analysis summaries, not video. Do not add a video
  upload to these endpoints.
