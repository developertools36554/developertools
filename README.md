ViralClips v1 - totally own code, written from scratch
================================================================================

WHAT IT DOES
------------
Paste a YouTube or TikTok link, or pick a video file on your computer.
ViralClips downloads the video (bundled yt-dlp), reads it fast with ffprobe +
ffmpeg audio analysis, scores the moments with its own viral scoring, and cuts
the best ones into 9:16 vertical clips with burned captions, ready to post.

3-STEP RUN
----------
1. Unzip this whole folder somewhere (keep ALL files together in one folder).
2. Double-click ViralClips.exe. If Windows SmartScreen appears, click
   "More info" then "Run anyway". Needs .NET Framework 4 (built into
   Windows 10/11 - nothing else to install).
3. Paste a link (YouTube / TikTok) or Browse for a file, press
   "Download + Analyse", tick the clips you want, press "Make Clips".
   Clips land in <video folder>\clips (or the folder you pick).

HOW THE VIRAL SCORE WORKS (own formula, 0-100)
-----------------------------------------------
- Speech density (how much of the window is real speech, from ffmpeg
  silencedetect): up to 40 points.
- Word rate (fast, dense talking): up to 20 points.
- Hook in the first 2 seconds (question word, number, "!", hook word
  like secret / shocking / free / best / never / stop): up to 20 points.
- Keyword hits in the whole window: up to 10 points.
- Clean start (window starts right on speech) + early position: 5 + 5.
Top clips are picked so they do not overlap by more than half.
No score can guarantee a clip will go viral - it only ranks the moments
most likely to hold a stranger's attention.

CAPTIONS
--------
If YouTube auto-captions are available, yt-dlp downloads them (.vtt) and
ViralClips burns them into the clip (big white text, black outline) plus a
hook-title line for the first 2.5 seconds. If no captions exist, clips are
still cut using loudness/speech scoring only, with the hook title burned in.

AI BOOST (OPTIONAL)
-------------------
Settings -> AI Settings: pick Gemini, OpenAI or Groq, paste YOUR OWN key
and model. If a key is set, the transcript is sent to that provider only,
to re-rank moments. If no key is set, the app works fully with local
scoring. No key is ever hardcoded. The key is stored in
ViralClips.settings.txt next to the exe, on your computer only.

TIKTOK
------
TikTok often blocks direct downloads. ViralClips tries yt-dlp first; if
TikTok blocks it, you get a clear message - save the video file yourself
and use "Browse file..." instead. That path always works.

RULES
-----
Only clip your own videos, or videos you have permission to use.
You are responsible for the rights to what you download, clip and post,
and for following YouTube / TikTok terms. No clip is guaranteed to go viral.

FILES IN THIS ZIP
-----------------
ViralClips.exe  - the app (own code)
ffmpeg.exe      - video cutting / analysis (gyan.dev essentials 9.0.2)
ffprobe.exe     - video length reading (same build as ffmpeg)
yt-dlp.exe      - video + auto-caption download (official release)
README.txt      - this file

SOURCE CODE (for GitHub)
------------------------
Full source is in src/ (Program.cs, Harness.cs, build.sh). Build it with
Mono's mcs on Linux, or Visual Studio / csc on Windows:
  mcs -target:winexe -out:ViralClips.exe -r:System.Windows.Forms.dll -r:System.Drawing.dll Program.cs

v1.0 - 2026-11-17. Built for Darren.
