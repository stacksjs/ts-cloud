# AWS Signature V4 Benchmarks

Comparing ts-cloud's signing implementation against aws4fetch and AWS SDK v3.

## Run Benchmarks

```bash
bun run bench
```

## Results Summary

Tested on Apple M3 Pro, Bun 1.3.7

### Performance (lower is better)

| Benchmark | ts-cloud | AWS SDK v3 | aws4fetch | ts-cloud vs SDK | ts-cloud vs aws4fetch |
|-----------|----------|------------|-----------|-----------------|----------------------|
| GET request | **3.05 µs** | 13.34 µs | 72.17 µs | **4.4x faster** | **24x faster** |
| POST with body | **3.29 µs** | 14.01 µs | 73.01 µs | **4.3x faster** | **22x faster** |
| Large body (100KB+) | **42.68 µs** | 537.98 µs | 129.15 µs | **12.6x faster** | **3x faster** |
| Session token | **3.30 µs** | 13.40 µs | 72.03 µs | **4.1x faster** | **22x faster** |
| Custom headers | **3.77 µs** | 15.60 µs | 77.83 µs | **4.1x faster** | **21x faster** |
| Batch (10 requests) | **34.54 µs** | 125.28 µs | 321.48 µs | **3.6x faster** | **9x faster** |
| Batch (100 requests) | **308.38 µs** | 1.25 ms | 2.78 ms | **4.1x faster** | **9x faster** |
| CloudFormation | **3.47 µs** | 14.22 µs | 73.42 µs | **4.1x faster** | **21x faster** |
| STS | **3.33 µs** | 13.87 µs | 72.27 µs | **4.2x faster** | **22x faster** |
| Client instantiation | **3.12 µs** | 15.68 µs | N/A | **5x faster** | N/A |

### Package Sizes

```
┌─────────────────────────────┬──────────────┬─────────────────┐
│ Package                     │ Source Size  │ node_modules    │
├─────────────────────────────┼──────────────┼─────────────────┤
│ ts-cloud (signature.ts)     │ 6.3 KB       │ 0 KB (built-in) │
│ aws4fetch                   │ 11.0 KB      │ 80 KB           │
│ @smithy/signature-v4        │ 39.6 KB      │ 6.5 MB          │
│ @aws-sdk/client-s3          │ N/A          │ 17 MB           │
│ Full AWS SDK (typical)      │ N/A          │ 27+ MB          │
└─────────────────────────────┴──────────────┴─────────────────┘
```

### Size Comparison Visual

```
ts-cloud signature:    ▌ 6.3 KB
aws4fetch:             ████ 80 KB
AWS SDK signing only:  ████████████████████████████████████████ 6.5 MB
AWS SDK S3 client:     ████████████████████████████████████████████████████████████ 17 MB
Full AWS SDK:          ████████████████████████████████████████████████████████████████████████████ 27+ MB
```

**ts-cloud is 1000-4000x smaller than AWS SDK v3**

### Full Dependency Tree

```
ts-cloud signing:
  └── signature.ts (6.3 KB)
  └── node:crypto (built-in, 0 KB added)
  Total: 6.3 KB

aws4fetch:
  └── aws4fetch (80 KB)
  └── crypto.subtle (built-in)
  Total: 80 KB

AWS SDK v3 signing (minimum):
  ├── @smithy/signature-v4 (244 KB)
  ├── @aws-crypto/sha256-js (244 KB)
  ├── @smithy/protocol-http (148 KB)
  ├── @smithy/types (948 KB)
  ├── @smithy/util-hex-encoding (36 KB)
  ├── @smithy/util-middleware (60 KB)
  ├── @smithy/util-uri-escape (60 KB)
  ├── @smithy/util-utf8 (96 KB)
  └── + transitive dependencies...
  Total: 6.5+ MB

AWS SDK v3 with S3 client (typical usage):
  ├── @aws-sdk/client-s3 (17 MB)
  ├── @smithy/* (9 MB)
  └── @aws-crypto/* (1.6 MB)
  Total: 27+ MB
```

## Why ts-cloud is Faster

1. **Synchronous crypto**: Uses Node.js `createHmac`/`createHash` which are highly optimized native bindings in Bun, vs:
   - aws4fetch: async `crypto.subtle` (browser-compatible but slower)
   - AWS SDK: JS-based `@aws-crypto/sha256-js` (portable but slow)

2. **Signing key caching**: Caches derived signing keys to avoid recomputing the expensive 4-step HMAC key derivation on repeated requests

3. **Zero dependencies**: No overhead from browser-compatibility abstractions, middleware layers, or plugin systems

4. **No client instantiation**: ts-cloud signs requests directly without creating client objects

5. **Minimal allocations**: Direct string manipulation without intermediate Request/Response objects

## Why ts-cloud is Smaller

| Reason | ts-cloud | AWS SDK v3 |
|--------|----------|------------|
| Crypto | Built-in `node:crypto` | Ships `@aws-crypto` (1.6 MB) |
| HTTP | Built-in `fetch` | Ships protocol handlers |
| Types | Minimal | Ships 948 KB of type definitions |
| Architecture | Single function | Modular client/command/middleware |
| Browser support | Node.js/Bun only | Universal (adds overhead) |

## Feature Comparison

| Feature | ts-cloud | aws4fetch | AWS SDK v3 |
|---------|----------|-----------|------------|
| Sync signing | ✅ | ❌ | ❌ |
| Key caching | ✅ | ✅ | ❌ |
| Browser compatible | ❌ | ✅ | ✅ |
| Zero dependencies | ✅ | ✅ | ❌ |
| Session tokens | ✅ | ✅ | ✅ |
| Query string signing | ❌ | ✅ | ✅ |
| Service auto-detection | ❌ | ✅ | ✅ |
| Retry logic | ❌ | ✅ | ✅ |
| Middleware support | ❌ | ❌ | ✅ |

## When to Use Each

**Use ts-cloud when:**
- You need maximum performance
- You're running on Node.js or Bun
- Bundle size matters
- You want zero dependencies
- You're building infrastructure tools

**Use aws4fetch when:**
- You need browser/Cloudflare Workers support
- You want a lightweight option with retries
- Query string signing is required

**Use AWS SDK v3 when:**
- You need the full SDK ecosystem
- You want official AWS support
- Middleware and plugins are important
- You're already using the SDK for other services
