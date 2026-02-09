# AWS Signature V4 Benchmarks

Comparing @stacksjs/ts-cloud's signing implementation against aws4fetch and AWS SDK v3.

## Run Benchmarks

```bash
bun run bench
```

## Results Summary

Tested on Apple M3 Pro, Bun 1.3.7

### Performance (lower is better)

| Benchmark | @stacksjs/ts-cloud | AWS SDK v3 | aws4fetch | @stacksjs/ts-cloud advantage |
|-----------|----------|------------|-----------|-------------------|
| GET request | **3.05 µs** | 13.34 µs | 72.17 µs | **4x** vs SDK, **24x** vs aws4fetch |
| POST with body | **3.29 µs** | 14.01 µs | 73.01 µs | **4x** vs SDK, **22x** vs aws4fetch |
| Large body (100KB+) | **42.68 µs** | 537.98 µs | 129.15 µs | **13x** vs SDK, **3x** vs aws4fetch |
| Session token | **3.30 µs** | 13.40 µs | 72.03 µs | **4x** vs SDK, **22x** vs aws4fetch |
| Custom headers | **3.77 µs** | 15.60 µs | 77.83 µs | **4x** vs SDK, **21x** vs aws4fetch |
| Batch (10 requests) | **34.54 µs** | 125.28 µs | 321.48 µs | **4x** vs SDK, **9x** vs aws4fetch |
| Batch (100 requests) | **308 µs** | 1.25 ms | 2.78 ms | **4x** vs SDK, **9x** vs aws4fetch |
| Presigned URL | **25.11 µs** | 63.18 µs | 88.73 µs | **2.5x** vs SDK, **3.5x** vs aws4fetch |
| Service auto-detection | **1.74 µs** | 44.47 µs | 69.48 µs | **26x** vs SDK, **40x** vs aws4fetch |
| Sign with auto-detect | **4.33 µs** | 12.92 µs | 69.56 µs | **3x** vs SDK, **16x** vs aws4fetch |

### New Features Performance

| Feature | @stacksjs/ts-cloud | AWS SDK v3 | aws4fetch | @stacksjs/ts-cloud advantage |
|---------|----------|------------|-----------|-------------------|
| Presigned URLs | **25.11 µs** | 63.18 µs | 88.73 µs | **2.5x** vs SDK, **3.5x** vs aws4fetch |
| Service auto-detection | **1.74 µs** | 44.47 µs* | 69.48 µs | **26x** vs SDK, **40x** vs aws4fetch |
| Sign with auto-detect | **4.33 µs** | 12.92 µs | 69.56 µs | **3x** vs SDK, **16x** vs aws4fetch |

*AWS SDK requires creating a new client for each region (no URL-based detection)

### Package Sizes

```
┌─────────────────────────────┬──────────────┬─────────────────┐
│ Package                     │ Source Size  │ node_modules    │
├─────────────────────────────┼──────────────┼─────────────────┤
│ @stacksjs/ts-cloud (signature.ts)     │ 17.8 KB      │ 0 KB (built-in) │
│ aws4fetch                   │ 11.0 KB      │ 80 KB           │
│ @smithy/signature-v4        │ 39.6 KB      │ 6.5 MB          │
│ @aws-sdk/client-s3          │ N/A          │ 17 MB           │
│ Full AWS SDK (typical)      │ N/A          │ 27+ MB          │
└─────────────────────────────┴──────────────┴─────────────────┘
```

**@stacksjs/ts-cloud is 365-1500x smaller than AWS SDK v3 in node_modules**

### Full Dependency Tree

```
@stacksjs/ts-cloud signing:
  └── signature.ts (17.8 KB)
  └── node:crypto (built-in, 0 KB added)
  Total: 17.8 KB

aws4fetch:
  └── aws4fetch (80 KB)
  └── crypto.subtle (built-in)
  Total: 80 KB

AWS SDK v3 signing (minimum):
  ├── @smithy/signature-v4 (244 KB)
  ├── @aws-crypto/sha256-js (244 KB)
  ├── @smithy/protocol-http (148 KB)
  ├── @smithy/types (948 KB)
  ├── @smithy/util-* packages
  └── + transitive dependencies...
  Total: 6.5+ MB

AWS SDK v3 with presigned URLs:
  ├── @aws-sdk/client-s3 (17 MB)
  ├── @aws-sdk/s3-request-presigner
  ├── @smithy/* (9 MB)
  └── @aws-crypto/* (1.6 MB)
  Total: 27+ MB
```

## Why @stacksjs/ts-cloud is Faster

1. **Synchronous crypto**: Uses Node.js `createHmac`/`createHash` which are highly optimized native bindings in Bun, vs:
   - aws4fetch: async `crypto.subtle` (browser-compatible but slower)
   - AWS SDK: JS-based `@aws-crypto/sha256-js` (portable but slow)

2. **Signing key caching**: Caches derived signing keys to avoid recomputing the expensive 4-step HMAC key derivation on repeated requests

3. **Zero dependencies**: No overhead from browser-compatibility abstractions, middleware layers, or plugin systems

4. **No client instantiation**: @stacksjs/ts-cloud signs requests directly without creating client objects

5. **Minimal allocations**: Direct string manipulation without intermediate Request/Response objects

6. **URL-based auto-detection**: Detects service/region from URL without requiring client configuration

## Feature Comparison

| Feature | @stacksjs/ts-cloud | aws4fetch | AWS SDK v3 |
|---------|----------|-----------|------------|
| Sync signing | ✅ | ❌ | ❌ |
| Async signing | ✅ | ✅ | ✅ |
| Key caching | ✅ | ✅ | ❌ |
| Query string signing | ✅ | ✅ | ✅ |
| Service auto-detection | ✅ | ✅ | ❌* |
| Retry logic | ✅ | ✅ | ✅ |
| Browser compatible | ✅ | ✅ | ✅ |
| Zero dependencies | ✅ | ✅ | ❌ |
| Session tokens | ✅ | ✅ | ✅ |
| Presigned URLs | ✅ | ✅ | ✅ |
| Credential Providers | ✅ | ❌ | ✅ |
| S3 High-Level API | ✅ | ❌ | ✅ |
| Streaming Uploads | ✅ | ❌ | ✅ |
| Multipart Uploads | ✅ | ❌ | ✅ |
| Custom DateTime | ✅ | ✅ | ❌ |
| Request Timeout | ✅ | ❌ | ✅ |
| Middleware support | ❌ | ❌ | ✅ |

*AWS SDK requires explicit region at client creation time

### Browser Compatibility

@stacksjs/ts-cloud provides both sync and async APIs:

- **Sync functions** (`signRequest`, `createPresignedUrl`): Fastest performance using Node.js crypto. Use in Node.js/Bun.
- **Async functions** (`signRequestAsync`, `createPresignedUrlAsync`): Browser compatible using Web Crypto API (`crypto.subtle`).

| Benchmark | @stacksjs/ts-cloud sync | @stacksjs/ts-cloud async | aws4fetch | @stacksjs/ts-cloud async advantage |
|-----------|---------------|----------------|-----------|-------------------------|
| GET request signing | **4.36 µs** | 35.57 µs | 72.65 µs | **2x** vs aws4fetch |
| Presigned URL | **25.65 µs** | 58.01 µs | 89.82 µs | **1.5x** vs aws4fetch |

**Key insight**: @stacksjs/ts-cloud's async (browser-compatible) API is still ~2x faster than aws4fetch!

```typescript
// Node.js/Bun - use sync for best performance (8x faster)
import { signRequest } from '@ts-cloud/core'
const signed = signRequest({ ... })

// Browser/Cloudflare Workers/Deno - use async functions (still 2x faster than aws4fetch)
import { signRequestAsync } from '@ts-cloud/core'
const signed = await signRequestAsync({ ... })
```

**Supported platforms:**
- Node.js (sync + async)
- Bun (sync + async)
- Browsers (async via Web Crypto API)
- Cloudflare Workers (async via Web Crypto API)
- Deno (async via Web Crypto API)
- Any runtime with `crypto.subtle` support

## Usage Examples

### Basic Request Signing

```typescript
import { signRequest } from '@ts-cloud/core'

const signed = signRequest({
  method: 'GET',
  url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
})

const response = await fetch(signed.url, {
  method: signed.method,
  headers: signed.headers,
})
```

### With Auto-Detection

```typescript
// Service and region auto-detected from URL
const signed = signRequest({
  method: 'GET',
  url: 'https://s3.eu-west-1.amazonaws.com/bucket/key',
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
})
// Automatically detects: service='s3', region='eu-west-1'
```

### Presigned URLs

```typescript
import { createPresignedUrl } from '@ts-cloud/core'

const url = createPresignedUrl({
  url: 'https://s3.us-east-1.amazonaws.com/bucket/file.pdf',
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
  expiresIn: 3600, // 1 hour
})

// Share this URL - no credentials needed to access
console.log(url)
```

### With Retry Logic & Timeout

```typescript
import { makeAWSRequest } from '@ts-cloud/core'

const response = await makeAWSRequest(
  {
    method: 'GET',
    url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
    accessKeyId: 'AKIA...',
    secretAccessKey: '...',
  },
  {
    maxRetries: 3,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    timeoutMs: 30000, // 30 second timeout
    retryableStatusCodes: [429, 500, 502, 503, 504],
  }
)
```

### Credential Providers

```typescript
import { getCredentials, createCredentialProvider } from '@ts-cloud/core'

// Auto-detect credentials from environment, ~/.aws/credentials, EC2, ECS, etc.
const credentials = await getCredentials()

// Create a cached provider that auto-refreshes expiring credentials
const provider = createCredentialProvider()
const creds = await provider()
```

### S3 High-Level API

```typescript
import { S3Client } from '@ts-cloud/core'

const s3 = new S3Client({ region: 'us-east-1' })

// Simple operations
const response = await s3.get('my-bucket', 'file.txt')
const text = await s3.getText('my-bucket', 'file.txt')
const json = await s3.getJSON('my-bucket', 'data.json')

// Upload (auto-uses multipart for files >5MB)
await s3.put('my-bucket', 'file.txt', 'Hello World')
await s3.put('my-bucket', 'data.json', JSON.stringify({ key: 'value' }))

// Delete
await s3.delete('my-bucket', 'file.txt')
await s3.deleteMany('my-bucket', ['file1.txt', 'file2.txt'])

// List with pagination
for await (const obj of s3.listAll('my-bucket', { prefix: 'folder/' })) {
  console.log(obj.key, obj.size)
}

// Check existence
const exists = await s3.exists('my-bucket', 'file.txt')

// Get metadata
const head = await s3.head('my-bucket', 'file.txt')

// Copy
await s3.copy('source-bucket', 'source.txt', 'dest-bucket', 'dest.txt')

// Generate presigned URL
const url = await s3.getPresignedUrl('my-bucket', 'file.txt', { expiresIn: 3600 })
```

### Streaming & Multipart Uploads

```typescript
import { S3Client } from '@ts-cloud/core'

const s3 = new S3Client({ region: 'us-east-1' })

// Upload a stream with progress tracking
const stream = fs.createReadStream('large-file.zip')
await s3.uploadMultipart('my-bucket', 'large-file.zip', stream, {
  partSize: 10 * 1024 * 1024, // 10MB parts
  concurrency: 4,
  onProgress: ({ loaded, total, part, totalParts }) => {
    console.log(`Part ${part}/${totalParts}: ${loaded}/${total} bytes`)
  },
})
```

### Custom DateTime (for testing)

```typescript
import { signRequest } from '@ts-cloud/core'

// Use fixed datetime for reproducible signatures
const signed = signRequest({
  method: 'GET',
  url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
  datetime: '20240101T120000Z', // Fixed timestamp
})
```

## When to Use Each

**Use @stacksjs/ts-cloud when:**
- You need maximum performance (sync API in Node.js/Bun)
- You need browser support (async API with Web Crypto)
- You need cross-platform compatibility (works everywhere)
- Bundle size matters (17.8 KB vs 27+ MB for AWS SDK)
- You want zero dependencies
- You're building infrastructure tools
- You want both sync and async options

**Use aws4fetch when:**
- You're already using it in an existing project

**Use AWS SDK v3 when:**
- You need the full SDK ecosystem
- You want official AWS support
- Middleware and plugins are important
- You're already using the SDK for other services
