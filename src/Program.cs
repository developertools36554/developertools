// ViralClips v2 - OWN code, written from scratch. Fully own work, no third-party clip engine.
// Paste a YouTube / TikTok link (or pick a local file). The app downloads the video
// with bundled yt-dlp, reads it FAST with ffprobe + ffmpeg audio analysis, and cuts
// the best moments to 9:16 vertical clips with burned captions.
// TWO CUT MODES (pick at the top of the window):
//   1. Full Cut - local own scoring (speech, loudness, hook words, captions).
//      No key needed. Exactly what v1 did.
//   2. Cut using AI - the AI brain (YOUR OWN Gemini / OpenAI / Groq key from
//      Settings) reads the transcript + loudness data and picks the moments most
//      likely to hold a stranger's attention. No key = clear message + Full Cut
//      fallback. Any AI failure falls back to local scoring, and the app says so.
// Only clip your own videos or ones you have permission to use.
// No score can guarantee a clip will go viral - it only ranks the moments
// most likely to hold a stranger's attention.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ViralClips")]
[assembly: System.Reflection.AssemblyDescription("Turn long videos into vertical viral clips. Own code.")]
[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.0.0")]

namespace ViralClips
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    // One subtitle cue from a .vtt / .srt file.
    public class VttCue
    {
        public double Start;
        public double End;
        public string Text;
    }

    // One candidate clip.
    public class Clip
    {
        public double Start;
        public double Length;
        public int Score;
        public string Title;
        public string Hook;
        public string Reason;
    }

    // A speech (non-silence) stretch, from ffmpeg silencedetect.
    public class SpeechSpan
    {
        public double Start;
        public double End;
    }

    // ------------------------------------------------------------------
    // Viral scoring — own formula, documented in README.txt.
    // Score is 0-100:
    //   speech density (how much of the window is actual speech) .. 40 pts
    //   word rate (fast, dense talking) ........................... 20 pts
    //   hook in the first 2 seconds (question / number / ! / hook word) .. 20 pts
    //   keyword hits in the whole window .......................... 10 pts
    //   clean start (window starts right on a speech start) .......  5 pts
    //   early position (in the first 20% of the video) ............  5 pts
    // ------------------------------------------------------------------
    public static class ViralScorer
    {
        public static readonly string[] HookWords = new string[]
        {
            "secret", "shocking", "shocked", "free", "best", "never", "stop",
            "amazing", "insane", "truth", "mistake", "hack", "unbelievable",
            "warning", "urgent", "new", "first", "worst", "amazing", "crazy",
            "hidden", "real", "exposed", "viral", "win", "lose", "money",
            "easy", "fast", "huge", "biggest", "why", "how"
        };

        public static readonly string[] QuestionWords = new string[]
        {
            "what", "why", "how", "when", "where", "which", "who", "can you",
            "did you", "do you", "have you", "is it", "are you"
        };

        public static string CleanText(string s)
        {
            if (s == null) return "";
            string t = Regex.Replace(s, "<[^>]+>", " ");
            t = Regex.Replace(t, "\\s+", " ").Trim();
            return t;
        }

        public static List<VttCue> ParseVtt(string path)
        {
            var cues = new List<VttCue>();
            if (!File.Exists(path)) return cues;
            string[] lines;
            try { lines = File.ReadAllLines(path); } catch { return cues; }
            int i = 0;
            while (i < lines.Length)
            {
                string line = lines[i].Trim();
                if (line.IndexOf("-->") >= 0)
                {
                    string[] parts = line.Split(new string[] { "-->" }, StringSplitOptions.None);
                    if (parts.Length == 2)
                    {
                        double st, en;
                        if (TryParseTime(parts[0].Trim(), out st) && TryParseTime(parts[1].Trim(), out en))
                        {
                            var sb = new StringBuilder();
                            i++;
                            while (i < lines.Length && lines[i].Trim().Length > 0)
                            {
                                if (sb.Length > 0) sb.Append(" ");
                                sb.Append(lines[i].Trim());
                                i++;
                            }
                            string text = CleanText(sb.ToString());
                            if (text.Length > 0)
                                cues.Add(new VttCue { Start = st, End = en, Text = text });
                            continue;
                        }
                    }
                }
                i++;
            }
            return cues;
        }

        public static bool TryParseTime(string s, out double seconds)
        {
            seconds = 0;
            s = s.Trim();
            // Strip trailing cue settings after the time.
            int sp = s.IndexOf(' ');
            if (sp > 0) s = s.Substring(0, sp);
            string[] parts = s.Split(':');
            try
            {
                if (parts.Length == 3)
                {
                    seconds = double.Parse(parts[0], CultureInfo.InvariantCulture) * 3600
                        + double.Parse(parts[1], CultureInfo.InvariantCulture) * 60
                        + double.Parse(parts[2], CultureInfo.InvariantCulture);
                    return true;
                }
                if (parts.Length == 2)
                {
                    seconds = double.Parse(parts[0], CultureInfo.InvariantCulture) * 60
                        + double.Parse(parts[1], CultureInfo.InvariantCulture);
                    return true;
                }
            }
            catch { return false; }
            return false;
        }

        public static string FormatTime(double seconds)
        {
            TimeSpan t = TimeSpan.FromSeconds(seconds);
            return string.Format(CultureInfo.InvariantCulture, "{0:D2}:{1:D2}:{2:D2}.{3:D3}",
                (int)t.TotalHours, t.Minutes, t.Seconds, t.Milliseconds);
        }

        public static string CuesInWindow(List<VttCue> cues, double start, double end)
        {
            var sb = new StringBuilder();
            foreach (VttCue c in cues)
            {
                if (c.End > start && c.Start < end)
                {
                    if (sb.Length > 0) sb.Append(" ");
                    sb.Append(c.Text);
                }
            }
            return sb.ToString();
        }

        public static int CountWord(string text, string word)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int n = 0;
            int idx = 0;
            string low = text.ToLowerInvariant();
            while ((idx = low.IndexOf(word, idx, StringComparison.Ordinal)) >= 0)
            {
                n++;
                idx += word.Length;
            }
            return n;
        }

        public static int HookScore(string hookText)
        {
            if (string.IsNullOrEmpty(hookText)) return 0;
            string low = hookText.ToLowerInvariant();
            int s = 0;
            foreach (string q in QuestionWords)
                if (low.IndexOf(q, StringComparison.Ordinal) >= 0) { s += 10; break; }
            if (Regex.IsMatch(low, "\\d")) s += 8;
            if (hookText.IndexOf('!') >= 0) s += 8;
            foreach (string w in HookWords)
                if (low.IndexOf(w, StringComparison.Ordinal) >= 0) { s += 6; break; }
            if (s > 20) s = 20;
            return s;
        }

        public static int KeywordScore(string text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            string low = text.ToLowerInvariant();
            int hits = 0;
            foreach (string w in HookWords)
                if (low.IndexOf(w, StringComparison.Ordinal) >= 0) hits++;
            int s = hits * 2;
            if (s > 10) s = 10;
            return s;
        }

        public static double SpeechSeconds(List<SpeechSpan> spans, double start, double end)
        {
            double total = 0;
            foreach (SpeechSpan sp in spans)
            {
                double a = Math.Max(start, sp.Start);
                double b = Math.Min(end, sp.End);
                if (b > a) total += (b - a);
            }
            return total;
        }

        public static string MakeTitle(string text, double start)
        {
            string t = CleanText(text);
            if (t.Length == 0)
                return "Moment at " + FormatTime(start).Substring(0, 8);
            if (t.Length > 70)
            {
                int cut = t.LastIndexOf(' ', 70);
                if (cut > 20) t = t.Substring(0, cut);
                else t = t.Substring(0, 70);
                t += "...";
            }
            return t;
        }

        // Build ranked candidate clips. step = half the clip length.
        public static List<Clip> ScoreWindows(double duration, double clipLen,
            List<SpeechSpan> spans, List<VttCue> cues)
        {
            var scored = new List<Clip>();
            if (duration <= 0) return scored;
            double len = Math.Min(clipLen, duration);
            double step = Math.Max(5, len / 2);
            for (double start = 0; start + 5 <= duration; start += step)
            {
                double end = Math.Min(duration, start + len);
                double winLen = end - start;
                if (winLen < 5) break;
                double speechSec = SpeechSeconds(spans, start, end);
                double density = winLen > 0 ? speechSec / winLen : 0;
                string text = CuesInWindow(cues, start, end);
                string hookText = CuesInWindow(cues, start, Math.Min(end, start + 2));
                int wordCount = 0;
                if (text.Length > 0)
                    wordCount = text.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Length;
                double wps = winLen > 0 ? wordCount / winLen : 0;
                int score = 0;
                score += (int)Math.Round(density * 40);
                score += (int)Math.Round(Math.Min(1.0, wps / 3.0) * 20);
                score += HookScore(hookText);
                score += KeywordScore(text);
                bool cleanStart = false;
                foreach (SpeechSpan sp in spans)
                    if (Math.Abs(sp.Start - start) < 1.0) { cleanStart = true; break; }
                if (cleanStart) score += 5;
                if (duration > 0 && start < duration * 0.2) score += 5;
                if (score > 100) score = 100;
                string title = MakeTitle(hookText.Length > 0 ? hookText : text, start);
                string reason = string.Format(CultureInfo.InvariantCulture,
                    "speech {0}% - {1} words - hook {2}/20",
                    (int)Math.Round(density * 100), wordCount, HookScore(hookText));
                scored.Add(new Clip { Start = start, Length = winLen, Score = score, Title = title, Hook = hookText, Reason = reason });
            }
            scored.Sort(delegate(Clip a, Clip b) { return b.Score.CompareTo(a.Score); });
            return scored;
        }

        // Pick top N non-overlapping windows (overlap < 50% of the shorter one).
        public static List<Clip> PickTop(List<Clip> ranked, int count)
        {
            var picked = new List<Clip>();
            foreach (Clip c in ranked)
            {
                if (picked.Count >= count) break;
                bool overlap = false;
                foreach (Clip p in picked)
                {
                    double a = Math.Max(c.Start, p.Start);
                    double b = Math.Min(c.Start + c.Length, p.Start + p.Length);
                    double ov = b > a ? (b - a) : 0;
                    if (ov > Math.Min(c.Length, p.Length) * 0.5) { overlap = true; break; }
                }
                if (!overlap) picked.Add(c);
            }
            picked.Sort(delegate(Clip a, Clip b) { return a.Start.CompareTo(b.Start); });
            return picked;
        }

        // Write a per-clip .srt: hook title as the first cue, then transcript cues
        // shifted so the clip starts at 0.
        public static void WriteClipSrt(string path, Clip clip, List<VttCue> cues)
        {
            var sb = new StringBuilder();
            int n = 1;
            string hook = string.IsNullOrEmpty(clip.Title) ? "" : clip.Title;
            sb.Append(n++).Append("\r\n");
            sb.Append("00:00:00,000 --> 00:00:02,500\r\n");
            sb.Append(hook.Replace("\r", " ").Replace("\n", " ")).Append("\r\n\r\n");
            foreach (VttCue c in cues)
            {
                if (c.End <= clip.Start || c.Start >= clip.Start + clip.Length) continue;
                double s = Math.Max(0, c.Start - clip.Start);
                double e = Math.Min(clip.Length, c.End - clip.Start);
                if (e - s < 0.2) continue;
                sb.Append(n++).Append("\r\n");
                sb.Append(SrtTime(s)).Append(" --> ").Append(SrtTime(e)).Append("\r\n");
                sb.Append(c.Text.Replace("\r", " ").Replace("\n", " ")).Append("\r\n\r\n");
            }
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        public static string SrtTime(double seconds)
        {
            TimeSpan t = TimeSpan.FromSeconds(seconds);
            return string.Format(CultureInfo.InvariantCulture, "{0:D2}:{1:D2}:{2:D2},{3:D3}",
                (int)t.TotalHours, t.Minutes, t.Seconds, t.Milliseconds);
        }

        public static string EscapeJson(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
        }
    }


    // ------------------------------------------------------------------
    // Cut using AI - the AI brain (user's own key: Gemini / OpenAI / Groq).
    // Own code. The AI is asked for JSON only, the reply is parsed
    // defensively, timestamps are clamped inside the video and picks are
    // de-overlapped. Any failure falls back to local scoring - the app
    // always says so plainly. Never hardcode a key. No score can
    // guarantee a clip will go viral.
    // ------------------------------------------------------------------
    public static class AiBrain
    {
        // The prompt: transcript + loudness/energy data, JSON-only reply.
        public static string BuildPrompt(List<VttCue> cues, List<SpeechSpan> spans,
            double duration, double clipLen, int count)
        {
            var sb = new StringBuilder();
            sb.Append("You are a short-video editor. A video is ")
              .Append(((int)Math.Round(duration))).Append(" seconds long. Below is its transcript with timestamps")
              .Append(" and its loudness/energy data (speech % per part). Pick the moments most likely")
              .Append(" to hold a stranger's attention and make them keep watching - a strong hook in")
              .Append(" the first 2 seconds (a question, a shocking word, a number, a bold claim),")
              .Append(" dense fast speech, and a clear payoff.\n");
            var tr = new StringBuilder();
            foreach (VttCue c in cues)
            {
                if (tr.Length > 12000) break;
                tr.Append("[").Append(ViralScorer.FormatTime(c.Start).Substring(0, 8)).Append("] ")
                  .Append(c.Text).Append(" ");
            }
            if (tr.Length > 20)
                sb.Append("TRANSCRIPT:\n").Append(tr.ToString()).Append("\n");
            else
                sb.Append("TRANSCRIPT: none available - use the energy data only.\n");
            int buckets = (int)Math.Min(12, Math.Max(1, Math.Ceiling(duration / 30.0)));
            double bw = duration / buckets;
            sb.Append("ENERGY (speech % per part): ");
            for (int i = 0; i < buckets; i++)
            {
                double a = i * bw, b = Math.Min(duration, (i + 1) * bw);
                double pct = ViralScorer.SpeechSeconds(spans, a, b) / Math.Max(1.0, (b - a)) * 100;
                sb.Append(string.Format(CultureInfo.InvariantCulture, "{0}-{1}s {2}%, ",
                    (int)Math.Round(a), (int)Math.Round(b), (int)Math.Round(pct)));
            }
            sb.Append("\n");
            sb.Append("RULES: reply with ONLY a JSON array, no other text, no markdown. Each item must be exactly: ")
              .Append("{\"start_sec\": <number>, \"end_sec\": <number>, \"score\": 0-100, ")
              .Append("\"title\": \"short hook title\", \"reason\": \"one short sentence\"}. ")
              .Append("Pick at most ").Append(count + 2).Append(" moments. start_sec must be >= 0 and end_sec <= ")
              .Append(((int)Math.Round(duration))).Append(". A moment is at most ").Append(((int)clipLen))
              .Append(" seconds long. Score = how likely a stranger keeps watching (100 = strongest hook).");
            return sb.ToString();
        }

        // Pull the JSON array out of a provider reply (the array sits inside
        // a JSON string value, so brackets are plain text in the raw body).
        public static string ExtractJsonArray(string resp)
        {
            if (string.IsNullOrEmpty(resp)) return null;
            int a = resp.IndexOf('[');
            int b = resp.LastIndexOf(']');
            if (a < 0 || b <= a) return null;
            string s2 = resp.Substring(a, b - a + 1);
            s2 = s2.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", " ").Replace("\\t", " ");
            return s2;
        }

        private static bool TryNumber(string obj, string name, out double value)
        {
            value = 0;
            Match m = Regex.Match(obj, "\"" + name + "\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)");
            if (!m.Success) return false;
            return double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        private static bool TryString(string obj, string name, out string value)
        {
            value = "";
            Match m = Regex.Match(obj, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return false;
            value = m.Groups[1].Value.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", " ");
            return true;
        }

        // Defensive parse: clamp/validate every timestamp inside the video,
        // clamp scores 0-100, drop unusable items, sort best-first.
        public static List<Clip> ParseAiMoments(string json, double duration, double clipLen)
        {
            var clips = new List<Clip>();
            if (string.IsNullOrEmpty(json) || duration <= 5) return clips;
            string arr = ExtractJsonArray(json);
            if (arr == null) return clips;
            foreach (Match m in Regex.Matches(arr, "\\{[^\\}]*\\}"))
            {
                string obj = m.Value;
                double st, en, sc;
                if (!TryNumber(obj, "start_sec", out st) && !TryNumber(obj, "start", out st)) continue;
                if (!TryNumber(obj, "end_sec", out en) && !TryNumber(obj, "end", out en)) en = st + clipLen;
                int score = TryNumber(obj, "score", out sc) ? (int)Math.Round(sc) : 70;
                string title, reason;
                if (!TryString(obj, "title", out title))
                    TryString(obj, "hook", out title);
                TryString(obj, "reason", out reason);
                st = Math.Max(0, Math.Min(st, duration - 5));
                en = Math.Max(st + 5, Math.Min(en, duration));
                if (en - st > clipLen) en = st + clipLen;
                if (en > duration) en = duration;
                if (en - st < 5) continue;
                if (score < 0) score = 0;
                if (score > 100) score = 100;
                title = ViralScorer.CleanText(title);
                if (title.Length == 0)
                    title = "AI moment at " + ViralScorer.FormatTime(st).Substring(0, 8);
                if (title.Length > 70) title = title.Substring(0, 70);
                clips.Add(new Clip
                {
                    Start = st,
                    Length = en - st,
                    Score = score,
                    Title = title,
                    Hook = title,
                    Reason = "AI: " + (reason.Length > 0 ? reason : "picked by the AI brain")
                });
            }
            clips.Sort(delegate(Clip a, Clip b) { return b.Score.CompareTo(a.Score); });
            return clips;
        }

        // One AI call. Returns true + de-overlapped clips, or false + error.
        // No key, no usable reply, or any request failure all return false -
        // the caller falls back to Full Cut local scoring and says so.
        public static bool CallAi(List<VttCue> cues, List<SpeechSpan> spans, double duration,
            double clipLen, int count, out List<Clip> clips, out string error)
        {
            clips = null;
            error = "";
            AiSettings s = AiSettings.Load();
            if (string.IsNullOrEmpty(s.ApiKey) || string.IsNullOrEmpty(s.Provider))
            {
                error = "no AI key set - add your key in AI Settings";
                return false;
            }
            try
            {
                string prompt = BuildPrompt(cues, spans, duration, clipLen, count);
                string url, body;
                bool bearer = true;
                if (s.Provider == "gemini")
                {
                    string model = string.IsNullOrEmpty(s.Model) ? "gemini-2.5-flash" : s.Model;
                    url = "https://generativelanguage.googleapis.com/v1beta/models/" + Uri.EscapeDataString(model)
                        + ":generateContent?key=" + Uri.EscapeDataString(s.ApiKey);
                    body = "{\"contents\":[{\"parts\":[{\"text\":\"" + ViralScorer.EscapeJson(prompt) + "\"}]}]}";
                    bearer = false;
                }
                else
                {
                    string model = string.IsNullOrEmpty(s.Model) ? "gpt-4o-mini" : s.Model;
                    url = s.Provider == "groq" ? "https://api.groq.com/openai/v1/chat/completions"
                        : "https://api.openai.com/v1/chat/completions";
                    body = "{\"model\":\"" + ViralScorer.EscapeJson(model) + "\",\"messages\":["
                        + "{\"role\":\"user\",\"content\":\"" + ViralScorer.EscapeJson(prompt) + "\"}]}";
                }
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 60000;
                if (bearer) req.Headers["Authorization"] = "Bearer " + s.ApiKey;
                byte[] bytes = new UTF8Encoding(false).GetBytes(body);
                req.ContentLength = bytes.Length;
                using (Stream st = req.GetRequestStream()) { st.Write(bytes, 0, bytes.Length); }
                string resp;
                using (var r = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(r.GetResponseStream()))
                { resp = sr.ReadToEnd(); }
                List<Clip> parsed = ParseAiMoments(resp, duration, clipLen);
                if (parsed.Count == 0)
                {
                    error = "the AI returned no usable moments";
                    return false;
                }
                clips = ViralScorer.PickTop(parsed, count);
                if (clips.Count == 0)
                {
                    error = "the AI moments overlapped too much";
                    return false;
                }
                return true;
            }
            catch (WebException wex)
            {
                string msg = wex.Message;
                try
                {
                    HttpWebResponse wr = wex.Response as HttpWebResponse;
                    if (wr != null)
                    {
                        using (var sr = new StreamReader(wr.GetResponseStream()))
                        {
                            string b = sr.ReadToEnd();
                            if (b.Length > 200) b = b.Substring(0, 200);
                            if (b.Length > 0) msg += " - " + b;
                        }
                    }
                }
                catch { }
                error = "AI request failed: " + msg;
                return false;
            }
            catch (Exception ex)
            {
                error = "AI request failed: " + ex.Message;
                return false;
            }
        }
    }

    // Settings file next to the exe: provider, model, api key (never hardcoded).
    public class AiSettings
    {
        public string Provider = "";
        public string Model = "";
        public string ApiKey = "";

        public static string SettingsPath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ViralClips.settings.txt");
        }

        public static AiSettings Load()
        {
            var s = new AiSettings();
            try
            {
                if (!File.Exists(SettingsPath())) return s;
                foreach (string line in File.ReadAllLines(SettingsPath()))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();
                    string v = line.Substring(eq + 1).Trim();
                    if (k == "provider") s.Provider = v;
                    else if (k == "model") s.Model = v;
                    else if (k == "apikey") s.ApiKey = v;
                }
            }
            catch { }
            return s;
        }

        public void Save()
        {
            try
            {
                File.WriteAllText(SettingsPath(),
                    "provider=" + Provider + "\r\nmodel=" + Model + "\r\napikey=" + ApiKey + "\r\n",
                    new UTF8Encoding(false));
            }
            catch { }
        }

        public string MaskedKey()
        {
            if (string.IsNullOrEmpty(ApiKey)) return "(not set)";
            if (ApiKey.Length <= 4) return "****";
            return "****" + ApiKey.Substring(ApiKey.Length - 4);
        }
    }

    // ------------------------------------------------------------------
    // Main window.
    // ------------------------------------------------------------------
    public class MainForm : Form
    {
        private TextBox txtLink;
        private TextBox txtVideo;
        private Button btnBrowseFile;
        private Button btnAnalyse;
        private Button btnMakeClips;
        private Button btnCancel;
        private Button btnOpenFolder;
        private Button btnSettings;
        private ComboBox cboClipLen;
        private NumericUpDown numClipCount;
        private TextBox txtOut;
        private Button btnOut;
        private ProgressBar bar;
        private Label lblStatus;
        private Label lblInfo;
        private Label lblEta;
        private ListView lstClips;
        private Label lblAi;

        private BackgroundWorker worker;
        private Process currentProcess;
        private volatile bool cancelRequested;
        private string phase; // "analyse" or "render"
        private string videoPath;
        private string downloadDir;
        private double totalSeconds;
        private double maxVolumeDb;
        private List<SpeechSpan> speechSpans;
        private List<VttCue> cues;
        private List<Clip> foundClips;
        private string outDir;
        private string baseName;
        private DateTime startedAt;
        private string lastError;
        private string aiNote;
        private RadioButton rbFullCut;
        private RadioButton rbAiCut;
        private Label lblMode;
        private int cutMode; // 0 = Full Cut (local scoring), 1 = Cut using AI

        private string ExeDir { get { return AppDomain.CurrentDomain.BaseDirectory; } }
        private string FfmpegPath { get { return Path.Combine(ExeDir, "ffmpeg.exe"); } }
        private string FfprobePath { get { return Path.Combine(ExeDir, "ffprobe.exe"); } }
        private string YtDlpPath { get { return Path.Combine(ExeDir, "yt-dlp.exe"); } }

        public MainForm()
        {
            Text = "ViralClips v2 - Own AI Clips";
            Size = new Size(660, 880);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Font = new Font("Segoe UI", 10);
            speechSpans = new List<SpeechSpan>();
            cues = new List<VttCue>();
            foundClips = new List<Clip>();
            maxVolumeDb = -99;
            aiNote = "";

            int x = 20, w = 600, y = 14;
            var lblTitle = new Label();
            lblTitle.Text = "ViralClips";
            lblTitle.Font = new Font("Segoe UI", 16, FontStyle.Bold);
            lblTitle.Location = new Point(x, y); lblTitle.Size = new Size(w, 30);
            Controls.Add(lblTitle); y += 30;
            var lblSub = new Label();
            lblSub.Text = "Paste a link, find the viral moments, cut 9:16 clips. Fully own code.";
            lblSub.ForeColor = Color.DimGray;
            lblSub.Location = new Point(x, y); lblSub.Size = new Size(w, 22);
            Controls.Add(lblSub); y += 32;

            // ---- Cut mode: two big clear options at the top ----
            var grpMode = new GroupBox();
            grpMode.Text = "How do you want to cut?";
            grpMode.Font = new Font("Segoe UI", 11, FontStyle.Bold);
            grpMode.Location = new Point(x, y); grpMode.Size = new Size(w, 122);
            Controls.Add(grpMode); y += 132;
            rbFullCut = new RadioButton();
            rbFullCut.Text = "Full Cut - all the best moments";
            rbFullCut.Font = new Font("Segoe UI", 11, FontStyle.Bold);
            rbFullCut.Location = new Point(14, 24); rbFullCut.Size = new Size(560, 24);
            rbFullCut.Checked = true;
            rbFullCut.CheckedChanged += Mode_CheckedChanged;
            grpMode.Controls.Add(rbFullCut);
            var lblFullDesc = new Label();
            lblFullDesc.Text = "Local scoring only, no key needed. Speech, loudness, hook words and captions rank every moment - like v1.";
            lblFullDesc.ForeColor = Color.DimGray;
            lblFullDesc.Location = new Point(34, 48); lblFullDesc.Size = new Size(550, 18);
            grpMode.Controls.Add(lblFullDesc);
            rbAiCut = new RadioButton();
            rbAiCut.Text = "Cut using AI - the AI brain picks the moments";
            rbAiCut.Font = new Font("Segoe UI", 11, FontStyle.Bold);
            rbAiCut.Location = new Point(14, 70); rbAiCut.Size = new Size(560, 24);
            rbAiCut.CheckedChanged += Mode_CheckedChanged;
            grpMode.Controls.Add(rbAiCut);
            var lblAiDesc = new Label();
            lblAiDesc.Text = "Sends the transcript + loudness data to YOUR key (Gemini / OpenAI / Groq). Needs a key in AI Settings.";
            lblAiDesc.ForeColor = Color.DimGray;
            lblAiDesc.Location = new Point(34, 94); lblAiDesc.Size = new Size(550, 18);
            grpMode.Controls.Add(lblAiDesc);

            AddLabel("YouTube / TikTok link:", y); y += 24;
            txtLink = new TextBox();
            txtLink.Location = new Point(x, y); txtLink.Size = new Size(w, 26);
            txtLink.Text = "";
            Controls.Add(txtLink); y += 36;

            AddLabel("...or a video file on this computer:", y); y += 24;
            txtVideo = new TextBox();
            txtVideo.Location = new Point(x, y); txtVideo.Size = new Size(470, 26);
            txtVideo.ReadOnly = true;
            Controls.Add(txtVideo);
            btnBrowseFile = new Button();
            btnBrowseFile.Text = "Browse file...";
            btnBrowseFile.Location = new Point(500, y - 2); btnBrowseFile.Size = new Size(120, 28);
            btnBrowseFile.Click += BtnBrowseFile_Click;
            Controls.Add(btnBrowseFile); y += 42;

            lblInfo = new Label();
            lblInfo.Text = "No video yet. Paste a link or pick a file, then press Download + Analyse.";
            lblInfo.ForeColor = Color.DimGray;
            lblInfo.Location = new Point(x, y); lblInfo.Size = new Size(w, 22);
            Controls.Add(lblInfo); y += 32;

            AddLabel("Clip length:", y); y += 24;
            cboClipLen = new ComboBox();
            cboClipLen.Location = new Point(x, y); cboClipLen.Size = new Size(110, 26);
            cboClipLen.DropDownStyle = ComboBoxStyle.DropDownList;
            cboClipLen.Items.AddRange(new object[] { "30 seconds", "45 seconds", "60 seconds" });
            cboClipLen.SelectedIndex = 1;
            Controls.Add(cboClipLen);
            var lblCount = new Label();
            lblCount.Text = "How many clips:";
            lblCount.Location = new Point(230, y + 3); lblCount.Size = new Size(120, 22);
            Controls.Add(lblCount);
            numClipCount = new NumericUpDown();
            numClipCount.Location = new Point(360, y); numClipCount.Size = new Size(70, 26);
            numClipCount.Minimum = 1; numClipCount.Maximum = 10; numClipCount.Value = 3;
            Controls.Add(numClipCount);
            btnSettings = new Button();
            btnSettings.Text = "AI Settings...";
            btnSettings.Location = new Point(450, y - 2); btnSettings.Size = new Size(170, 28);
            btnSettings.Click += BtnSettings_Click;
            Controls.Add(btnSettings); y += 44;

            lblAi = new Label();
            lblAi.Text = "AI key: not set.";
            lblAi.ForeColor = Color.DimGray;
            lblAi.Location = new Point(x, y); lblAi.Size = new Size(w, 22);
            Controls.Add(lblAi); y += 24;
            lblMode = new Label();
            lblMode.Text = "Mode: Full Cut.";
            lblMode.ForeColor = Color.DimGray;
            lblMode.Location = new Point(x, y); lblMode.Size = new Size(w, 22);
            Controls.Add(lblMode); y += 30;

            btnAnalyse = new Button();
            btnAnalyse.Text = "Download + Analyse";
            btnAnalyse.Font = new Font("Segoe UI", 11, FontStyle.Bold);
            btnAnalyse.Location = new Point(x, y); btnAnalyse.Size = new Size(190, 38);
            btnAnalyse.Click += BtnAnalyse_Click;
            Controls.Add(btnAnalyse);
            btnMakeClips = new Button();
            btnMakeClips.Text = "Make Clips";
            btnMakeClips.Font = new Font("Segoe UI", 11, FontStyle.Bold);
            btnMakeClips.Location = new Point(220, y); btnMakeClips.Size = new Size(150, 38);
            btnMakeClips.Enabled = false;
            btnMakeClips.Click += BtnMakeClips_Click;
            Controls.Add(btnMakeClips);
            btnCancel = new Button();
            btnCancel.Text = "Cancel";
            btnCancel.Location = new Point(380, y); btnCancel.Size = new Size(100, 38);
            btnCancel.Enabled = false;
            btnCancel.Click += BtnCancel_Click;
            Controls.Add(btnCancel);
            btnOpenFolder = new Button();
            btnOpenFolder.Text = "Open Output";
            btnOpenFolder.Location = new Point(490, y); btnOpenFolder.Size = new Size(130, 38);
            btnOpenFolder.Enabled = false;
            btnOpenFolder.Click += BtnOpenFolder_Click;
            Controls.Add(btnOpenFolder); y += 50;

            AddLabel("Best moments found (tick the ones to cut):", y); y += 24;
            lstClips = new ListView();
            lstClips.Location = new Point(x, y); lstClips.Size = new Size(w, 150);
            lstClips.View = View.Details;
            lstClips.CheckBoxes = true;
            lstClips.FullRowSelect = true;
            lstClips.Columns.Add("Pick", 46);
            lstClips.Columns.Add("Start", 80);
            lstClips.Columns.Add("Score", 60);
            lstClips.Columns.Add("Hook / title", 400);
            Controls.Add(lstClips); y += 162;

            AddLabel("Output folder (leave blank = video folder \\ clips):", y); y += 24;
            txtOut = new TextBox();
            txtOut.Location = new Point(x, y); txtOut.Size = new Size(470, 26);
            Controls.Add(txtOut);
            btnOut = new Button();
            btnOut.Text = "Browse...";
            btnOut.Location = new Point(500, y - 2); btnOut.Size = new Size(120, 28);
            btnOut.Click += BtnOut_Click;
            Controls.Add(btnOut); y += 46;

            bar = new ProgressBar();
            bar.Location = new Point(x, y); bar.Size = new Size(w, 20);
            bar.Style = ProgressBarStyle.Continuous;
            Controls.Add(bar); y += 28;
            lblStatus = new Label();
            lblStatus.Text = "Ready.";
            lblStatus.Location = new Point(x, y); lblStatus.Size = new Size(w, 22);
            Controls.Add(lblStatus); y += 24;
            lblEta = new Label();
            lblEta.Text = "Only clip your own videos or ones you have permission to use. No clip is guaranteed to go viral.";
            lblEta.ForeColor = Color.DimGray;
            lblEta.Location = new Point(x, y); lblEta.Size = new Size(w, 36);
            Controls.Add(lblEta);

            RefreshAiLabel();
            worker = new BackgroundWorker();
            worker.WorkerReportsProgress = true;
            worker.WorkerSupportsCancellation = true;
            worker.DoWork += Worker_DoWork;
            worker.ProgressChanged += Worker_ProgressChanged;
            worker.RunWorkerCompleted += Worker_RunWorkerCompleted;
        }

        private void RefreshAiLabel()
        {
            AiSettings s = AiSettings.Load();
            bool hasKey = !string.IsNullOrEmpty(s.ApiKey) && !string.IsNullOrEmpty(s.Provider);
            lblAi.Text = hasKey
                ? "AI key: ON (" + s.Provider + " / " + s.Model + ", key " + s.MaskedKey() + ")."
                : "AI key: not set. Cut using AI needs a key - add one in AI Settings.";
            if (lblMode != null)
            {
                string mode = (rbAiCut != null && rbAiCut.Checked) ? "Cut using AI" : "Full Cut";
                lblMode.Text = "Mode: " + mode
                    + ((mode == "Cut using AI" && !hasKey) ? " - no key set yet, add it in AI Settings or use Full Cut." : ".");
            }
        }

        private void Mode_CheckedChanged(object sender, EventArgs e)
        {
            RefreshAiLabel();
        }

        private void AddLabel(string text, int top)
        {
            var l = new Label();
            l.Text = text;
            l.Location = new Point(20, top);
            l.Size = new Size(600, 22);
            Controls.Add(l);
        }

        private void BtnBrowseFile_Click(object sender, EventArgs e)
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Filter = "Video files|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.wmv;*.flv|All files|*.*";
                dlg.Title = "Choose a video";
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    txtVideo.Text = dlg.FileName;
                    txtLink.Text = "";
                    lblInfo.Text = "File picked: " + Path.GetFileName(dlg.FileName);
                }
            }
        }

        private void BtnOut_Click(object sender, EventArgs e)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Choose the output folder";
                if (dlg.ShowDialog() == DialogResult.OK)
                    txtOut.Text = dlg.SelectedPath;
            }
        }

        private void BtnOpenFolder_Click(object sender, EventArgs e)
        {
            if (!string.IsNullOrEmpty(outDir) && Directory.Exists(outDir))
                try { Process.Start("explorer.exe", "\"" + outDir + "\""); } catch { }
        }

        private void BtnSettings_Click(object sender, EventArgs e)
        {
            using (var dlg = new SettingsForm())
            {
                dlg.ShowDialog();
            }
            RefreshAiLabel();
        }

        private void BtnCancel_Click(object sender, EventArgs e)
        {
            cancelRequested = true;
            try { worker.CancelAsync(); } catch { }
            try { if (currentProcess != null && !currentProcess.HasExited) currentProcess.Kill(); } catch { }
            lblStatus.Text = "Cancelling...";
            btnCancel.Enabled = false;
        }

        private double ClipLengthSeconds()
        {
            if (cboClipLen.SelectedIndex == 0) return 30;
            if (cboClipLen.SelectedIndex == 2) return 60;
            return 45;
        }

        // ---- process helpers ----

        private int RunTool(string exe, string args, string workDir, BackgroundWorker bg, string progressMsg)
        {
            var err = new StringBuilder();
            var psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            if (!string.IsNullOrEmpty(workDir)) psi.WorkingDirectory = workDir;
            using (var p = Process.Start(psi))
            {
                currentProcess = p;
                p.ErrorDataReceived += (s, ev) => { if (!string.IsNullOrEmpty(ev.Data)) { lock (err) { err.AppendLine(ev.Data); } } };
                p.BeginErrorReadLine();
                string line;
                while ((line = p.StandardOutput.ReadLine()) != null)
                {
                    if (cancelRequested || bg.CancellationPending)
                    {
                        try { if (!p.HasExited) p.Kill(); } catch { }
                        break;
                    }
                    if (bg != null && progressMsg != null && line.IndexOf("%") >= 0)
                        bg.ReportProgress(0, progressMsg + " " + line.Trim());
                }
                p.WaitForExit();
                currentProcess = null;
                if (p.ExitCode != 0)
                {
                    lock (err) { lastError = err.ToString().Trim(); }
                    if (lastError != null && lastError.Length > 600) lastError = lastError.Substring(0, 600);
                }
                return p.ExitCode;
            }
        }

        private string RunToolCapture(string exe, string args, string workDir)
        {
            var outSb = new StringBuilder();
            var errSb = new StringBuilder();
            var psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            if (!string.IsNullOrEmpty(workDir)) psi.WorkingDirectory = workDir;
            using (var p = Process.Start(psi))
            {
                currentProcess = p;
                p.OutputDataReceived += (s, ev) => { if (ev.Data != null) { lock (outSb) { outSb.AppendLine(ev.Data); } } };
                p.ErrorDataReceived += (s, ev) => { if (ev.Data != null) { lock (errSb) { errSb.AppendLine(ev.Data); } } };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                currentProcess = null;
            }
            return outSb.ToString() + "\n" + errSb.ToString();
        }

        private double ProbeDuration(string video)
        {
            try
            {
                string raw = RunToolCapture(FfprobePath,
                    "-v error -show_entries format=duration -of csv=p=0 \"" + video + "\"", null);
                string first = raw.Trim().Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0].Trim();
                double d;
                if (double.TryParse(first, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            }
            catch { }
            return 0;
        }

        // ffmpeg silencedetect: silence spans -> invert to speech spans.
        private List<SpeechSpan> DetectSpeech(string video, double duration)
        {
            var silences = new List<SpeechSpan>();
            string raw = RunToolCapture(FfmpegPath,
                "-i \"" + video + "\" -af silencedetect=noise=-35dB:d=0.5 -f null -", null);
            double? openStart = null;
            foreach (Match m in Regex.Matches(raw, "silence_(start|end):\\s*([0-9.]+)"))
            {
                double v = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                if (m.Groups[1].Value == "start") openStart = v;
                else if (openStart.HasValue)
                {
                    silences.Add(new SpeechSpan { Start = openStart.Value, End = v });
                    openStart = null;
                }
            }
            if (openStart.HasValue) silences.Add(new SpeechSpan { Start = openStart.Value, End = duration });
            var speech = new List<SpeechSpan>();
            double cursor = 0;
            foreach (SpeechSpan s in silences)
            {
                if (s.Start > cursor) speech.Add(new SpeechSpan { Start = cursor, End = s.Start });
                cursor = Math.Max(cursor, s.End);
            }
            if (cursor < duration) speech.Add(new SpeechSpan { Start = cursor, End = duration });
            if (speech.Count == 0) speech.Add(new SpeechSpan { Start = 0, End = duration });
            return speech;
        }

        private double DetectMaxVolume(string video)
        {
            string raw = RunToolCapture(FfmpegPath,
                "-i \"" + video + "\" -af volumedetect -f null -", null);
            Match m = Regex.Match(raw, "max_volume:\\s*(-?[0-9.]+)\\s*dB");
            if (m.Success)
            {
                double v;
                if (double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
            }
            return -99;
        }

        private string FindSubsFile(string dir)
        {
            try
            {
                foreach (string f in Directory.GetFiles(dir))
                {
                    string low = f.ToLowerInvariant();
                    if (low.EndsWith(".vtt") || low.EndsWith(".srt")) return f;
                }
            }
            catch { }
            return null;
        }

        private void BtnAnalyse_Click(object sender, EventArgs e)
        {
            if (!File.Exists(FfmpegPath) || !File.Exists(FfprobePath))
            {
                MessageBox.Show("ffmpeg.exe / ffprobe.exe was not found next to ViralClips.exe.\n\nKeep all files from the ZIP in the same folder and try again.",
                    "Missing file", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            string link = txtLink.Text.Trim();
            string file = txtVideo.Text.Trim();
            if (string.IsNullOrEmpty(link) && (string.IsNullOrEmpty(file) || !File.Exists(file)))
            {
                MessageBox.Show("Paste a YouTube / TikTok link or pick a video file first.", "No video",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!string.IsNullOrEmpty(link) && !File.Exists(YtDlpPath))
            {
                MessageBox.Show("yt-dlp.exe was not found next to ViralClips.exe.\n\nFor links, keep yt-dlp.exe in the same folder. (Picking a local file does not need it.)",
                    "Missing file", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            cutMode = (rbAiCut != null && rbAiCut.Checked) ? 1 : 0;
            if (cutMode == 1)
            {
                AiSettings s0 = AiSettings.Load();
                if (string.IsNullOrEmpty(s0.ApiKey) || string.IsNullOrEmpty(s0.Provider))
                {
                    DialogResult dr = MessageBox.Show(
                        "Cut using AI needs your own AI key (Gemini, OpenAI or Groq).\n\nAdd it in AI Settings, or press Yes to fall back to Full Cut (local scoring, no key needed).",
                        "AI key needed", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                    if (dr == DialogResult.Yes)
                    {
                        cutMode = 0;
                        rbFullCut.Checked = true;
                        RefreshAiLabel();
                    }
                    else return;
                }
            }
            phase = "analyse";
            cancelRequested = false;
            lastError = null;
            aiNote = "";
            analyseLink = txtLink.Text.Trim();
            analyseFile = txtVideo.Text.Trim();
            startedAt = DateTime.Now;
            btnAnalyse.Enabled = false;
            btnMakeClips.Enabled = false;
            btnCancel.Enabled = true;
            btnOpenFolder.Enabled = false;
            bar.Value = 0;
            lstClips.Items.Clear();
            foundClips = new List<Clip>();
            worker.RunWorkerAsync();
        }

        private void BtnMakeClips_Click(object sender, EventArgs e)
        {
            if (foundClips == null || foundClips.Count == 0)
            {
                MessageBox.Show("Analyse a video first.", "No clips",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            int picked = 0;
            foreach (ListViewItem it in lstClips.Items)
                if (it.Checked) picked++;
            if (picked == 0)
            {
                MessageBox.Show("Tick at least one clip in the list first.", "Nothing picked",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            outDir = txtOut.Text.Trim();
            if (string.IsNullOrWhiteSpace(outDir))
                outDir = Path.Combine(Path.GetDirectoryName(videoPath), "clips");
            try
            {
                Directory.CreateDirectory(outDir);
                string probe = Path.Combine(outDir, ".writetest.tmp");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Cannot write to the output folder:\n" + outDir + "\n\n" + ex.Message,
                    "Output folder error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            baseName = Path.GetFileNameWithoutExtension(videoPath);
            phase = "render";
            cancelRequested = false;
            lastError = null;
            startedAt = DateTime.Now;
            btnAnalyse.Enabled = false;
            btnMakeClips.Enabled = false;
            btnCancel.Enabled = true;
            btnOpenFolder.Enabled = false;
            bar.Value = 0;
            worker.RunWorkerAsync();
        }

        private void Worker_DoWork(object sender, DoWorkEventArgs e)
        {
            var bg = (BackgroundWorker)sender;
            try
            {
                if (phase == "analyse")
                    DoAnalyse(bg, e);
                else
                    DoRender(bg, e);
            }
            catch (Exception ex)
            {
                if (cancelRequested || bg.CancellationPending) { e.Cancel = true; return; }
                e.Result = ex;
            }
        }

        private void DoAnalyse(BackgroundWorker bg, DoWorkEventArgs e)
        {
            string link = "";
            string file = "";
            // Read UI values on the worker thread via captured locals set in click handlers.
            // (Link/file boxes are only read here through Invoke-free fields set below.)
            // To keep this simple and thread-safe, the paths were stored before starting.
            link = analyseLink;
            file = analyseFile;
            downloadDir = Path.Combine(Path.GetTempPath(), "ViralClips_dl_" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(downloadDir);

            if (!string.IsNullOrEmpty(link))
            {
                bg.ReportProgress(5, "Downloading video... (yt-dlp, may take a while for long videos)");
                string args = "--no-warnings --write-auto-sub --sub-lang en --sub-format vtt "
                    + "-f \"bv*[height<=1080]+ba/b[height<=1080]\" --merge-output-format mp4 "
                    + "-o \"downloaded.%(ext)s\" \"" + link + "\"";
                int code = RunTool(YtDlpPath, args, downloadDir, bg, "Downloading...");
                if (code != 0 || cancelRequested)
                {
                    if (cancelRequested) { e.Cancel = true; return; }
                    string hint = "Download failed. TikTok often blocks direct downloads - try picking the video file instead.\n\n"
                        + (string.IsNullOrEmpty(lastError) ? "" : lastError);
                    throw new Exception(hint);
                }
                string[] mp4s = Directory.GetFiles(downloadDir, "*.mp4");
                if (mp4s.Length == 0)
                {
                    // No mp4 (merge may have kept webm/mkv) - prefer a real video file,
                    // never a subtitle/json/part file.
                    string[] exts = new string[] { "*.webm", "*.mkv", "*.mov", "*.m4v", "*.avi" };
                    foreach (string pat in exts)
                    {
                        string[] found = Directory.GetFiles(downloadDir, pat);
                        if (found.Length > 0) { mp4s = found; break; }
                    }
                }
                if (mp4s.Length == 0)
                {
                    string[] any = Directory.GetFiles(downloadDir);
                    string pick = null;
                    foreach (string f in any)
                    {
                        string low = f.ToLowerInvariant();
                        if (low.EndsWith(".vtt") || low.EndsWith(".srt") || low.EndsWith(".json")
                            || low.EndsWith(".part") || low.EndsWith(".ytdl")) continue;
                        pick = f; break;
                    }
                    if (pick == null) throw new Exception("Download finished but no video file was found.");
                    videoPath = pick;
                }
                else videoPath = mp4s[0];
            }
            else
            {
                videoPath = file;
            }

            bg.ReportProgress(25, "Reading video length...");
            totalSeconds = ProbeDuration(videoPath);
            if (totalSeconds <= 0) throw new Exception("Could not read this video (duration unknown).");
            bg.ReportProgress(35, "Analysing audio (silence + loudness)...");
            speechSpans = DetectSpeech(videoPath, totalSeconds);
            maxVolumeDb = DetectMaxVolume(videoPath);
            bg.ReportProgress(55, "Reading captions (if any)...");
            string subsDir = !string.IsNullOrEmpty(link) ? downloadDir : Path.GetDirectoryName(videoPath);
            string subsFile = FindSubsFile(subsDir);
            cues = new List<VttCue>();
            if (subsFile != null)
                cues = ViralScorer.ParseVtt(subsFile);
            // Also look next to a local file for a same-name .vtt/.srt
            if (cues.Count == 0 && string.IsNullOrEmpty(link))
            {
                string alt = Path.ChangeExtension(videoPath, ".vtt");
                if (File.Exists(alt)) cues = ViralScorer.ParseVtt(alt);
                else
                {
                    alt = Path.ChangeExtension(videoPath, ".srt");
                    if (File.Exists(alt)) cues = ViralScorer.ParseVtt(alt);
                }
            }
            bg.ReportProgress(70, "Scoring moments...");
            double clipLen = ClipLengthSeconds();
            int want = 3;
            try { want = (int)numClipCount.Value; } catch { }
            if (cutMode == 1)
            {
                bg.ReportProgress(78, "Asking the AI brain...");
                List<Clip> aiClips;
                string aiErr;
                if (AiBrain.CallAi(cues, speechSpans, totalSeconds, clipLen, want, out aiClips, out aiErr)
                    && aiClips != null && aiClips.Count > 0)
                {
                    foundClips = aiClips;
                    aiNote = "Cut using AI: " + aiClips.Count + " moment(s) picked by the AI brain.";
                }
                else
                {
                    aiNote = "AI brain: " + aiErr + " - fell back to Full Cut local scoring.";
                    List<Clip> ranked = ViralScorer.ScoreWindows(totalSeconds, clipLen, speechSpans, cues);
                    foundClips = ViralScorer.PickTop(ranked, want);
                }
            }
            else
            {
                List<Clip> ranked = ViralScorer.ScoreWindows(totalSeconds, clipLen, speechSpans, cues);
                foundClips = ViralScorer.PickTop(ranked, want);
                aiNote = "Full Cut: local scoring only, no AI key used.";
            }
            bg.ReportProgress(100, "Done.");
        }

        // Captured before the worker starts (UI thread only).
        private string analyseLink = "";
        private string analyseFile = "";

        private void DoRender(BackgroundWorker bg, DoWorkEventArgs e)
        {
            var picked = new List<Clip>();
            foreach (ListViewItem it in lstClips.Items)
            {
                if (!it.Checked) continue;
                Clip c = it.Tag as Clip;
                if (c != null) picked.Add(c);
            }
            picked.Sort(delegate(Clip a, Clip b) { return a.Start.CompareTo(b.Start); });
            int idx = 0;
            foreach (Clip c in picked)
            {
                if (cancelRequested || bg.CancellationPending) { e.Cancel = true; return; }
                idx++;
                bg.ReportProgress((int)Math.Round((double)(idx - 1) / picked.Count * 100),
                    "Cutting clip " + idx + " of " + picked.Count + " (score " + c.Score + ")...");
                string srtName = string.Format(CultureInfo.InvariantCulture, "{0}_clip_{1:D3}.srt", baseName, idx);
                string srtPath = Path.Combine(outDir, srtName);
                ViralScorer.WriteClipSrt(srtPath, c, cues);
                string outFile = Path.Combine(outDir,
                    string.Format(CultureInfo.InvariantCulture, "{0}_clip_{1:D3}.mp4", baseName, idx));
                // 9:16 vertical, burned captions from the per-clip .srt.
                // Run with WorkingDirectory = outDir so the subtitles filter can use the bare filename.
                string args = "-y -v error -progress pipe:1 -ss " + c.Start.ToString(CultureInfo.InvariantCulture)
                    + " -t " + c.Length.ToString(CultureInfo.InvariantCulture)
                    + " -i \"" + videoPath + "\" -vf \"crop=ih*9/16:ih,scale=720:1280,subtitles='" + srtName
                    + "':force_style='Fontsize=26,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Bold=1,Alignment=2,MarginV=100'\" "
                    + "-c:v libx264 -preset veryfast -crf 23 -c:a aac \"" + outFile + "\"";
                int code = RunTool(FfmpegPath, args, outDir, bg, "Cutting clip " + idx + "...");
                if (code != 0 && !cancelRequested)
                    throw new Exception("ffmpeg failed on clip " + idx + (string.IsNullOrEmpty(lastError) ? "" : ": " + lastError));
                bg.ReportProgress((int)Math.Round((double)idx / picked.Count * 100),
                    "Clip " + idx + " of " + picked.Count + " done.");
            }
            bg.ReportProgress(100, "Done.");
        }

        private void Worker_ProgressChanged(object sender, ProgressChangedEventArgs e)
        {
            if (e.ProgressPercentage >= 0)
                bar.Value = Math.Max(0, Math.Min(100, e.ProgressPercentage));
            if (e.UserState != null)
                lblStatus.Text = e.UserState.ToString();
            if (e.ProgressPercentage > 0 && e.ProgressPercentage < 100)
            {
                double elapsed = (DateTime.Now - startedAt).TotalSeconds;
                double remain = elapsed * (100.0 - e.ProgressPercentage) / e.ProgressPercentage;
                TimeSpan r = TimeSpan.FromSeconds(remain);
                lblEta.Text = string.Format(CultureInfo.InvariantCulture, "About {0:D2}:{1:D2} left", (int)r.TotalMinutes, r.Seconds);
            }
            else if (e.ProgressPercentage >= 100)
                lblEta.Text = "";
        }

        private void Worker_RunWorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
        {
            btnAnalyse.Enabled = true;
            btnCancel.Enabled = false;
            if (e.Cancelled)
            {
                bar.Value = 0;
                lblStatus.Text = "Cancelled.";
                lblEta.Text = "";
                btnMakeClips.Enabled = foundClips != null && foundClips.Count > 0;
                return;
            }
            if (e.Result is Exception ex)
            {
                bar.Value = 0;
                lblStatus.Text = "Failed.";
                lblEta.Text = "";
                MessageBox.Show(ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            bar.Value = 100;
            if (phase == "analyse")
            {
                lstClips.Items.Clear();
                foreach (Clip c in foundClips)
                {
                    var item = new ListViewItem("");
                    item.Checked = true;
                    item.SubItems.Add(ViralScorer.FormatTime(c.Start).Substring(0, 8));
                    item.SubItems.Add(c.Score.ToString(CultureInfo.InvariantCulture));
                    item.SubItems.Add(c.Title);
                    item.Tag = c;
                    lstClips.Items.Add(item);
                }
                TimeSpan t = TimeSpan.FromSeconds(totalSeconds);
                string subsNote = cues.Count > 0 ? cues.Count + " caption lines" : "no captions found (loudness-only scoring)";
                lblInfo.Text = string.Format(CultureInfo.InvariantCulture,
                    "Video: {0:D2}:{1:D2}:{2:D2} - max volume {3} dB - {4}. {5}",
                    (int)t.TotalHours, t.Minutes, t.Seconds, maxVolumeDb, subsNote, aiNote);
                lblStatus.Text = foundClips.Count + " best moment(s) found. Tick the ones you want, then press Make Clips.";
                lblEta.Text = "Tip: un-tick any clip you do not want before cutting.";
                btnMakeClips.Enabled = foundClips.Count > 0;
            }
            else
            {
                int made = 0;
                try { made = Directory.GetFiles(outDir, baseName + "_clip_*.mp4").Length; } catch { }
                TimeSpan took = DateTime.Now - startedAt;
                lblStatus.Text = string.Format(CultureInfo.InvariantCulture,
                    "Done: {0} clip(s) in {1:D2}:{2:D2}.", made, (int)took.TotalMinutes, took.Seconds);
                lblEta.Text = "";
                btnOpenFolder.Enabled = true;
                btnMakeClips.Enabled = true;
                MessageBox.Show(string.Format(CultureInfo.InvariantCulture,
                    "Done! {0} clip(s) saved in:\n{1}", made, outDir),
                    "ViralClips", MessageBoxButtons.OK, MessageBoxIcon.Information);
                try { Process.Start("explorer.exe", "\"" + outDir + "\""); } catch { }
            }
        }
    }

    // ------------------------------------------------------------------
    // AI Settings dialog. Key is stored in ViralClips.settings.txt next
    // to the exe. It is never hardcoded and never sent anywhere except
    // the provider the user picked.
    // ------------------------------------------------------------------
    public class SettingsForm : Form
    {
        private ComboBox cboProvider;
        private TextBox txtModel;
        private TextBox txtKey;
        private AiSettings settings;

        public SettingsForm()
        {
            Text = "AI Settings (optional)";
            Size = new Size(480, 330);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Font = new Font("Segoe UI", 10);
            settings = AiSettings.Load();

            int x = 20, y = 16;
            var l1 = new Label();
            l1.Text = "Provider:";
            l1.Location = new Point(x, y); l1.Size = new Size(400, 22);
            Controls.Add(l1); y += 24;
            cboProvider = new ComboBox();
            cboProvider.Location = new Point(x, y); cboProvider.Size = new Size(420, 26);
            cboProvider.DropDownStyle = ComboBoxStyle.DropDownList;
            cboProvider.Items.AddRange(new object[] { "(off - local scoring only)", "gemini", "openai", "groq" });
            cboProvider.SelectedIndex = 0;
            if (settings.Provider == "gemini") cboProvider.SelectedIndex = 1;
            else if (settings.Provider == "openai") cboProvider.SelectedIndex = 2;
            else if (settings.Provider == "groq") cboProvider.SelectedIndex = 3;
            Controls.Add(cboProvider); y += 42;

            var l2 = new Label();
            l2.Text = "Model (leave blank for the default):";
            l2.Location = new Point(x, y); l2.Size = new Size(400, 22);
            Controls.Add(l2); y += 24;
            txtModel = new TextBox();
            txtModel.Location = new Point(x, y); txtModel.Size = new Size(420, 26);
            txtModel.Text = settings.Model;
            Controls.Add(txtModel); y += 42;

            var l3 = new Label();
            l3.Text = "Your API key (stored only on this computer):";
            l3.Location = new Point(x, y); l3.Size = new Size(400, 22);
            Controls.Add(l3); y += 24;
            txtKey = new TextBox();
            txtKey.Location = new Point(x, y); txtKey.Size = new Size(420, 26);
            txtKey.PasswordChar = '*';
            txtKey.Text = settings.ApiKey;
            Controls.Add(txtKey); y += 42;

            var lblNote = new Label();
            lblNote.Text = "Cut using AI uses this key. No key = Full Cut still works fully with local scoring.\nWith a key, the transcript + loudness data is sent to that provider only.";
            lblNote.ForeColor = Color.DimGray;
            lblNote.Location = new Point(x, y); lblNote.Size = new Size(420, 36);
            Controls.Add(lblNote); y += 48;

            var btnSave = new Button();
            btnSave.Text = "Save";
            btnSave.Location = new Point(x, y); btnSave.Size = new Size(120, 34);
            btnSave.Click += delegate(object s, EventArgs ev)
            {
                settings.Provider = cboProvider.SelectedIndex == 0 ? "" : cboProvider.SelectedItem.ToString();
                settings.Model = txtModel.Text.Trim();
                settings.ApiKey = txtKey.Text.Trim();
                settings.Save();
                Close();
            };
            Controls.Add(btnSave);
            var btnClear = new Button();
            btnClear.Text = "Clear key";
            btnClear.Location = new Point(150, y); btnClear.Size = new Size(120, 34);
            btnClear.Click += delegate(object s, EventArgs ev)
            {
                txtKey.Text = "";
                settings.ApiKey = "";
                settings.Save();
                Close();
            };
            Controls.Add(btnClear);
        }
    }
}
