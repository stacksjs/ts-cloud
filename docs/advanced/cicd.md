# CI/CD Integration

Automate your infrastructure deployments with popular CI/CD platforms.

## GitHub Actions

### Basic Deployment

```yaml
# .github/workflows/deploy.yml
name: Deploy Infrastructure

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

      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: bun run cloud deploy --all
```

### With Preview Environments

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install

      - name: Deploy Preview
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          bun run cloud deploy --stack preview-${{ github.event.number }}

      - name: Comment PR
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: 'Preview deployed to https://preview-${{ github.event.number }}.example.com'
            })

  deploy:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install

      - name: Deploy Production
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: bun run cloud deploy --all --env prod
```

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
    - bun run cloud validate
  only:
    - merge_requests

deploy:staging:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bun run cloud deploy --all --env staging
  only:
    - develop
  environment:
    name: staging

deploy:production:
  stage: deploy
  image: oven/bun:latest
  script:
    - bun install
    - bun run cloud deploy --all --env prod
  only:
    - main
  environment:
    name: production
  when: manual
```

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
      - run: bun run cloud validate

  deploy:
    executor: bun
    parameters:
      environment:
        type: string
    steps:
      - checkout
      - run: bun install
      - run: bun run cloud deploy --all --env << parameters.environment >>

workflows:
  main:
    jobs:
      - validate
      - deploy:
          name: deploy-staging
          environment: staging
          requires:
            - validate
          filters:
            branches:
              only: develop
      - deploy:
          name: deploy-production
          environment: prod
          requires:
            - validate
          filters:
            branches:
              only: main
```

## AWS CodePipeline

```typescript
// pipeline-stack.ts
import { defineStack } from 'ts-cloud'

export default defineStack({
  name: 'deployment-pipeline',

  resources: {
    Pipeline: {
      Type: 'AWS::CodePipeline::Pipeline',
      Properties: {
        Stages: [
          {
            Name: 'Source',
            Actions: [
              {
                Name: 'GitHub',
                ActionTypeId: {
                  Category: 'Source',
                  Owner: 'ThirdParty',
                  Provider: 'GitHub',
                  Version: '1',
                },
                Configuration: {
                  Owner: 'my-org',
                  Repo: 'my-repo',
                  Branch: 'main',
                },
                OutputArtifacts: [{ Name: 'Source' }],
              },
            ],
          },
          {
            Name: 'Deploy',
            Actions: [
              {
                Name: 'CloudFormation',
                ActionTypeId: {
                  Category: 'Deploy',
                  Owner: 'AWS',
                  Provider: 'CloudFormation',
                  Version: '1',
                },
                Configuration: {
                  ActionMode: 'CREATE_UPDATE',
                  StackName: 'my-app',
                  TemplatePath: 'Source::template.json',
                },
                InputArtifacts: [{ Name: 'Source' }],
              },
            ],
          },
        ],
      },
    },
  },
})
```

## Best Practices

### Use OIDC for AWS Authentication

```yaml
# GitHub Actions with OIDC
jobs:
  deploy:
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/GitHubActions
          aws-region: us-east-1
```

### Separate Validation and Deployment

```yaml
jobs:
  validate:
    steps:
      - run: bun run cloud validate
      - run: bun run cloud diff --all

  deploy:
    needs: validate
    steps:
      - run: bun run cloud deploy --all
```

### Use Environments for Approval Gates

```yaml
deploy:production:
  environment:
    name: production
    url: https://example.com
  # Requires manual approval in GitHub
```

## Next Steps

- [Deployment](/guide/deployment) - Deployment strategies
- [Rollback Strategies](/advanced/rollback) - Handle failures
