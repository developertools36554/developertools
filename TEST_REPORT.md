# ViralClips v1 — test report (2026-11-17)

## Deliverable
- ZIP: `~/workspace/viral_clips_app/ViralClips_v1.zip` — 97 MB,
  sha256 `e9dd2e60c4d9ee766f4755184f90ba1197b6d2dfa33474cc1052422ff467cc51`
- Contents (unzip -t clean): ViralClips.exe (40,960 B, sha256
  `13926f5bc8b5c6807820fdabcf54f23a633d85ebd91872b3d63298667eaba6a1`),
  ffmpeg.exe + ffprobe.exe (byte-identical to Video Splitter v2:
  sha256 `3256173f…` / `f0d36ecb…`), yt-dlp.exe (23 MB, official release,
  sha256 `f5389d36…`), README.txt.
- Source: `~/workspace/viral_clips_app/src/` — Program.cs (~35 KB, fresh own
  code), Harness.cs, build.sh. Totally own code.

## What was verified
- `mcs` build clean (twice, incl. after the download-file fix). Exe is a
  PE32 GUI Mono/.Net assembly.
- Headless harness (Mono + Xvfb): MainForm constructs, full control tree
  present (link box, Browse file, clip length 45s, count 3, AI Settings,
  Download + Analyse, Make Clips, clip ListView with Score column, output
  folder, progress bar). HARNESS OK.
- Real exe window under Xvfb: process stayed alive for the full 8 s timeout
  window, no crash.
- End-to-end pipeline on a real downloaded video: Big Buck Bunny (YouTube,
  Creative Commons), first 90 s, 360p, 3.4 MB, downloaded with yt-dlp
  2026.10.26. Duration 90.014 s (ffprobe), 11 speech spans
  (silencedetect -35 dB), max volume 0.0 dB.
  - Test A (no captions — BBB has no auto subs): top-3 scores 46 / 44 / 43
    at 0:00, 0:15, 1:00. All 3 rendered 720x1280, exactly 30.000 s, rc=0.
  - Test B (synthetic VTT with hook words): top-3 scores 59 / 57 / 54,
    titles carry the hook text. All 3 rendered 720x1280, exactly 30.000 s.
  - Caption burn-in VISUALLY confirmed: frame at 7 s of clip 011 shows
    "What is the secret behind this amazing trick?" in big white text with
    black outline, 9:16 frame. SRT cue shifting verified (hook title
    0–2.5 s, transcript cues shifted to clip-relative times).
- One bug found + fixed during testing: when yt-dlp produced no .mp4, the
  fallback could have picked a .vtt as the "video". Fixed to prefer
  webm/mkv/mov/m4v/avi and never pick .vtt/.srt/.json/.part. Rebuilt +
  harness re-checked OK.

## What still needs Darren's laptop (final proof)
- Real Windows run of ViralClips.exe (double-click, SmartScreen "Run anyway").
- A real YouTube link download + analyse on the laptop (yt-dlp.exe is the
  Windows binary; it could not be executed on this Linux VM).
- A TikTok link download: NOT tested (no test TikTok URL was available, and
  the Windows yt-dlp binary cannot run here). The app tries yt-dlp first
  and shows a clear fallback message + file-upload path if TikTok blocks it.
- AI boost (Gemini/OpenAI/Groq key): code path written, never exercised
  against a live API (no key used). Local scoring works fully without it.
- The 9:16 render + subtitle filter were proven with Linux ffmpeg using the
  EXACT same filter chain the C# app runs; the Windows ffmpeg binaries are
  byte-identical to the proven v2 ones, but the Windows-side run is still
  the final proof.

## GitHub-ready files (do NOT push yet — Darren to give repo name + login)
- `src/Program.cs`, `src/Harness.cs`, `src/build.sh`
- `ViralClips_v1_README.txt` (ship as README.md in the repo)
- `.gitignore` (excludes out/, pkg/, test/, *.settings.txt, *.zip)
- Suggested repo files: README.md, LICENSE (MIT), .gitignore.
- NEVER commit `ViralClips.settings.txt` (holds the user's API key).

---

# ViralClips v2 — test report (2026-11-17)

## What changed vs v1
- TWO cut modes, prominent at the top of the window: **Full Cut** (local own
  scoring only, no key — exactly what v1 did) and **Cut using AI** (the AI
  brain: transcript + loudness/energy data sent to the user's own
  Gemini / OpenAI / Groq key, AI returns ranked moments as JSON).
- New `AiBrain` class in `Program.cs` (own code): JSON-only prompt
  (start_sec, end_sec, score 0-100, hook title, reason), defensive parse,
  timestamps clamped inside the video, scores clamped 0-100, picks
  de-overlapped with the same PickTop rule as v1. Never hardcodes a key.
- Cut using AI with no key: the app shows a clear message before starting
  ("Cut using AI needs your own AI key...") and offers Yes = fall back to
  Full Cut, No = cancel. If the AI call fails or returns nothing usable,
  it falls back to Full Cut local scoring and says so in the status line.
- Old v1 "AI boost" (silent re-rank) removed — the two modes replace it.
- GUI polished: mode group box ("How do you want to cut?") with two big
  options + one-line explanation under each, mode + key-status lines,
  form 660x880. Everything else kept (link box, Browse file, clip count
  default 3, length 30/45/60 s, clip list with scores + checkboxes, output
  folder, progress + ETA, Cancel, background worker).
- No third-party clip engine is named anywhere in v2 files
  (checked with a case-insensitive grep for that engine's name over the
  folder — zero matches in any plain-text v2 file; the already-delivered
  v1 ZIP's bundled README is the only place the name still sits, inside
  that compressed archive).

## Deliverable
- ZIP: `~/workspace/viral_clips_app/ViralClips_v2.zip` — 97 MB,
  sha256 `cd8ef689f9f2dfa532c50ea4e4149a58ea6107ae63e8a84d14e6ba30038b6129`
- Contents (unzip -t clean): ViralClips.exe v2 (47,104 B, sha256
  `8c22123fe3e07f01ef2e93e4ecf9529485b92178aed66e41b67bb958d9b99c73`),
  ffmpeg.exe + ffprobe.exe (byte-identical to v1: sha256 `3256173f…` /
  `f0d36ecb…`), yt-dlp.exe (fresh official download 2026-11-17, sha256
  `f5389d36…` — same release as v1), README.txt (v2).
- Source: `~/workspace/viral_clips_app/src/` — Program.cs (v2),
  Harness.cs (now also checks the two mode radios), build.sh (also builds
  Harness.exe). Tests: `test/AiParseTest.cs` (real C# test of AiBrain),
  `test/pipeline_test_v2.py`. README: `ViralClips_v2_README.txt`.

## What was verified
- `mcs` build clean (Program.cs + Harness.exe + AiParseTest.exe). Exe is a
  PE32 GUI Mono/.Net assembly.
- Headless harness (Mono + Xvfb): "ViralClips v2 - Own AI Clips", 660x880,
  GroupBox "How do you want to cut?", RadioButtons "Full Cut - all the best
  moments" and "Cut using AI - the AI brain picks the moments", labels
  "AI key: not set. Cut using AI needs a key - add one in AI Settings."
  and "Mode: Full Cut.". MODE RADIOS: FullCut=True AiCut=True. HARNESS OK.
- Real exe window under Xvfb: process stayed alive for the full 8 s timeout
  window, no crash.
- Real C# test of the AI brain (`AiParseTest.exe`, 12 checks, ALL PASS):
  prompt demands JSON only + includes transcript + energy data + caps a
  moment at the clip length; CallAi with no key returns false with
  "no AI key set - add your key in AI Settings" (no HTTP call made);
  stub AI reply parsed: score 250 clamped to 100, out-of-range moment
  (start 500 s in a 90 s video) clamped inside to 85-90 s, a 2 s moment
  extended to the 5 s minimum, overlapping moment dropped by PickTop
  (picks 20/50/85, scores 100/92/88); garbage reply parses to 0 moments
  without crashing.
- End-to-end pipeline (`test/pipeline_test_v2.py`, same Big Buck Bunny
  90.014 s video, 11 speech spans, max volume 0.0 dB):
  - Test A Full Cut (no captions): top-3 scores 46 / 44 / 43 at 0:00,
    0:15, 1:00. All 3 rendered 720x1280, exactly 30.000 s, rc=0.
  - Test B Cut using AI, NO key: error message shown, fallback picks
    identical to Test A (asserted equal).
  - Test C Cut using AI, STUBBED AI reply (same stub as the C# test):
    Python mirror of ParseAiMoments agrees with the C# parser
    (picks 20/50/85.014, scores 100/92/88). All 3 rendered 720x1280,
    durations 30.000 / 30.000 / 5.000 s, rc=0.
- One test-expectation bug found + fixed during testing (mine, not the
  app's): I first expected the too-short moment to be dropped and the
  overlap test to leave 2 picks; the app correctly EXTENDS a too-short
  moment to the 5 s minimum and keeps the clamped end-of-video moment,
  so PickTop keeps 3. Test corrected to the app's (correct) behaviour.

## What still needs Darren's laptop (final proof)
- Real Windows run of ViralClips v2 (double-click, SmartScreen "Run anyway").
- A real YouTube link download + analyse on the laptop (yt-dlp.exe is the
  Windows binary; it could not be executed on this Linux VM).
- A TikTok link download: NOT tested (no test TikTok URL was available, and
  the Windows yt-dlp binary cannot run here). Same fallback as v1.
- Cut using AI with a REAL key: never exercised against a live API (no key
  used). Tested with no key (clear message + fallback) and with a stubbed
  AI reply (real C# parser). The live call needs Darren's own key in
  AI Settings on the laptop.
- The 9:16 render + subtitle filter were proven with Linux ffmpeg using the
  EXACT same filter chain the C# app runs; the Windows ffmpeg binaries are
  byte-identical to the proven ones, but the Windows-side run is still the
  final proof.
- No score can guarantee a clip will go viral — v2 says this in the README
  and in the app's footer text.

## GitHub-ready files
- `src/Program.cs`, `src/Harness.cs`, `src/build.sh`
- `ViralClips_v2_README.txt` (ship as README.md in the repo)
- `.gitignore` (excludes out/, pkg/, pkg_v2/, test/, *.settings.txt, *.zip)
- `LICENSE` (MIT), `TEST_REPORT.md`
- NEVER commit `ViralClips.settings.txt` (holds the user's API key).
