/**
 * GitLab CI/CD Pipeline Generator
 * Generate CI/CD pipelines for GitLab
 */

export interface GitLabCIOptions {
  stages?: string[]
  environments?: string[]
  awsRegion?: string
  dockerImage?: string
  bunVersion?: string
  deployCommand?: string
  testCommand?: string
  buildCommand?: string
}

/**
 * Generate deployment pipeline
 */
export function generateDeploymentPipeline(options: GitLabCIOptions = {}): string {
  const {
    stages = ['test', 'build', 'deploy'],
    environments = ['production'],
    awsRegion = 'us-east-1',
    dockerImage = 'oven/bun:latest',
    deployCommand = 'bun run cloud deploy',
    testCommand = 'bun test',
    buildCommand = 'bun run build',
  } = options

  return `stages:
${stages.map(s => `  - ${s}`).join('\n')}

variables:
  AWS_DEFAULT_REGION: ${awsRegion}
  AWS_REGION: ${awsRegion}

default:
  image: ${dockerImage}
  cache:
    paths:
      - node_modules/
      - .bun/

before_script:
  - bun install

test:
  stage: test
  script:
    - ${testCommand}
  only:
    - merge_requests
    - main

build:
  stage: build
  script:
    - ${buildCommand}
  artifacts:
    paths:
      - dist/
    expire_in: 1 day
  only:
    - merge_requests
    - main

deploy:
  stage: deploy
  script:
    - ${deployCommand}
  environment:
    name: ${environments[0]}
    url: https://\${CI_PROJECT_NAME}.example.com
  only:
    - main
  when: manual
`
}

/**
 * Generate multi-environment pipeline
 */
export function generateMultiEnvPipeline(options: {
  environments: Array<{ name: string; branch: string; manual?: boolean }>
  awsRegion?: string
}): string {
  const { environments, awsRegion = 'us-east-1' } = options

  const deployJobs = environments.map(env => `
deploy:${env.name}:
  stage: deploy
  script:
    - bun run cloud deploy --env=${env.name}
  environment:
    name: ${env.name}
    url: https://${env.name}.example.com
  only:
    - ${env.branch}
  ${env.manual ? 'when: manual' : ''}
`).join('\n')

  return `stages:
  - test
  - build
  - deploy

variables:
  AWS_DEFAULT_REGION: ${awsRegion}

default:
  image: oven/bun:latest
  cache:
    paths:
      - node_modules/

test:
  stage: test
  script:
    - bun install
    - bun test

build:
  stage: build
  script:
    - bun install
    - bun run build
  artifacts:
    paths:
      - dist/
${deployJobs}
`
}

/**
 * Generate PR/MR preview pipeline
 */
export function generatePreviewPipeline(options: {
  awsRegion?: string
  ttl?: number
} = {}): string {
  const { awsRegion = 'us-east-1', ttl = 24 } = options

  return `stages:
  - build
  - deploy
  - cleanup

variables:
  AWS_DEFAULT_REGION: ${awsRegion}
  TTL_HOURS: ${ttl}

default:
  image: oven/bun:latest

deploy:preview:
  stage: deploy
  script:
    - bun install
    - |
      bun run cloud env:preview \\
        --branch=\${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME} \\
        --pr=\${CI_MERGE_REQUEST_IID} \\
        --commit=\${CI_COMMIT_SHA} \\
        --ttl=\${TTL_HOURS}
    - PREVIEW_URL=\$(bun run cloud env:preview --get-url \${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME})
    - echo "Preview URL: \$PREVIEW_URL"
  environment:
    name: preview/\${CI_MERGE_REQUEST_IID}
    url: \${PREVIEW_URL}
    on_stop: cleanup:preview
  only:
    - merge_requests

cleanup:preview:
  stage: cleanup
  script:
    - bun install
    - |
      bun run cloud env:preview --destroy \\
        --branch=\${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME} \\
        --pr=\${CI_MERGE_REQUEST_IID}
  environment:
    name: preview/\${CI_MERGE_REQUEST_IID}
    action: stop
  when: manual
  only:
    - merge_requests
`
}

/**
 * Generate scheduled pipeline
 */
export function generateScheduledPipeline(options: {
  environment: string
  awsRegion?: string
}): string {
  const { environment, awsRegion = 'us-east-1' } = options

  return `stages:
  - deploy

variables:
  AWS_DEFAULT_REGION: ${awsRegion}
  ENVIRONMENT: ${environment}

default:
  image: oven/bun:latest

deploy:scheduled:
  stage: deploy
  script:
    - bun install
    - bun run cloud deploy --env=\${ENVIRONMENT}
  environment:
    name: \${ENVIRONMENT}
  only:
    - schedules
`
}

/**
 * Generate manual deployment pipeline
 */
export function generateManualPipeline(options: {
  environments: string[]
  awsRegion?: string
}): string {
  const { environments, awsRegion = 'us-east-1' } = options

  const deployJobs = environments.map(env => `
deploy:${env}:
  stage: deploy
  script:
    - bun install
    - bun run cloud deploy --env=${env}
  environment:
    name: ${env}
  when: manual
  only:
    - main
`).join('\n')

  return `stages:
  - deploy

variables:
  AWS_DEFAULT_REGION: ${awsRegion}

default:
  image: oven/bun:latest
${deployJobs}
`
}
