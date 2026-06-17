<?php
/**
 * ts-cloud PHP Lambda HTTP runtime (FPM mode).
 *
 * Implements the AWS Lambda Runtime API loop for the HTTP function: long-poll for
 * the next invocation (an API Gateway v2 payload-format-2.0 event), bridge it to
 * php-fpm over FastCGI (running Laravel's public/index.php), and post the response
 * back in API Gateway v2 response shape.
 */

require __DIR__ . '/fastcgi-client.php';

use TsCloud\FastCgiClient;

$runtimeApi = getenv('AWS_LAMBDA_RUNTIME_API');
$taskRoot = getenv('LAMBDA_TASK_ROOT') ?: '/var/task';
$docRoot = $taskRoot . '/public';
$socketPath = '/tmp/.tscloud-fpm.sock';

$fpm = new FastCgiClient($socketPath);

// Wait for php-fpm to create its socket (bounded).
for ($i = 0; $i < 50 && !file_exists($socketPath); $i++) {
    usleep(100000); // 100ms
}

$maintenance = getenv('MAINTENANCE_MODE') === '1';
$bypassSecret = getenv('MAINTENANCE_BYPASS_SECRET') ?: '';

while (true) {
    // 1. Get the next invocation.
    $ctx = nextInvocation($runtimeApi);
    if ($ctx === null) {
        continue;
    }
    [$requestId, $event] = $ctx;

    try {
        $response = handle($event, $fpm, $docRoot, $maintenance, $bypassSecret);
        postResponse($runtimeApi, $requestId, $response);
    } catch (\Throwable $e) {
        postError($runtimeApi, $requestId, $e);
    }
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

function handle(array $event, FastCgiClient $fpm, string $docRoot, bool $maintenance, string $bypassSecret): array
{
    // Warmer ping (scheduled keep-warm rule): keep the container alive, return fast.
    if (($event['warmer'] ?? false) === true) {
        return ['statusCode' => 200, 'headers' => ['content-type' => 'text/plain'], 'body' => 'warm', 'isBase64Encoded' => false];
    }

    $http = $event['requestContext']['http'] ?? [];
    $method = $http['method'] ?? 'GET';
    $rawPath = $event['rawPath'] ?? '/';
    $rawQuery = $event['rawQueryString'] ?? '';
    $headers = $event['headers'] ?? [];
    $cookies = $event['cookies'] ?? [];

    // Maintenance mode: 503 unless the bypass secret is presented.
    if ($maintenance) {
        $bypass = $headers['x-maintenance-bypass'] ?? '';
        if ($bypassSecret === '' || $bypass !== $bypassSecret) {
            return [
                'statusCode' => 503,
                'headers' => ['content-type' => 'text/plain', 'retry-after' => '120'],
                'body' => 'Service temporarily unavailable (maintenance mode)',
                'isBase64Encoded' => false,
            ];
        }
    }

    $body = $event['body'] ?? '';
    if (($event['isBase64Encoded'] ?? false) === true) {
        $body = base64_decode($body);
    }

    $params = [
        'GATEWAY_INTERFACE' => 'CGI/1.1',
        'REQUEST_METHOD' => $method,
        'SCRIPT_FILENAME' => $docRoot . '/index.php',
        'SCRIPT_NAME' => '/index.php',
        'PATH_INFO' => $rawPath,
        'REQUEST_URI' => $rawQuery !== '' ? $rawPath . '?' . $rawQuery : $rawPath,
        'QUERY_STRING' => $rawQuery,
        'DOCUMENT_ROOT' => $docRoot,
        'SERVER_PROTOCOL' => $http['protocol'] ?? 'HTTP/1.1',
        'SERVER_SOFTWARE' => 'ts-cloud-lambda',
        'REMOTE_ADDR' => $http['sourceIp'] ?? '127.0.0.1',
        'SERVER_NAME' => $event['requestContext']['domainName'] ?? 'localhost',
        'SERVER_PORT' => '443',
        'HTTPS' => 'on',
        'CONTENT_LENGTH' => (string) strlen($body),
    ];
    if (isset($headers['content-type'])) {
        $params['CONTENT_TYPE'] = $headers['content-type'];
    }
    if (!empty($cookies)) {
        $headers['cookie'] = implode('; ', $cookies);
    }
    foreach ($headers as $name => $value) {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $params[$key] = $value;
    }

    $result = $fpm->request($params, $body);
    return parseFpmResponse($result['stdout']);
}

function parseFpmResponse(string $raw): array
{
    // Split headers from body.
    $pos = strpos($raw, "\r\n\r\n");
    if ($pos === false) {
        $pos = strpos($raw, "\n\n");
        $headerBlock = $pos === false ? '' : substr($raw, 0, $pos);
        $body = $pos === false ? $raw : substr($raw, $pos + 2);
    } else {
        $headerBlock = substr($raw, 0, $pos);
        $body = substr($raw, $pos + 4);
    }

    $statusCode = 200;
    $headers = [];
    $cookies = [];
    foreach (preg_split('/\r\n|\n/', $headerBlock) as $line) {
        if (trim($line) === '') {
            continue;
        }
        $parts = explode(':', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }
        $name = strtolower(trim($parts[0]));
        $value = trim($parts[1]);
        if ($name === 'status') {
            $statusCode = (int) substr($value, 0, 3);
        } elseif ($name === 'set-cookie') {
            $cookies[] = $value;
        } else {
            $headers[$name] = $value;
        }
    }

    $contentType = $headers['content-type'] ?? 'text/html';
    $isText = (bool) preg_match('#^(text/|application/(json|xml|javascript|x-www-form-urlencoded)|image/svg)#i', $contentType);

    $response = [
        'statusCode' => $statusCode,
        'headers' => $headers,
        'isBase64Encoded' => !$isText,
        'body' => $isText ? $body : base64_encode($body),
    ];
    if (!empty($cookies)) {
        $response['cookies'] = $cookies;
    }
    return $response;
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
