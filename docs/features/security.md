# Security

ts-cloud includes built-in security scanning to protect your deployments from accidental secret exposure.

## Pre-Deployment Security Scanning

Before any deployment, ts-cloud automatically scans your source code for leaked secrets, API keys, credentials, and other sensitive data that should never be deployed to production.

### Why This Matters

Accidentally deploying secrets is one of the most common security incidents:

- **Frontend builds** can bundle API keys into JavaScript that's publicly accessible
- **Docker images** can contain hardcoded credentials that persist in container registries
- **Static sites** can expose configuration files with sensitive data
- **Infrastructure code** can leak database passwords or cloud credentials

ts-cloud catches these issues before they reach production.

## Detected Secret Types

The scanner detects 35+ types of secrets:

### Cloud Provider Credentials

| Pattern | Severity |
|---------|----------|
| AWS Access Key ID (`AKIA...`) | Critical |
| AWS Secret Access Key | Critical |
| Google API Key (`AIza...`) | Critical |
| Azure Client Secret | Critical |
| Cloudflare API Token | Critical |
| Heroku API Key | Critical |

### Private Keys

| Pattern | Severity |
|---------|----------|
| RSA Private Key | Critical |
| OpenSSH Private Key | Critical |
| EC Private Key | Critical |
| PGP Private Key | Critical |

### API Tokens

| Pattern | Severity |
|---------|----------|
| GitHub Personal Access Token (`ghp_...`) | Critical |
| Slack Token (`xox...`) | Critical |
| Discord Webhook | High |
| JWT Token | High |
| NPM Token | Critical |

### Payment Services

| Pattern | Severity |
|---------|----------|
| Stripe API Key (`sk_live_...`) | Critical |
| PayPal Client ID | High |
| Square Access Token | Critical |

### Database Credentials

| Pattern | Severity |
|---------|----------|
| Database Connection String | Critical |
| Database Password | Critical |

### Communication Services

| Pattern | Severity |
|---------|----------|
| Twilio API Key | Critical |
| SendGrid API Key | Critical |
| Mailgun API Key | Critical |

## Using the Security Scanner

### Standalone Security Scan

Run a security scan without deploying:

```bash
# Scan current directory
cloud deploy:security-scan

# Scan specific directory
cloud deploy:security-scan --source ./dist

# Scan with different severity threshold
cloud deploy:security-scan --fail-on high

# Skip specific patterns (false positives)
cloud deploy:security-scan --skip-patterns "Generic API Key,JWT Token"
```

### Automatic Scanning During Deploy

Security scanning runs automatically before all deploy commands:

```bash
# Scans project root before deploying infrastructure
cloud deploy

# Scans ./dist before uploading to S3
cloud deploy:static --source ./dist --bucket my-bucket

# Scans build context before building Docker image
cloud deploy:container --cluster my-cluster --service my-service
```

### Bypassing Security Scans

If you need to skip security scans (not recommended for production):

```bash
# Skip security scan
cloud deploy --skip-security-scan

# Skip with lower severity threshold
cloud deploy --security-fail-on high
```

## Security Scan Output

### Clean Scan

```
→ Running pre-deployment security scan...
ℹ Scanned 127 files in 245ms
ℹ   Critical: 0
ℹ   High: 0
ℹ   Medium: 0
ℹ   Low: 0
✓ Security scan passed
```

### Failed Scan

```
→ Running pre-deployment security scan...
ℹ Scanned 127 files in 312ms
✗   Critical: 2
⚠   High: 1
ℹ   Medium: 0
ℹ   Low: 0

Findings:

[CRITICAL]
  AWS Access Key ID
    File: src/config.ts:15
    Match: AKIA****************PRLD
  AWS Secret Access Key
    File: src/config.ts:16
    Match: 1R1B************************TAe

[HIGH]
  Generic API Key
    File: src/api/client.ts:8
    Match: api_key = "sk_t************************"

✗ Security scan failed - deployment blocked

Recommendations:
  1. Remove any hardcoded credentials from your code
  2. Use environment variables or AWS Secrets Manager
  3. Add sensitive files to .gitignore
  4. Use --skip-patterns to ignore false positives
```

## Configuration Options

### Severity Levels

| Level | Description |
|-------|-------------|
| `critical` | Blocks deployment (default) - definite security risk |
| `high` | Blocks deployment - likely security risk |
| `medium` | Warning only - potential security risk |
| `low` | Warning only - possible security concern |

### Command Options

```bash
cloud deploy:security-scan [options]

Options:
  --source <path>              Directory to scan (default: ".")
  --fail-on <severity>         Block on severity level (default: "critical")
  --skip-patterns <patterns>   Comma-separated patterns to skip
```

## Best Practices

### 1. Use Environment Variables

Instead of hardcoding secrets:

```typescript
// Bad - hardcoded secret
const apiKey = 'sk_live_abc123...'

// Good - environment variable
const apiKey = process.env.API_KEY
```

### 2. Use AWS Secrets Manager

For production deployments:

```typescript
import { SecretsManagerClient } from 'ts-cloud'

const secrets = new SecretsManagerClient('us-east-1')
const apiKey = await secrets.getSecretString('my-api-key')
```

### 3. Add .gitignore Rules

Prevent secrets from being committed:

```gitignore
# Environment files
.env
.env.*
.env.local

# AWS credentials
.aws/

# Private keys
*.pem
*.key
id_rsa*
```

### 4. Use Build-Time Environment Injection

For frontend builds, inject secrets at build time:

```bash
# Vite
VITE_API_URL=$API_URL bun run build

# Next.js
NEXT_PUBLIC_API_KEY=$API_KEY bun run build
```

### 5. Review Before Deploying

Always review scan results, even for warnings:

```bash
# Run scan first, review output
cloud deploy:security-scan --source ./dist

# Then deploy if clean
cloud deploy:static --source ./dist --bucket my-bucket
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install

      # Run security scan first
      - name: Security Scan
        run: bun run cloud deploy:security-scan --source ./dist

      # Deploy only if scan passes
      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: bun run cloud deploy:static --source ./dist --bucket ${{ vars.S3_BUCKET }}
```

### GitLab CI

```yaml
stages:
  - security
  - deploy

security-scan:
  stage: security
  script:
    - bun install
    - bun run cloud deploy:security-scan --source ./dist
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

deploy:
  stage: deploy
  needs: [security-scan]
  script:
    - bun run cloud deploy:static --source ./dist --bucket $S3_BUCKET
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

## Handling False Positives

Some patterns may trigger false positives. To handle them:

### Skip Specific Patterns

```bash
# Skip JWT detection (e.g., for test fixtures)
cloud deploy:security-scan --skip-patterns "JWT Token"

# Skip multiple patterns
cloud deploy:security-scan --skip-patterns "JWT Token,Generic API Key"
```

### Review and Confirm

If a detection is a false positive, verify the context:

- Is this an example/placeholder value?
- Is this a test fixture?
- Is this documentation showing the format?

If confirmed safe, use `--skip-patterns` to exclude it.

## Programmatic Usage

Use the scanner in your own scripts:

```typescript
import { PreDeployScanner, scanForSecrets } from 'ts-cloud'

// Quick scan
const result = await scanForSecrets({
  directory: './dist',
  failOnSeverity: 'critical',
})

if (!result.passed) {
  console.error('Security issues found:', result.findings)
  process.exit(1)
}

// Custom scanner with additional patterns
const scanner = new PreDeployScanner({
  customPatterns: [
    {
      name: 'Internal API Key',
      pattern: /INTERNAL_[A-Z0-9]{32}/g,
      severity: 'critical',
      description: 'Internal API key detected',
    },
  ],
})

const customResult = await scanner.scan({
  directory: './src',
  failOnSeverity: 'high',
})
```

## Next Steps

- [Deployment Guide](/guide/deployment) - Deploy with confidence
- [AWS Secrets Manager](/features/aws#secrets-manager) - Secure secret storage
- [CI/CD Integration](/advanced/cicd) - Automate security checks
