<?php

namespace TsCloud\Serverless\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Issues a pre-signed S3 upload URL for direct browser → S3 uploads, the
 * `Vapor.store()` flow. The frontend (the `laravel-vapor` npm helper, or any
 * client) POSTs the content type here, PUTs the file straight to the returned
 * URL, then hands the `key` back to the app to persist.
 *
 * Mirrors Laravel Vapor's `/vapor/signed-storage-url`. Registered by
 * {@see \TsCloud\Serverless\ServerlessServiceProvider} at
 * `/tscloud/signed-storage-url`.
 */
class SignedStorageUrlController
{
    public function store(Request $request): JsonResponse
    {
        // Optional authorization: if the app defines an `uploadFiles` ability or
        // a UserPolicy@uploadFiles, enforce it (matches Vapor's behavior).
        if (Gate::has('uploadFiles')) {
            if (Gate::denies('uploadFiles', [$request->user()])) {
                abort(403, 'Unauthorized to upload files.');
            }
        }

        $bucket = $request->input('bucket') ?: config('filesystems.disks.s3.bucket');
        $disk = $request->input('disk') ?: 's3';
        $uuid = (string) Str::uuid();
        $key = ($request->input('prefix') ?: 'tmp/') . $uuid;

        $expiresAfter = (int) ($request->input('expires') ?: 5);
        $options = array_filter([
            'ContentType' => $request->input('content_type') ?: 'application/octet-stream',
            'ACL' => $request->input('visibility'),
            'Bucket' => $bucket,
        ]);

        // Laravel 9+ exposes a presigned upload URL on the S3 disk.
        $signed = Storage::disk($disk)->temporaryUploadUrl(
            $key,
            now()->addMinutes($expiresAfter),
            $options
        );

        return new JsonResponse([
            'uuid' => $uuid,
            'bucket' => $bucket,
            'key' => $key,
            'url' => $signed['url'],
            'headers' => $this->normalizeHeaders($signed['headers'] ?? []),
        ], 201);
    }

    /**
     * @param array<string,mixed> $headers
     * @return array<string,mixed>
     */
    private function normalizeHeaders(array $headers): array
    {
        // The browser sets Host itself; sending it back breaks the PUT.
        unset($headers['Host']);
        return $headers;
    }
}
