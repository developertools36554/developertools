<?php
/**
 * ViralClips AI result endpoint — GET /viralclips/api/result.php?id=<request id>
 *
 * Reads the queue written by analyse.php and the result file written by
 * the worker (Muse). Responses:
 *   {"status":"queued","id":...}        — still waiting to be analysed
 *   {"status":"done","id":...,"moments":[...]} — ranked moments are ready
 *   {"status":"error","id":...,"error":...}    — analysis failed
 *   {"status":"not_found","id":...}     — no such request (HTTP 404)
 *
 * The moments array follows the worker contract in README-SERVER.md:
 * each moment is {"start_sec":..., "end_sec":..., "score":0-100,
 * "title":"...", "reason":"..."}.
 *
 * No secrets, no keys, no database.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'error' => 'method_not_allowed']);
    exit;
}

$id = $_GET['id'] ?? '';
if (!is_string($id) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/', $id)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'error' => 'bad_id']);
    exit;
}

$queueDir = __DIR__ . '/queue';

/* A result file written by the worker wins over the queued request. */
$resultFile = $queueDir . '/' . $id . '.result.json';
if (is_file($resultFile)) {
    $raw = file_get_contents($resultFile);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if (is_array($data) && isset($data['status']) && in_array($data['status'], ['done', 'error'], true)) {
        $out = ['status' => $data['status'], 'id' => $id];
        if ($data['status'] === 'done') {
            $out['moments'] = is_array($data['moments'] ?? null) ? $data['moments'] : [];
        } else {
            $out['error'] = isset($data['error']) ? (string) $data['error'] : 'analysis_failed';
        }
        echo json_encode($out);
        exit;
    }
    /* A malformed result file is a server error, not a queue state. */
    http_response_code(500);
    echo json_encode(['status' => 'error', 'id' => $id, 'error' => 'bad_result']);
    exit;
}

if (is_file($queueDir . '/' . $id . '.json')) {
    echo json_encode(['status' => 'queued', 'id' => $id]);
    exit;
}

http_response_code(404);
echo json_encode(['status' => 'not_found', 'id' => $id]);
