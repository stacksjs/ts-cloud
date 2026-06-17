<?php
/**
 * ts-cloud PHP Lambda HTTP runtime — Octane / persistent mode.
 *
 * Boots the Laravel application ONCE per cold start and serves each invocation
 * in-process through the HTTP kernel (no php-fpm, no FastCGI hop), then resets
 * request-scoped state between invocations. Lower latency than the FPM bridge at
 * the cost of requiring an Octane-safe app. Selected when TSCLOUD_OCTANE=1.
 */

$runtimeApi = getenv('AWS_LAMBDA_RUNTIME_API');
$taskRoot = getenv('LAMBDA_TASK_ROOT') ?: '/var/task';

require $taskRoot . '/vendor/autoload.php';

// Boot the application + HTTP kernel once.
$app = require $taskRoot . '/bootstrap/app.php';
$kernel = $app->make(\Illuminate\Contracts\Http\Kernel::class);

$maintenance = getenv('MAINTENANCE_MODE') === '1';
$bypassSecret = getenv('MAINTENANCE_BYPASS_SECRET') ?: '';

while (true) {
    $ctx = nextInvocation($runtimeApi);
    if ($ctx === null) {
        continue;
    }
    [$requestId, $event] = $ctx;

    try {
        $response = handle($event, $kernel, $maintenance, $bypassSecret);
        postResponse($runtimeApi, $requestId, $response);
    } catch (\Throwable $e) {
        postError($runtimeApi, $requestId, $e);
    }
}

function handle(array $event, $kernel, bool $maintenance, string $bypassSecret): array
{
    if (($event['warmer'] ?? false) === true) {
        return ['statusCode' => 200, 'headers' => ['content-type' => 'text/plain'], 'body' => 'warm', 'isBase64Encoded' => false];
    }

    $http = $event['requestContext']['http'] ?? [];
    $headers = $event['headers'] ?? [];

    if ($maintenance) {
        $bypass = $headers['x-maintenance-bypass'] ?? '';
        if ($bypassSecret === '' || $bypass !== $bypassSecret) {
            return ['statusCode' => 503, 'headers' => ['content-type' => 'text/plain', 'retry-after' => '120'], 'body' => 'Service temporarily unavailable (maintenance mode)', 'isBase64Encoded' => false];
        }
    }

    $body = $event['body'] ?? '';
    if (($event['isBase64Encoded'] ?? false) === true) {
        $body = base64_decode($body);
    }

    $method = $http['method'] ?? 'GET';
    $rawPath = $event['rawPath'] ?? '/';
    $rawQuery = $event['rawQueryString'] ?? '';

    // Build server vars + an Illuminate request.
    $server = [
        'REQUEST_METHOD' => $method,
        'REQUEST_URI' => $rawQuery !== '' ? $rawPath . '?' . $rawQuery : $rawPath,
        'QUERY_STRING' => $rawQuery,
        'SERVER_NAME' => $event['requestContext']['domainName'] ?? 'localhost',
        'SERVER_PORT' => '443',
        'HTTPS' => 'on',
        'REMOTE_ADDR' => $http['sourceIp'] ?? '127.0.0.1',
    ];
    foreach ($headers as $name => $value) {
        $server['HTTP_' . strtoupper(str_replace('-', '_', $name))] = $value;
        if (strtolower($name) === 'content-type') {
            $server['CONTENT_TYPE'] = $value;
        }
    }

    parse_str($rawQuery, $query);
    $cookies = [];
    foreach ($event['cookies'] ?? [] as $cookie) {
        $parts = explode('=', $cookie, 2);
        if (count($parts) === 2) {
            $cookies[$parts[0]] = urldecode($parts[1]);
        }
    }

    $request = new \Illuminate\Http\Request(
        $query,
        [],
        [],
        $cookies,
        [],
        $server,
        $body
    );
    $request->setMethod($method);

    $response = $kernel->handle($request);
    $result = marshalResponse($response);
    $kernel->terminate($request, $response);

    return $result;
}

function marshalResponse($response): array
{
    $content = $response->getContent();
    $headers = [];
    $cookies = [];
    foreach ($response->headers->allPreserveCase() as $name => $values) {
        if (strtolower($name) === 'set-cookie') {
            foreach ($values as $v) {
                $cookies[] = $v;
            }
        } else {
            $headers[$name] = implode(', ', $values);
        }
    }

    $contentType = $headers['Content-Type'] ?? ($headers['content-type'] ?? 'text/html');
    $isText = (bool) preg_match('#^(text/|application/(json|xml|javascript|x-www-form-urlencoded)|image/svg)#i', $contentType);

    $out = [
        'statusCode' => $response->getStatusCode(),
        'headers' => $headers,
        'isBase64Encoded' => !$isText,
        'body' => $isText ? $content : base64_encode($content),
    ];
    if (!empty($cookies)) {
        $out['cookies'] = $cookies;
    }
    return $out;
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
