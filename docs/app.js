/* ViralClips web — fully own code, single-page static app.
   Everything runs in the user's browser. No video or key is ever sent
   to any ViralClips server (there is none). The only network calls are:
   - ffmpeg.wasm + a font, loaded from public CDNs when cutting clips
   - the AI provider the user chose, only in Cut using AI mode, only with
     the user's own key
   - an optional public download service when the user pastes a link
   No clip is guaranteed to go viral: the score only ranks moments most
   likely to hold a stranger's attention. */

"use strict";

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

/* ---------- AI key storage (localStorage only, this browser only) ---------- */
const KEY_STORE = "viralclips_ai";
function loadKey() {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function saveKey() {
  const data = {
    provider: $("ai-provider").value,
    model: $("ai-model").value.trim(),
    key: $("ai-key").value.trim(),
  };
  if (!data.key) { setStatus("Paste your API key first, then save it.", "error"); return; }
  try { localStorage.setItem(KEY_STORE, JSON.stringify(data)); } catch (e) {}
  $("key-state").textContent = "Key saved in this browser for " + data.provider + ".";
  setStatus("Key saved in this browser. It is never sent anywhere except the provider you chose.", "ok");
}
function clearKey() {
  try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  $("ai-key").value = "";
  $("key-state").textContent = "Key cleared.";
  setStatus("Key cleared from this browser.", "ok");
}
function refreshKeyState() {
  const saved = loadKey();
  if (saved) {
    $("ai-provider").value = saved.provider || "gemini";
    $("ai-model").value = saved.model || $("ai-model").value;
    $("ai-key").value = saved.key || "";
    $("key-state").textContent = "A key is saved in this browser for " + (saved.provider || "gemini") + ".";
  }
}
$("save-key").addEventListener("click", saveKey);
$("clear-key").addEventListener("click", clearKey);

/* Provider model defaults */
const MODEL_DEFAULTS = { gemini: "gemini-2.0-flash", openai: "gpt-4o-mini", groq: "llama-3.3-70b-versatile" };
$("ai-provider").addEventListener("change", () => {
  $("ai-model").value = MODEL_DEFAULTS[$("ai-provider").value] || "";
  const saved = loadKey();
  if (saved && saved.provider === $("ai-provider").value && saved.model) {
    $("ai-model").value = saved.model;
  }
});

/* Mode selector: show AI settings hint when AI mode is picked */
document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (document.querySelector('input[name="mode"]:checked').value === "ai") {
      setStatus("Cut using AI: add your key in AI settings below, then analyse. No key yet? Use Full Cut instead — it works without one.");
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
function aiPrompt(moments, count, clipLen) {
  const lines = moments.map((m, i) =>
    (i + 1) + ". " + fmtTime(m.start) + "–" + fmtTime(m.end) +
    " | local score " + m.score + "/100 | " + m.title
  ).join("\n");
  return "You are ranking moments of a video for short vertical clips. " +
    "Pick the " + count + " moments below most likely to hold a stranger's " +
    "attention in the first 2 seconds and make them keep watching. " +
    "Prefer strong hooks, questions, surprising or emotional moments, and " +
    "clear punchy lines. Reply with JSON ONLY — a JSON array, nothing else — " +
    "of objects: {\"start\": seconds, \"end\": seconds, \"score\": 0-100, " +
    "\"title\": \"short hook title\", \"reason\": \"one short sentence\"}. " +
    "Each clip must be " + clipLen + " seconds or shorter, start inside the video, " +
    "and clips must not overlap by more than half. Moments:\n" + lines +
    (state.transcript ? "\nTranscript (may be partial):\n" + state.transcript.slice(0, 4000) : "");
}

async function callAI(moments, count, clipLen) {
  const saved = loadKey();
  if (!saved || !saved.key) {
    throw new Error("NO_KEY");
  }
  const prompt = aiPrompt(moments, count, clipLen);
  let url, body, headers = { "Content-Type": "application/json" };
  if (saved.provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(saved.model || "gemini-2.0-flash") + ":generateContent?key=" +
      encodeURIComponent(saved.key);
    body = { contents: [{ parts: [{ text: prompt }] }] };
  } else if (saved.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers.Authorization = "Bearer " + saved.key;
    body = {
      model: saved.model || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    };
  } else { // groq, OpenAI-compatible
    url = "https://api.groq.com/openai/v1/chat/completions";
    headers.Authorization = "Bearer " + saved.key;
    body = {
      model: saved.model || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    };
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error("AI request failed (HTTP " + res.status + "). Check the key, the model name, and the provider.");
  }
  const data = await res.json();
  let text = "";
  if (saved.provider === "gemini") {
    text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || "";
  } else {
    text = (data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || "";
  }
  return parseAiClips(text, count, clipLen);
}

function parseAiClips(text, count, clipLen) {
  if (!text) throw new Error("The AI returned an empty reply.");
  // Find the first JSON array in the reply (models often add fences / prose).
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The AI reply was not JSON. Falling back to local scoring.");
  }
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error("The AI reply could not be read as JSON. Falling back to local scoring."); }
  if (!Array.isArray(arr)) throw new Error("The AI reply was not a list. Falling back to local scoring.");
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    let s = Number(item.start), e2 = Number(item.end);
    if (!isFinite(s) || !isFinite(e2)) continue;
    s = clamp(s, 0, Math.max(0, state.duration - 5));
    e2 = clamp(e2, s + 5, Math.min(state.duration, s + clipLen));
    if (e2 - s < 5) continue;
    out.push({
      start: s, end: e2,
      score: clamp(Math.round(Number(item.score) || 50), 0, 100),
      title: String(item.title || hookTitleFor(s)).slice(0, 80),
      reason: String(item.reason || "Picked by the AI brain."),
      source: "ai",
    });
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

/* ---------- link download (honest: static page cannot do this alone) ---------- */
async function tryLinkDownload(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) { setStatus("Paste a YouTube or TikTok link first.", "error"); return; }
  setStatus("Trying the public download service for that link…");
  const endpoints = ["https://co.api.dev/api/json", "https://api.cobalt.tools/api/json"];
  let directUrl = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.url) { directUrl = data.url; break; }
    } catch (e) { /* try next endpoint, then fall through to the honest message */ }
  }
  if (!directUrl) {
    setStatus("Link download did not work here: a static page cannot download YouTube/TikTok directly, and the public download service did not return a file. Download the video yourself and upload the file below — that path works fully in your browser.", "error");
    return;
  }
  try {
    const res = await fetch(directUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (!blob || blob.size < 10000) throw new Error("empty file");
    const name = "downloaded-video.mp4";
    const file = new File([blob], name, { type: blob.type || "video/mp4" });
    setStatus("Link downloaded (" + (blob.size / 1048576).toFixed(1) + " MB). Now press Analyse video.", "ok");
    loadVideoFile(file);
  } catch (e) {
    setStatus("The download service gave a link, but this browser could not fetch the file from it (blocked by the video host). Download the video yourself and upload the file below — that path works fully in your browser.", "error");
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
    const saved = loadKey();
    if (!saved || !saved.key) {
      setStatus("Cut using AI needs your API key — add it in AI settings above. Or switch to Full Cut, which works without a key.", "error");
      return;
    }
    setStatus("Local moments found. Asking the AI brain to re-rank them…");
    const localTop = rankLocalClips(Math.min(12, count * 4), clipLen);
    try {
      const aiClips = await callAI(localTop, count, clipLen);
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
      setStatus("AI ranking done — " + clips.length + " clip" + (clips.length === 1 ? "" : "s") + " ranked. Tick the ones you want, then press Make clips.", "ok");
    } catch (e) {
      if (e && e.message === "NO_KEY") {
        setStatus("Cut using AI needs your API key — add it in AI settings above.", "error");
        return;
      }
      // Honest fallback: AI failed, local scoring still gives clips.
      state.clips = rankLocalClips(count, clipLen);
      renderClips();
      setStatus("AI call failed (" + (e && e.message ? e.message : "unknown error") + ") — fell back to Full Cut local scoring. Your clips are ranked below.", "error");
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
refreshKeyState();
