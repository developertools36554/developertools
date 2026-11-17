<?php
/**
 * ViralClips AI analysis endpoint — POST /viralclips/api/analyse.php
 *
 * Accepts ANALYSIS DATA ONLY (JSON): timestamps, loudness numbers,
 * speech spans, transcript, wanted clip count/length, local moments.
 * It accepts NO video file bytes and NO secrets of any kind — there is
 * nothing secret in this code and no key is ever read or stored here.
 *
 * Behaviour: validates the request, stores it as queue/<id>.json with
 * status "queued", and returns {"ok":true,"id":...,"status":"queued"}.
 * A worker (Muse) reads queued requests, analyses them, and writes
 * queue/<id>.result.json — see README-SERVER.md for the contract.
 *
 * Requires PHP 7.4+. No database, no dependencies.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function fail(int $code, string $error): void
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'method_not_allowed');
}

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    fail(400, 'empty_body');
}
if (strlen($raw) > 2000000) {
    fail(413, 'body_too_large');
}
$data = json_decode($raw, true);
if (!is_array($data)) {
    fail(400, 'bad_json');
}

/* ---------- id: client-generated, used as the file name — strict allow-list ---------- */
$id = $data['id'] ?? '';
if (!is_string($id) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/', $id)) {
    fail(400, 'bad_id');
}

/* ---------- mode ---------- */
if (($data['mode'] ?? '') !== 'ai') {
    fail(400, 'bad_mode');
}

/* ---------- duration: seconds, 1s .. 4h ---------- */
$duration = $data['duration'] ?? null;
if (!is_numeric($duration) || (float) $duration < 1 || (float) $duration > 14400) {
    fail(400, 'bad_duration');
}
$duration = (float) $duration;

/* ---------- clip count / length ---------- */
$clipCount = $data['clip_count'] ?? null;
if (!is_numeric($clipCount) || (int) $clipCount < 1 || (int) $clipCount > 10) {
    fail(400, 'bad_clip_count');
}
$clipCount = (int) $clipCount;

$clipLen = $data['clip_len'] ?? null;
if (!is_numeric($clipLen) || !in_array((int) $clipLen, [30, 45, 60], true)) {
    fail(400, 'bad_clip_len');
}
$clipLen = (int) $clipLen;

/* ---------- speech spans: [{start, end}] inside the video ---------- */
$speechSpans = $data['speech_spans'] ?? [];
if (!is_array($speechSpans) || count($speechSpans) > 10000) {
    fail(400, 'bad_speech_spans');
}
$cleanSpans = [];
foreach ($speechSpans as $s) {
    if (!is_array($s) || !isset($s['start'], $s['end'])) {
        fail(400, 'bad_speech_spans');
    }
    $st = (float) $s['start'];
    $en = (float) $s['end'];
    if ($st < 0 || $en <= $st || $en > $duration) {
        fail(400, 'bad_speech_spans');
    }
    $cleanSpans[] = ['start' => round($st, 2), 'end' => round($en, 2)];
}

/* ---------- loudness buckets: numbers 0..1, capped ---------- */
$buckets = $data['loudness_buckets'] ?? [];
if (!is_array($buckets) || count($buckets) > 20000) {
    fail(400, 'bad_loudness_buckets');
}
$cleanBuckets = [];
foreach ($buckets as $b) {
    if (!is_numeric($b)) {
        fail(400, 'bad_loudness_buckets');
    }
    $cleanBuckets[] = max(0.0, min(1.0, round((float) $b, 3)));
}

/* ---------- transcript: plain text only, capped ---------- */
$transcript = $data['transcript'] ?? '';
if (!is_string($transcript)) {
    fail(400, 'bad_transcript');
}
$transcript = strip_tags($transcript);
if (strlen($transcript) > 20000) {
    $transcript = substr($transcript, 0, 20000);
}

/* ---------- local moments (optional context): validated the same way ---------- */
$localMoments = $data['local_moments'] ?? [];
if (!is_array($localMoments) || count($localMoments) > 50) {
    fail(400, 'bad_local_moments');
}
$cleanMoments = [];
foreach ($localMoments as $m) {
    if (!is_array($m) || !isset($m['start'], $m['end'])) {
        fail(400, 'bad_local_moments');
    }
    $st = (float) $m['start'];
    $en = (float) $m['end'];
    if ($st < 0 || $en <= $st || $en > $duration) {
        fail(400, 'bad_local_moments');
    }
    $cleanMoments[] = [
        'start' => round($st, 2),
        'end' => round($en, 2),
        'score' => isset($m['score']) ? max(0, min(100, (int) $m['score'])) : 50,
        'title' => isset($m['title']) ? substr(strip_tags((string) $m['title']), 0, 120) : '',
        'reason' => isset($m['reason']) ? substr(strip_tags((string) $m['reason']), 0, 200) : '',
    ];
}

/* ---------- optional file name (context only, never a path) ---------- */
$fileName = '';
if (isset($data['file_name']) && is_string($data['file_name'])) {
    $fileName = substr(strip_tags($data['file_name']), 0, 120);
}

/* ---------- store the queued request (atomic write, locked) ---------- */
$queueDir = __DIR__ . '/queue';
if (!is_dir($queueDir)) {
    if (!mkdir($queueDir, 0755, true) && !is_dir($queueDir)) {
        fail(500, 'queue_unavailable');
    }
}

$record = [
    'id' => $id,
    'status' => 'queued',
    'created_at' => gmdate('c'),
    'request' => [
        'mode' => 'ai',
        'duration' => $duration,
        'file_name' => $fileName,
        'speech_spans' => $cleanSpans,
        'loudness_buckets' => $cleanBuckets,
        'bucket_sec' => 0.25,
        'transcript' => $transcript,
        'clip_count' => $clipCount,
        'clip_len' => $clipLen,
        'local_moments' => $cleanMoments,
    ],
];

$tmp = $queueDir . '/.' . $id . '.tmp-' . bin2hex(random_bytes(6));
$fh = fopen($tmp, 'wb');
if ($fh === false) {
    fail(500, 'queue_unavailable');
}
flock($fh, LOCK_EX);
fwrite($fh, json_encode($record, JSON_UNESCAPED_SLASHES));
flock($fh, LOCK_UN);
fclose($fh);
rename($tmp, $queueDir . '/' . $id . '.json');

echo json_encode(['ok' => true, 'id' => $id, 'status' => 'queued']);
