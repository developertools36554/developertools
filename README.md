ViralClips v2 - totally own code, written from scratch
================================================================================

WHAT IT DOES
------------
Paste a YouTube or TikTok link, or pick a video file on your computer.
ViralClips downloads the video (bundled yt-dlp), reads it fast with ffprobe +
ffmpeg audio analysis, and cuts the best moments into 9:16 vertical clips
with burned captions, ready to post.

TWO WAYS TO CUT - pick one at the top of the window
---------------------------------------------------
1. FULL CUT - all the best moments (default)
   Local own scoring only, NO key needed. Speech density, loudness, hook
   words in the first 2 seconds, keyword hits, clean starts and early
   position rank every moment. This is exactly what v1 did.

2. CUT USING AI - the AI brain picks the moments
   Sends the transcript + loudness/energy data to YOUR OWN AI key
   (Gemini, OpenAI or Groq - set it in AI Settings) and asks the AI which
   moments would hold a stranger's attention. The AI replies with ranked
   moments (timestamps + scores + hook titles) and ViralClips cuts those.
   - No key set? The app tells you clearly and offers to fall back to
     Full Cut.
   - AI call fails, or the AI returns nothing usable? The app falls back
     to Full Cut local scoring and says so plainly on screen.
   - The AI is asked for JSON only, and every timestamp is checked and
     clamped inside the video before cutting.

3-STEP RUN
----------
1. Unzip this whole folder somewhere (keep ALL files together in one folder).
2. Double-click ViralClips.exe. If Windows SmartScreen appears, click
   "More info" then "Run anyway". Needs .NET Framework 4 (built into
   Windows 10/11 - nothing else to install).
3. Pick Full Cut or Cut using AI at the top, paste a link (YouTube / TikTok)
   or Browse for a file, press "Download + Analyse", tick the clips you
   want, press "Make Clips". Clips land in <video folder>\clips
   (or the folder you pick). Clip length 30 / 45 / 60 seconds, how many
   clips 1-10 (default 3).

HOW THE SCORES WORK (own formulas, 0-100)
------------------------------------------
Full Cut - speech density up to 40, word rate up to 20, hook in the first
2 seconds (question word, number, "!", hook word like secret / shocking /
free / best / never / stop) up to 20, keyword hits up to 10, clean start
5, early position 5. Top clips are picked so they do not overlap by more
than half.
Cut using AI - the score comes from the AI (0-100, how likely a stranger
keeps watching), then the same no-overlap rule is applied.
No score can guarantee a clip will go viral - it only ranks the moments
most likely to hold a stranger's attention.

CAPTIONS
--------
If YouTube auto-captions are available, yt-dlp downloads them (.vtt) and
ViralClips burns them into the clip (big white text, black outline) plus a
hook-title line for the first 2.5 seconds. If no captions exist, clips are
still cut using loudness/speech scoring only, with the hook title burned in.
Cut using AI works best WITH captions; without them it uses loudness and
energy data only.

AI SETTINGS (OPTIONAL, only for Cut using AI)
---------------------------------------------
Settings -> AI Settings: pick Gemini, OpenAI or Groq, paste YOUR OWN key
and model. The key is stored in ViralClips.settings.txt next to the exe,
on your computer only. No key is ever hardcoded, and the transcript is
sent only to the provider you picked. No key = Full Cut still works fully.

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
ViralClips.exe  - the app, v2 (own code)
ffmpeg.exe      - video cutting / analysis (gyan.dev essentials 9.0.2)
ffprobe.exe     - video length reading (same build as ffmpeg)
yt-dlp.exe      - video + auto-caption download (official release)
README.txt      - this file

SOURCE CODE (for GitHub)
------------------------
Full source is in src/ (Program.cs, Harness.cs, build.sh). Build it with
Mono's mcs on Linux, or Visual Studio / csc on Windows:
  mcs -target:winexe -out:ViralClips.exe -r:System.Windows.Forms.dll -r:System.Drawing.dll Program.cs

v2.0 - 2026-11-17. Built for Darren.
