/* ViralClips web — fully own code, single-page static app.
   Full Cut runs entirely in the user's browser: analysis and cutting
   happen on the device, and no video is ever uploaded anywhere.
   Cut using AI needs NO key from the user: the page computes analysis
   data in the browser (loudness, speech spans, transcript, local
   moments) and POSTs only that data — never video bytes — to our own
   server (MUSE_API_BASE below), where Muse analyses it. The page polls
   the result endpoint until the ranked moments come back, then cuts the
   clips with ffmpeg.wasm exactly as Full Cut does.
   Other network calls: ffmpeg.wasm + a font from public CDNs when
   cutting clips, and our own server (apiurl.online) when the user
   pastes a link — it resolves the link to a direct video URL.
   No clip is guaranteed to go viral: the score only ranks moments most
   likely to hold a stranger's attention. */

"use strict";

/* ---------- our AI server: Muse analyses the request ---------- */
/* Change this ONE constant if the server moves. The page POSTs analysis
   data to <base>/analyse.php and polls <base>/result.php?id=... */
const MUSE_API_BASE = "https://apiurl.online/viralclips/api";
const MUSE_ANALYSE_URL = MUSE_API_BASE + "/analyse.php";
const MUSE_RESULT_URL = MUSE_API_BASE + "/result.php";
const MUSE_DOWNLOAD_URL = MUSE_API_BASE + "/download.php";

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s % 60;
  return m + ":" + String(r).padStart(2, "0");
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- scoring word lists (same idea as the Windows app) ---------- */
const HOOK_WORDS = ["secret", "shocking", "free", "best", "never", "stop",
  "amazing", "insane", "truth", "mistake", "hack", "easy", "new", "first",
  "why", "how", "what", "watch", "look", "wait", "crazy", "unbelievable"];
const QUESTION_WORDS = ["what", "why", "how", "when", "where", "who", "which",
  "is", "are", "can", "could", "should", "did", "do", "does"];
const KEYWORDS = HOOK_WORDS.concat(["viral", "money", "win", "lose", "love",
  "hate", "big", "huge", "top", "pro", "tip", "trick", "guide", "review"]);

/* ---------- state ---------- */
const state = {
  file: null,            // File object
  fileName: "video",
  duration: 0,           // seconds
  buckets: null,         // RMS per 0.25s bucket, normalised 0..1
  speech: null,          // boolean per bucket: speech present
  clips: [],             // ranked clip objects {start, end, score, title, reason, source}
  ffmpeg: null,          // ffmpeg.wasm instance, loaded lazily
  fontOk: false,         // DejaVu font loaded into ffmpeg MEMFS
  transcript: "",
  recognition: null,
};

/* ---------- Cut using AI needs no key from the user ---------- */
/* Nothing is stored: no provider, no model, no key anywhere on this
   page. In AI mode the page sends only analysis data to our own server
   (see requestAiRanking below) and Muse analyses it there. */

/* Mode selector: show AI settings hint when AI mode is picked */
document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (document.querySelector('input[name="mode"]:checked').value === "ai") {
      setStatus("Cut using AI: Muse analyses your video's moments on our server. No key needed — just add a video and press Analyse.");
    } else {
      setStatus("Full Cut: local scoring, no key needed. Add a video and press Analyse.");
    }
  });
});
function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

/* ---------- video file handling ---------- */
const dropZone = $("drop-zone");
const fileInput = $("file-input");
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
["dragover", "dragenter"].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.add("drag");
}));
["dragleave", "drop"].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.remove("drag");
}));
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadVideoFile(f);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) loadVideoFile(fileInput.files[0]);
});

function loadVideoFile(file) {
  if (!file || !file.type || file.type.indexOf("video/") !== 0) {
    setStatus("That does not look like a video file. Pick a video file (MP4, WebM, MOV).", "error");
    return;
  }
  state.file = file;
  state.fileName = file.name.replace(/\.[^.]+$/, "") || "video";
  state.clips = [];
  renderClips();
  $("make-clips").disabled = true;
  const url = URL.createObjectURL(file);
  const preview = $("preview");
  preview.hidden = false;
  preview.src = url;
  preview.onloadedmetadata = () => {
    state.duration = preview.duration || 0;
    $("file-info").textContent = file.name + " — " +
      (file.size / 1048576).toFixed(1) + " MB — duration " + fmtTime(state.duration);
    setStatus("Video loaded (" + fmtTime(state.duration) + "). Press Analyse video.", "ok");
  };
  preview.onerror = () => setStatus("This browser could not read that video file. Try an MP4 file.", "error");
}

/* ---------- audio analysis (Web Audio API, in-browser) ---------- */
async function analyseAudio() {
  state.buckets = null;
  state.speech = null;
  if (!state.file) return false;
  try {
    const buf = await state.file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) { setStatus("This browser has no Web Audio API, so loudness analysis is unavailable. Scoring will use timing only.", "error"); return false; }
    const ctx = new AudioCtx();
    const audio = await ctx.decodeAudioData(buf);
    await ctx.close();
    const data = audio.getChannelData(0);
    const bucketSec = 0.25;
    const n = Math.max(1, Math.floor(audio.duration / bucketSec));
    const buckets = new Array(n).fill(0);
    let peak = 0;
    const per = Math.floor(data.length / n) || 1;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const start = i * per;
      const end = Math.min(data.length, start + per);
      for (let j = start; j < end; j += 7) { // sample every 7th frame: fast + accurate enough
        const v = data[j];
        sum += v * v;
      }
      const count = Math.max(1, Math.floor((end - start) / 7));
      const rms = Math.sqrt(sum / count);
      buckets[i] = rms;
      if (rms > peak) peak = rms;
    }
    if (peak <= 0) peak = 1;
    state.buckets = buckets.map((b) => b / peak);
    // Speech = bucket loud enough to be a voice (relative threshold).
    state.speech = state.buckets.map((b) => b > 0.08);
    return true;
  } catch (e) {
    setStatus("Audio could not be decoded in this browser (" + (e && e.message ? e.message : "unknown error") + "). Scoring will use timing only.", "error");
    return false;
  }
}

/* ---------- own viral scoring, 0-100 (same formula as the Windows app) ---------- */
function transcriptWords() {
  const t = (state.transcript || "").toLowerCase();
  return t;
}
function scoreWindow(start, len) {
  const end = Math.min(state.duration, start + len);
  const actualLen = Math.max(1, end - start);
  let score = 0;
  let speechSec = 0;
  let onsets = 0;
  let first2Peak = 0;
  const bucketSec = 0.25;
  if (state.buckets && state.speech) {
    const b0 = Math.floor(start / bucketSec);
    const b1 = Math.min(state.buckets.length - 1, Math.floor(end / bucketSec));
    let prevSpeech = false;
    for (let i = b0; i <= b1; i++) {
      if (state.speech[i]) {
        speechSec += bucketSec;
        if (!prevSpeech) onsets++;
        prevSpeech = true;
      } else prevSpeech = false;
      if (i < b0 + 8 && state.buckets[i] > first2Peak) first2Peak = state.buckets[i];
    }
    // Speech density: up to 40
    score += 40 * clamp(speechSec / actualLen, 0, 1);
    // Word rate, approximated by speech onsets (fast, dense talking): up to 20
    score += 20 * clamp(onsets / 12, 0, 1);
    // Loudness peak in the first 2 seconds (hook energy): up to 10
    score += 10 * clamp(first2Peak, 0, 1);
  } else {
    score += 20; // no audio data: neutral middle, timing still ranks
  }
  // Hook in the first 2 seconds + keywords, from transcript / file name
  const text = (transcriptWords() + " " + state.fileName.toLowerCase());
  const first2Text = text; // transcript has no per-second timing here, so score whole-text hooks at half weight
  let hookPts = 0;
  for (const w of QUESTION_WORDS) if (first2Text.indexOf(w) !== -1) { hookPts = 10; break; }
  if (/\d/.test(state.fileName)) hookPts = Math.max(hookPts, 6);
  for (const w of HOOK_WORDS) if (text.indexOf(w) !== -1) { hookPts = Math.max(hookPts, 10); break; }
  score += hookPts; // up to 10 of the 20 hook points; remaining 10 come from first-2s loudness above
  // Keyword hits in the whole window text: up to 10
  let hits = 0;
  for (const w of KEYWORDS) if (text.indexOf(w) !== -1) hits++;
  score += 10 * clamp(hits / 5, 0, 1);
  // Clean start (window starts on speech): 5
  if (state.speech) {
    const b = Math.floor(start / bucketSec);
    if (state.speech[b]) score += 5;
  }
  // Early position (earlier moments hold attention slightly better): 5
  score += 5 * clamp(1 - start / Math.max(1, state.duration), 0, 1);
  return Math.round(clamp(score, 0, 100));
}

function hookTitleFor(start) {
  const text = transcriptWords();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    // First words of the transcript as a hook line (trimmed, capitalised).
    let t = words.slice(0, 8).join(" ");
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.length > 60) t = t.slice(0, 57) + "...";
    return t;
  }
  return "Watch this — " + state.fileName.slice(0, 40);
}

function buildCandidateWindows(clipLen) {
  const wins = [];
  const step = clipLen / 2;
  for (let s = 0; s + 8 <= state.duration; s += step) {
    wins.push({ start: s, end: Math.min(state.duration, s + clipLen) });
  }
  // Also start a window at each speech-span start, so cuts land on speech.
  if (state.speech) {
    const bucketSec = 0.25;
    let inSpeech = false;
    for (let i = 0; i < state.speech.length; i++) {
      if (state.speech[i] && !inSpeech) {
        const s = i * bucketSec;
        if (s + 8 <= state.duration) wins.push({ start: s, end: Math.min(state.duration, s + clipLen) });
      }
      inSpeech = state.speech[i];
    }
  }
  return wins;
}

function rankLocalClips(count, clipLen) {
  const wins = buildCandidateWindows(clipLen);
  const scored = wins.map((w) => ({
    start: w.start, end: w.end,
    score: scoreWindow(w.start, clipLen),
    title: hookTitleFor(w.start),
    reason: "Local score: speech density, loudness and hook words.",
    source: "local",
  }));
  scored.sort((a, b) => b.score - a.score);
  // De-overlap: keep a pick only if it overlaps a kept clip by less than half.
  const picked = [];
  for (const c of scored) {
    if (picked.length >= count) break;
    let ok = true;
    for (const p of picked) {
      const overlap = Math.max(0, Math.min(c.end, p.end) - Math.max(c.start, p.start));
      if (overlap > clipLen / 2) { ok = false; break; }
    }
    if (ok) picked.push(c);
  }
  picked.sort((a, b) => b.score - a.score);
  return picked;
}

/* ---------- Cut using AI ---------- */
/* Client-generated request id (also the id the server files the job under). */
function newRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "vc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/* Speech spans from the per-bucket speech flags: [{start, end}, ...]. */
function speechSpans() {
  if (!state.speech) return [];
  const bucketSec = 0.25;
  const spans = [];
  let start = null;
  for (let i = 0; i <= state.speech.length; i++) {
    const on = i < state.speech.length && state.speech[i];
    if (on && start === null) start = i * bucketSec;
    if (!on && start !== null) {
      spans.push({ start: +start.toFixed(2), end: +(i * bucketSec).toFixed(2) });
      start = null;
    }
  }
  return spans;
}

/* Loudness buckets, rounded and downsampled so the POST stays small.
   Never includes any video bytes — only numbers 0..1 per 0.25s bucket. */
function packedBuckets() {
  if (!state.buckets) return [];
  const max = 4000;
  const src = state.buckets;
  if (src.length <= max) return src.map((b) => +b.toFixed(3));
  const out = [];
  const step = src.length / max;
  for (let i = 0; i < max; i++) {
    const a = Math.floor(i * step), b = Math.min(src.length, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = a; j < b; j++) sum += src[j];
    out.push(+((sum / Math.max(1, b - a)).toFixed(3)));
  }
  return out;
}

/* The POST body for the AI server. Analysis data ONLY: no video bytes,
   no key of any kind. The server analyses this and returns ranked moments. */
function buildAiPayload(localTop, count, clipLen) {
  return {
    id: newRequestId(),
    mode: "ai",
    duration: +state.duration.toFixed(2),
    file_name: state.fileName,
    speech_spans: speechSpans(),
    loudness_buckets: packedBuckets(),
    bucket_sec: 0.25,
    transcript: (state.transcript || "").slice(0, 20000),
    clip_count: count,
    clip_len: clipLen,
    local_moments: localTop.map((m) => ({
      start: +m.start.toFixed(2), end: +m.end.toFixed(2),
      score: m.score, title: m.title, reason: m.reason || "",
    })),
  };
}

/* Poll the result endpoint every 10s until the ranked moments arrive.
   Throws SERVER_NOT_LIVE (unreachable / bad HTTP), TIMEOUT (5 min), or
   the server's own error message. Never invents a result. */
async function pollAiResult(id, count, clipLen) {
  const started = Date.now();
  const maxWaitMs = 5 * 60 * 1000;
  let waits = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(MUSE_RESULT_URL + "?id=" + encodeURIComponent(id), { method: "GET" });
    } catch (e) {
      throw new Error("SERVER_NOT_LIVE");
    }
    if (!res.ok) throw new Error("SERVER_NOT_LIVE");
    let data = null;
    try { data = await res.json(); } catch (e) { throw new Error("SERVER_NOT_LIVE"); }
    if (data && data.status === "done") {
      return validateMoments(data.moments, count, clipLen);
    }
    if (data && data.status === "error") {
      throw new Error(String(data.error || "The server reported an error while analysing."));
    }
    // status "queued" (or unknown): keep waiting, but not forever.
    waits++;
    if (Date.now() - started > maxWaitMs) throw new Error("TIMEOUT");
    setStatus("Muse is analysing your video… (" + (waits * 10) + "s)");
    await new Promise((r) => setTimeout(r, 10000));
  }
}

/* Cut using AI, no key from the user: POST analysis data to our server,
   then poll until Muse returns the ranked moments. */
async function requestAiRanking(localTop, count, clipLen) {
  const payload = buildAiPayload(localTop, count, clipLen);
  let res;
  try {
    res = await fetch(MUSE_ANALYSE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error("SERVER_NOT_LIVE");
  }
  if (!res.ok) throw new Error("SERVER_NOT_LIVE");
  let data = null;
  try { data = await res.json(); } catch (e) { throw new Error("SERVER_NOT_LIVE"); }
  if (!data || data.ok !== true || !data.id) throw new Error("SERVER_NOT_LIVE");
  return pollAiResult(data.id, count, clipLen);
}

function validateMoments(arr, count, clipLen) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("The server returned no ranked moments. Falling back to local scoring.");
  }
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    // Server contract: start_sec / end_sec. Tolerate start / end too.
    let s = Number(item.start_sec != null ? item.start_sec : item.start);
    let e2 = Number(item.end_sec != null ? item.end_sec : item.end);
    if (!isFinite(s) || !isFinite(e2)) continue;
    s = clamp(s, 0, Math.max(0, state.duration - 5));
    e2 = clamp(e2, s + 5, Math.min(state.duration, s + clipLen));
    if (e2 - s < 5) continue;
    out.push({
      start: s, end: e2,
      score: clamp(Math.round(Number(item.score) || 50), 0, 100),
      title: String(item.title || hookTitleFor(s)).slice(0, 80),
      reason: String(item.reason || "Ranked by Muse."),
      source: "ai",
    });
  }
  if (!out.length) {
    throw new Error("The server returned no usable moments. Falling back to local scoring.");
  }
  // De-overlap, same rule as local ranking.
  const picked = [];
  out.sort((a, b) => b.score - a.score);
  for (const c of out) {
    if (picked.length >= count) break;
    let ok = true;
    for (const p of picked) {
      const overlap = Math.max(0, Math.min(c.end, p.end) - Math.max(c.start, p.start));
      if (overlap > clipLen / 2) { ok = false; break; }
    }
    if (ok) picked.push(c);
  }
  return picked;
}

/* ---------- link download (via our own server) ---------- */
/* The public download service this page used to call now needs an API
   key, and YouTube is disabled on its main instance — so links go
   through our own server instead: POST the link to download.php, poll
   result.php until the worker resolves a direct video URL, then fetch
   that URL from this browser (the user's own connection) and load it
   exactly as an uploaded file. No video bytes pass through our server.
   If any step fails, the honest message below says so and points at
   the file-upload path, which always works. */
async function tryLinkDownload(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) { setStatus("Paste a YouTube or TikTok link first.", "error"); return; }
  let dlUrl = null, dlTitle = "", dlDur = 0;
  try {
    setStatus("Asking our server to fetch that link…");
    const res = await fetch(MUSE_DOWNLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dl-" + newRequestId(), url: trimmed }),
    });
    if (!res.ok) throw new Error("download endpoint " + res.status);
    const data = await res.json();
    if (!data || data.ok !== true || !data.id) throw new Error("bad download reply");
    // Poll result.php up to 3 minutes for the resolved direct URL.
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 180000) throw new Error("download timed out");
      await new Promise((r) => setTimeout(r, 5000));
      let rr;
      try {
        rr = await fetch(MUSE_RESULT_URL + "?id=" + encodeURIComponent(data.id));
      } catch (e) { throw new Error("download server unreachable"); }
      if (!rr.ok) throw new Error("download server error");
      const dj = await rr.json();
      if (dj && dj.status === "done" && dj.url) {
        dlUrl = dj.url; dlTitle = dj.title || ""; dlDur = dj.duration || 0;
        break;
      }
      if (dj && dj.status === "error") throw new Error(String(dj.error || "download failed"));
      setStatus("Our server is fetching your video… (this usually takes under a minute)");
    }
  } catch (e) {
    setStatus("Link download did not work here: " + (e && e.message ? e.message : "our server could not fetch that link") + ". The video may be private, age-restricted, or longer than 30 minutes. Download the video yourself and upload the file below — that path works fully in your browser.", "error");
    return;
  }
  try {
    setStatus("Link ready" + (dlTitle ? " — " + dlTitle : "") + " — downloading the video file into your browser…");
    const res = await fetch(dlUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (!blob || blob.size < 10000) throw new Error("empty file");
    const base = (dlTitle || "downloaded-video").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "downloaded-video";
    const file = new File([blob], base + ".mp4", { type: blob.type || "video/mp4" });
    setStatus("Link downloaded (" + (blob.size / 1048576).toFixed(1) + " MB" + (dlDur ? ", " + fmtTime(dlDur) : "") + "). Now press Analyse video.", "ok");
    loadVideoFile(file);
  } catch (e) {
    setStatus("Our server found the video, but this browser could not fetch the file from the video host (blocked by the video host). Download the video yourself and upload the file below — that path works fully in your browser.", "error");
  }
}
$("try-link").addEventListener("click", () => tryLinkDownload($("link-input").value));

/* ---------- live transcription (experimental, mic-based) ---------- */
$("live-transcribe").addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("live-transcribe-note").textContent = "Live transcription is not supported in this browser (it needs Chrome or Edge). Paste a transcript in the box above instead.";
    return;
  }
  if (!state.file) {
    $("live-transcribe-note").textContent = "Load a video file first, then try live transcription.";
    return;
  }
  try {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    state.recognition = rec;
    $("live-transcribe-note").textContent = "Listening… play the video (speakers on, mic able to hear it). Captured words appear in the transcript box. Press the button again to stop.";
    rec.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript + " ";
      $("transcript").value = text.trim();
      state.transcript = text.trim();
    };
    rec.onerror = (ev) => {
      $("live-transcribe-note").textContent = "Transcription stopped (" + (ev.error || "error") + "). Paste a transcript instead if you have one.";
    };
    rec.onend = () => { state.recognition = null; };
    rec.start();
    $("preview").play().catch(() => {});
  } catch (e) {
    $("live-transcribe-note").textContent = "Transcription could not start (" + (e && e.message ? e.message : "error") + "). Paste a transcript instead.";
  }
});

/* ---------- analyse flow ---------- */
$("analyse").addEventListener("click", async () => {
  if (!state.file) { setStatus("Add a video first — paste a link or upload a file.", "error"); return; }
  if (!state.duration || state.duration < 8) {
    setStatus("This video is too short to cut clips from (needs at least 8 seconds).", "error");
    return;
  }
  state.transcript = $("transcript").value.trim();
  const count = clamp(parseInt($("clip-count").value, 10) || 3, 1, 10);
  const clipLen = parseInt($("clip-length").value, 10) || 30;
  setStatus("Analysing audio in your browser…");
  await analyseAudio();
  const mode = currentMode();
  if (mode === "ai") {
    setStatus("Local moments found. Sending analysis data to Muse…");
    const localTop = rankLocalClips(Math.min(12, count * 4), clipLen);
    try {
      const aiClips = await requestAiRanking(localTop, count, clipLen);
      let clips = aiClips;
      if (clips.length < count) {
        // Top up with local picks so the user still gets the clips they asked for.
        for (const c of localTop) {
          if (clips.length >= count) break;
          if (!clips.some((p) => Math.abs(p.start - c.start) < clipLen / 2)) clips.push(c);
        }
        clips.sort((a, b) => b.score - a.score);
      }
      state.clips = clips;
      renderClips();
      setStatus("Muse ranking done — " + clips.length + " clip" + (clips.length === 1 ? "" : "s") + " ranked. Tick the ones you want, then press Make clips.", "ok");
    } catch (e) {
      // Honest fallback: AI server unavailable, local scoring still gives clips.
      state.clips = rankLocalClips(count, clipLen);
      renderClips();
      if (e && e.message === "SERVER_NOT_LIVE") {
        setStatus("AI analysis server is not live yet — use Full Cut for now, it works fully in your browser. Your clips below are ranked by Full Cut local scoring.", "error");
      } else if (e && e.message === "TIMEOUT") {
        setStatus("Muse is taking too long to answer — fell back to Full Cut local scoring. Your clips are ranked below. Try Cut using AI again in a little while.", "error");
      } else {
        setStatus("Muse analysis failed (" + (e && e.message ? e.message : "unknown error") + ") — fell back to Full Cut local scoring. Your clips are ranked below.", "error");
      }
    }
  } else {
    state.clips = rankLocalClips(count, clipLen);
    renderClips();
    setStatus("Analysis done — " + state.clips.length + " clip" + (state.clips.length === 1 ? "" : "s") + " ranked. Tick the ones you want, then press Make clips.", "ok");
  }
});

/* ---------- results rendering ---------- */
function renderClips() {
  const list = $("clip-list");
  list.innerHTML = "";
  $("results-empty").style.display = state.clips.length ? "none" : "";
  $("make-clips").disabled = !state.clips.length;
  $("download-list").innerHTML = "";
  state.clips.forEach((c, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      '<input type="checkbox" checked data-i="' + i + '" aria-label="Include clip ' + (i + 1) + '">' +
      '<div class="clip-meta">' +
      '<div class="clip-title">Clip ' + (i + 1) + " — " + escapeHtml(c.title) + "</div>" +
      '<div class="clip-detail">' + fmtTime(c.start) + " – " + fmtTime(c.end) +
      " · Score " + c.score + "/100 · " +
      (c.source === "ai" ? "Cut using AI" : "Full Cut") + "</div>" +
      '<div class="clip-detail">' + escapeHtml(c.reason || "") + "</div>" +
      '<div class="score-bar"><span style="width:' + c.score + '%"></span></div>' +
      "</div>";
    list.appendChild(li);
  });
}
function selectedClips() {
  const boxes = document.querySelectorAll('#clip-list input[type="checkbox"]');
  const out = [];
  boxes.forEach((b) => {
    if (b.checked) out.push(state.clips[parseInt(b.dataset.i, 10)]);
  });
  return out.filter(Boolean);
}

/* ---------- ffmpeg.wasm: load on demand, fail loudly and clearly ---------- */
function loadFfmpegScript() {
  return new Promise((resolve, reject) => {
    if (window.FFmpeg) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("ffmpeg.wasm script could not load from the CDN. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

async function ensureFfmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  setStatus("Loading the in-browser video cutter (ffmpeg.wasm) from the CDN…");
  $("ffmpeg-state").textContent = "Loading ffmpeg.wasm…";
  try {
    await loadFfmpegScript();
    if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
      throw new Error("ffmpeg.wasm loaded but did not initialise. Try reloading the page.");
    }
    const ffmpeg = window.FFmpeg.createFFmpeg({
      log: false,
      corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    });
    await ffmpeg.load();
    state.ffmpeg = ffmpeg;
    $("ffmpeg-state").textContent = "Video cutter ready (ffmpeg.wasm, in your browser).";
    // Try to load a font so hook titles can be burned in. Failure is not fatal.
    try {
      const res = await fetch("https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf");
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        ffmpeg.FS("writeFile", "font.ttf", buf);
        state.fontOk = true;
      }
    } catch (e) { state.fontOk = false; }
    return ffmpeg;
  } catch (e) {
    $("ffmpeg-state").textContent = "Video cutter failed to load.";
    throw e;
  }
}

/* Build the drawtext filter for a hook title (first 2.5s) + transcript cues. */
function captionFilter(clip) {
  if (!state.fontOk) return null;
  const filters = [];
  const safeTitle = clip.title.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  filters.push(
    "drawtext=fontfile=font.ttf:text='" + safeTitle +
    "':fontsize=44:fontcolor=white:borderw=2:bordercolor=black:" +
    "x=(w-text_w)/2:y=h-220:enable='between(t,0,2.5)'"
  );
  // Transcript cues, if we have a transcript: split into ~4s chunks across the clip.
  const words = (state.transcript || "").split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    const perCue = 10;
    const clipDur = clip.end - clip.start;
    const nCues = Math.max(1, Math.floor(words.length / perCue));
    for (let i = 0; i < nCues; i++) {
      const chunk = words.slice(i * perCue, (i + 1) * perCue).join(" ");
      if (!chunk) continue;
      const t0 = 2.5 + (i * (clipDur - 2.5)) / nCues;
      const t1 = 2.5 + ((i + 1) * (clipDur - 2.5)) / nCues;
      const safe = chunk.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
      filters.push(
        "drawtext=fontfile=font.ttf:text='" + safe +
        "':fontsize=36:fontcolor=white:borderw=2:bordercolor=black:" +
        "x=(w-text_w)/2:y=h-160:enable='between(t," + t0.toFixed(2) + "," + t1.toFixed(2) + ")'"
      );
    }
  }
  return filters.join(",");
}

function safeFileName(s) {
  return s.replace(/[^a-z0-9-_]+/gi, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "video";
}

$("make-clips").addEventListener("click", async () => {
  const clips = selectedClips();
  if (!clips.length) { setStatus("Tick at least one clip first.", "error"); return; }
  if (!state.file) { setStatus("No video loaded.", "error"); return; }
  const progress = $("progress");
  progress.hidden = false;
  progress.value = 0;
  $("download-list").innerHTML = "";
  $("make-clips").disabled = true;
  try {
    const ffmpeg = await ensureFfmpeg();
    const inputName = "input." + (state.file.name.split(".").pop() || "mp4");
    const data = new Uint8Array(await state.file.arrayBuffer());
    ffmpeg.FS("writeFile", inputName, data);
    const total = clips.length;
    for (let i = 0; i < total; i++) {
      const clip = clips[i];
      const outName = safeFileName(state.fileName) + "_clip_" + String(i + 1).padStart(3, "0") + ".mp4";
      setStatus("Cutting clip " + (i + 1) + " of " + total + " (" + fmtTime(clip.start) + " – " + fmtTime(clip.end) + ")…");
      const vf = ["crop=ih*9/16:ih", "scale=720:1280"];
      const cap = captionFilter(clip);
      if (cap) vf.push(cap);
      const args = [
        "-ss", String(clip.start.toFixed(2)),
        "-t", String((clip.end - clip.start).toFixed(2)),
        "-i", inputName,
        "-vf", vf.join(","),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        outName,
      ];
      await ffmpeg.run.apply(ffmpeg, args);
      const outData = ffmpeg.FS("readFile", outName);
      const blob = new Blob([outData], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      a.textContent = "Download " + outName + " (" + (blob.size / 1048576).toFixed(1) + " MB)";
      li.appendChild(a);
      $("download-list").appendChild(li);
      try { ffmpeg.FS("unlink", outName); } catch (e) {}
      progress.value = Math.round(((i + 1) / total) * 100);
    }
    try { ffmpeg.FS("unlink", inputName); } catch (e) {}
    setStatus("Done — " + total + " clip" + (total === 1 ? "" : "s") + " ready below. Download each one. " +
      (state.fontOk ? "Hook titles and captions were burned in." : "Captions were skipped (the caption font could not load), but the clips are cut correctly."), "ok");
  } catch (e) {
    setStatus("Cutting failed: " + (e && e.message ? e.message : "unknown error") +
      " Your video was not uploaded anywhere — this happened in your browser. Try reloading the page and pressing Make clips again.", "error");
  } finally {
    progress.hidden = true;
    $("make-clips").disabled = false;
  }
});

/* ---------- init ---------- */
/* Nothing to restore: no key is stored anywhere. */
