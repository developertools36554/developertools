<?php
/**
 * ViralClips link-download endpoint — POST /viralclips/api/download.php
 *
 * Accepts a YouTube or TikTok link (JSON) and queues it for the
 * worker (Muse). The worker resolves the link to a direct video URL
 * with yt-dlp (no video bytes pass through this server) and writes
 * queue/dl-<id>.result.json — the page polls result.php for it.
 *
 * Why a server queue at all: a static GitHub Pages page cannot
 * download YouTube/TikTok links itself (the public download service
 * the page used to call now needs an API key, and YouTube is
 * disabled on its main instance). Our own worker does the resolving.
 *
 * Requires PHP 7.4+. No database, no dependencies, no secrets.
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
if (strlen($raw) > 100000) {
    fail(413, 'body_too_large');
}
$data = json_decode($raw, true);
if (!is_array($data)) {
    fail(400, 'bad_json');
}

/* ---------- id: same allow-list as analyse.php/result.php ---------- */
$id = $data['id'] ?? '';
if (!is_string($id) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/', $id)) {
    fail(400, 'bad_id');
}

/* ---------- url: YouTube or TikTok only, http(s), sane length ---------- */
$url = $data['url'] ?? '';
if (!is_string($url) || $url === '' || strlen($url) > 2000) {
    fail(400, 'bad_url');
}
$url = trim($url);
$parts = parse_url($url);
if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
    fail(400, 'bad_url');
}
$scheme = strtolower((string) $parts['scheme']);
if ($scheme !== 'http' && $scheme !== 'https') {
    fail(400, 'bad_url');
}
$host = strtolower((string) $parts['host']);
$allowedHosts = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtu.be', 'www.youtu.be',
    'tiktok.com', 'www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com',
];
if (!in_array($host, $allowedHosts, true)) {
    fail(400, 'unsupported_host');
}

/* ---------- store the queued download (atomic write, locked) ---------- */
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
        'kind' => 'download',
        'url' => $url,
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
