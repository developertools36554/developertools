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
