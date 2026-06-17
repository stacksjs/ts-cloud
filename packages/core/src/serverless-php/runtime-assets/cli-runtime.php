<?php
/**
 * ts-cloud PHP Lambda CLI runtime — handles the queue, scheduler, and cli modes.
 *
 * Implements the Lambda Runtime API loop and dispatches based on the event:
 *   - SQS event ({Records:[...]})        -> one artisan queue job per record
 *   - EventBridge / {command:'schedule:run'} -> `php artisan schedule:run`
 *   - {command:'<artisan command>'}      -> arbitrary artisan command
 *
 * Queue records are passed to a Laravel bridge command (default
 * `tscloud:sqs-handle`, override via TSCLOUD_QUEUE_COMMAND) provided by the
 * `tscloud/serverless` composer package. This avoids the double-delivery hazard
 * of running stock `queue:work` (which would re-poll SQS alongside Lambda's own
 * poller).
 */

$runtimeApi = getenv('AWS_LAMBDA_RUNTIME_API');
$taskRoot = getenv('LAMBDA_TASK_ROOT') ?: '/var/task';
$artisan = $taskRoot . '/artisan';
$queueCommand = getenv('TSCLOUD_QUEUE_COMMAND') ?: 'tscloud:sqs-handle';

while (true) {
    $ctx = nextInvocation($runtimeApi);
    if ($ctx === null) {
        continue;
    }
    [$requestId, $event] = $ctx;

    try {
        $result = dispatch($event, $artisan, $queueCommand);
        postResponse($runtimeApi, $requestId, $result);
    } catch (\Throwable $e) {
        postError($runtimeApi, $requestId, $e);
    }
}

function dispatch(array $event, string $artisan, string $queueCommand): array
{
    // SQS queue event.
    if (isset($event['Records']) && is_array($event['Records'])) {
        $failures = [];
        foreach ($event['Records'] as $record) {
            $body = $record['body'] ?? '';
            $messageId = $record['messageId'] ?? '';
            $exit = runArtisan($artisan, [$queueCommand], ['TSCLOUD_SQS_RECORD' => $body], $out);
            if ($exit !== 0) {
                $failures[] = ['itemIdentifier' => $messageId];
            }
        }
        return ['batchItemFailures' => $failures];
    }

    // Scheduler / arbitrary command.
    $command = $event['command'] ?? 'schedule:run';
    $args = preg_split('/\s+/', trim($command));
    $exit = runArtisan($artisan, $args, [], $out);
    return ['statusCode' => $exit, 'output' => $out];
}

/**
 * @param string[] $args
 * @param array<string,string> $env
 */
function runArtisan(string $artisan, array $args, array $env, ?string &$out): int
{
    $cmd = array_merge(['php', $artisan], $args);
    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $fullEnv = array_merge(getenv(), $env);
    $proc = proc_open($cmd, $descriptors, $pipes, getenv('LAMBDA_TASK_ROOT') ?: '/var/task', $fullEnv);
    if (!is_resource($proc)) {
        $out = 'failed to start artisan';
        return 1;
    }
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    $out = trim($stdout . "\n" . $stderr);
    // Surface output to CloudWatch.
    fwrite(STDERR, $out . "\n");
    return $exit;
}

/**
 * @return array{0:string,1:array}|null
 */
function nextInvocation(string $api): ?array
{
    $ch = curl_init("http://{$api}/2018-06-01/runtime/invocation/next");
    $headers = [];
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($c, $h) use (&$headers) {
        $parts = explode(':', $h, 2);
        if (count($parts) === 2) {
            $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
        return strlen($h);
    });
    $body = curl_exec($ch);
    curl_close($ch);
    if ($body === false) {
        return null;
    }
    $requestId = $headers['lambda-runtime-aws-request-id'] ?? '';
    $event = json_decode($body, true) ?: [];
    return [$requestId, $event];
}

function postResponse(string $api, string $requestId, array $response): void
{
    $ch = curl_init("http://{$api}/2018-06-01/runtime/invocation/{$requestId}/response");
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($response));
    curl_exec($ch);
    curl_close($ch);
}

function postError(string $api, string $requestId, \Throwable $e): void
{
    $ch = curl_init("http://{$api}/2018-06-01/runtime/invocation/{$requestId}/error");
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'errorType' => get_class($e),
        'errorMessage' => $e->getMessage(),
    ]));
    curl_exec($ch);
    curl_close($ch);
}
