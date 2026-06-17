<?php
/**
 * Minimal FastCGI client for the ts-cloud PHP Lambda runtime.
 *
 * Speaks just enough of the FastCGI protocol to send one request (params + stdin)
 * to php-fpm over a unix socket and read the full stdout/stderr response. This is
 * the bridge between the Lambda Runtime API loop and Laravel's public/index.php
 * served by php-fpm.
 */

namespace TsCloud;

final class FastCgiClient
{
    const FCGI_VERSION = 1;
    const BEGIN_REQUEST = 1;
    const END_REQUEST = 3;
    const PARAMS = 4;
    const STDIN = 5;
    const STDOUT = 6;
    const STDERR = 7;
    const RESPONDER = 1;

    private string $socketPath;

    public function __construct(string $socketPath)
    {
        $this->socketPath = $socketPath;
    }

    /**
     * @param array<string,string> $params FastCGI params (CGI environment)
     * @return array{stdout:string,stderr:string}
     */
    public function request(array $params, string $stdin = ''): array
    {
        $conn = @stream_socket_client('unix://' . $this->socketPath, $errno, $errstr, 30);
        if ($conn === false) {
            throw new \RuntimeException("FastCGI connect failed: {$errstr} ({$errno})");
        }

        $requestId = 1;

        // BEGIN_REQUEST (role=RESPONDER, flags=0 -> close connection when done).
        $beginBody = pack('nCxxxxx', self::RESPONDER, 0);
        fwrite($conn, $this->record(self::BEGIN_REQUEST, $requestId, $beginBody));

        // PARAMS (name-value pairs), then an empty PARAMS record to terminate.
        $paramsBody = '';
        foreach ($params as $name => $value) {
            $paramsBody .= $this->nameValuePair((string) $name, (string) $value);
        }
        if ($paramsBody !== '') {
            fwrite($conn, $this->record(self::PARAMS, $requestId, $paramsBody));
        }
        fwrite($conn, $this->record(self::PARAMS, $requestId, ''));

        // STDIN (body) then an empty STDIN record to terminate.
        if ($stdin !== '') {
            foreach (str_split($stdin, 65535) as $chunk) {
                fwrite($conn, $this->record(self::STDIN, $requestId, $chunk));
            }
        }
        fwrite($conn, $this->record(self::STDIN, $requestId, ''));

        // Read the response records.
        $stdout = '';
        $stderr = '';
        while (!feof($conn)) {
            $header = fread($conn, 8);
            if ($header === false || strlen($header) < 8) {
                break;
            }
            $h = unpack('Cversion/Ctype/nrequestId/ncontentLength/CpaddingLength/Creserved', $header);
            $content = '';
            $remaining = $h['contentLength'];
            while ($remaining > 0) {
                $buf = fread($conn, $remaining);
                if ($buf === false || $buf === '') {
                    break;
                }
                $content .= $buf;
                $remaining -= strlen($buf);
            }
            if ($h['paddingLength'] > 0) {
                fread($conn, $h['paddingLength']);
            }

            if ($h['type'] === self::STDOUT) {
                $stdout .= $content;
            } elseif ($h['type'] === self::STDERR) {
                $stderr .= $content;
            } elseif ($h['type'] === self::END_REQUEST) {
                break;
            }
        }

        fclose($conn);

        return ['stdout' => $stdout, 'stderr' => $stderr];
    }

    private function record(int $type, int $requestId, string $content): string
    {
        $length = strlen($content);
        $header = pack('CCnnCx', self::FCGI_VERSION, $type, $requestId, $length, 0);
        return $header . $content;
    }

    private function nameValuePair(string $name, string $value): string
    {
        $nlen = strlen($name);
        $vlen = strlen($value);
        $out = $nlen < 128 ? chr($nlen) : pack('N', $nlen | 0x80000000);
        $out .= $vlen < 128 ? chr($vlen) : pack('N', $vlen | 0x80000000);
        return $out . $name . $value;
    }
}
