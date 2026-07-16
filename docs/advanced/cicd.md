# CI/CD Integration

ts-cloud deploys from a single CLI — the same `cloud` binary you run locally. There
is no separate programmatic deploy API to wire up; CI just runs `cloud` commands with
AWS credentials in the environment.

## How it works

- The CLI ships as `cloud` (the `@stacksjs/ts-cloud` package's bin). In a repo where
  it's a dependency, invoke it with `bunx cloud …` (or `bun run cloud …` if you've
  added a script).
- It authenticates with the standard AWS environment variables —
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and (for temporary creds)
  `AWS_SESSION_TOKEN` — or via an assumed role (OIDC). No `aws` CLI or AWS SDK is
  required.
- Set `CI=true` (most CI providers set this automatically) or pass `--yes` to
  `cloud deploy` so it runs non-interactively and skips confirmation prompts.
- Region resolves from your config (`project.region` / `environments.<env>.region`)
  or the `AWS_REGION` environment variable.

### Core commands

| Command | Purpose |
| --- | --- |
| `cloud config:validate` | Validate `cloud.config.ts` before deploying |
| `cloud diff` | Show the diff between local config and the deployed stack |
| `cloud deploy --env <env>` | Deploy infrastructure for an environment |
| `cloud deploy:serverless --env <env>` | Deploy the serverless (Lambda) app |
| `cloud deploy:static` | Sync a static site to S3 + invalidate CloudFront |
| `cloud deploy:container` | Build/push an image to ECR + roll the ECS service |
| `cloud serverless:rollback --env <env>` | Roll a serverless app back to the prior release |

`cloud deploy` defaults to the `staging` environment when `--env` is omitted.

## GitHub Actions

### Deploy on push to main

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - run: bun install

      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bunx cloud deploy --env production --yes
```

### Validate on PRs, deploy on merge

```yaml
# .github/workflows/ci.yml
name: Infra

on:
  push:
    branches: [main]
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx cloud config:validate
      - name: Diff against deployed stack
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bunx cloud diff

  deploy:
    if: github.ref == 'refs/heads/main'
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Deploy production
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bunx cloud deploy --env production --yes
```

### Authenticate with OIDC (no long-lived secrets)

Prefer short-lived credentials from an assumed role over stored access keys:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsDeploy
          aws-region: us-east-1

# configure-aws-credentials exports AWS_* into the environment,
# so cloud picks them up automatically.
      - run: bunx cloud deploy --env production --yes
```

### Deploy a serverless app

```yaml
      - name: Deploy serverless app
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bunx cloud deploy:serverless --env production
```

Each deploy records a release snapshot, so a failed rollout can be reverted from CI
or locally with `cloud serverless:rollback --env production`. See
[State Management](/features/state) for how releases are tracked.

## GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - validate
  - deploy

variables:
  AWS_REGION: us-east-1

validate:
  stage: validate
  image: oven/bun:latest
  script:
    - bun install
    - bunx cloud config:validate
  only:
    - merge_requests

deploy:staging:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bunx cloud deploy --env staging --yes
  only:
    - develop
  environment:
    name: staging

deploy:production:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bunx cloud deploy --env production --yes
  only:
    - main
  environment:
    name: production
  when: manual
```

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as masked CI/CD variables in the
project settings.

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1

executors:
  bun:
    docker:
      - image: oven/bun:latest

jobs:
  validate:
    executor: bun
    steps:
      - checkout
      - run: bun install
      - run: bunx cloud config:validate

  deploy:
    executor: bun
    parameters:
      environment:
        type: string
    steps:
      - checkout
      - run: bun install
      - run: bunx cloud deploy --env << parameters.environment >> --yes

workflows:
  main:
    jobs:
      - validate
      - deploy:
          name: deploy-staging
          environment: staging
          requires: [validate]
          filters:
            branches:
              only: develop
      - deploy:
          name: deploy-production
          environment: production
          requires: [validate]
          filters:
            branches:
              only: main
```

Configure AWS credentials as project environment variables (or via the CircleCI AWS
OIDC integration).

## Best practices

### Validate and diff before deploying

```bash
cloud config:validate      # catch config errors early
cloud diff                 # review the change set before applying
cloud deploy --env production --yes
```

### Use environments for approval gates

Most CI providers can gate a job behind a manual approval tied to a named
environment — pair that with `cloud deploy --env production`:

```yaml
# GitHub Actions
deploy-production:
  environment:
    name: production
    url: https://example.com   # requires manual approval in repo settings
```

### Prefer OIDC over stored keys

Short-lived, role-assumed credentials (shown above) avoid long-lived secrets in your
CI provider and scope each deploy to a least-privilege IAM role.

## Next Steps

- [State Management](/features/state) - How releases and stack state are tracked
- [Deployment](/guide/deployment) - Deployment strategies
- [Rollback Strategies](/advanced/rollback) - Handle failures
