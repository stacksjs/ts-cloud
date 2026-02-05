/**
 * CircleCI Configuration Generator
 * Generate CI/CD pipelines for CircleCI
*/

export interface CircleCIOptions {
  awsRegion?: string
  dockerImage?: string
  bunVersion?: string
  deployCommand?: string
  testCommand?: string
  buildCommand?: string
  workflows?: boolean
}

/**
 * Generate deployment config
*/
export function generateDeploymentConfig(options: CircleCIOptions = {}): string {
  const {
    awsRegion = 'us-east-1',
    dockerImage = 'oven/bun:latest',
    deployCommand = 'bun run cloud deploy',
    testCommand = 'bun test',
    buildCommand = 'bun run build',
    workflows = true,
  } = options

  return `version: 2.1

orbs:
  aws-cli: circleci/aws-cli@4.0

executors:
  bun-executor:
    docker:
      - image: ${dockerImage}
    environment:
      AWS_DEFAULT_REGION: ${awsRegion}
      AWS_REGION: ${awsRegion}

jobs:
  test:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
            - dependencies-
      - run:
          name: Install dependencies
          command: bun install
      - save_cache:
          paths:
            - node_modules
          key: dependencies-{{ checksum "package.json" }}
      - run:
          name: Run tests
          command: ${testCommand}

  build:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run:
          name: Install dependencies
          command: bun install
      - run:
          name: Build application
          command: ${buildCommand}
      - persist_to_workspace:
          root: .
          paths:
            - dist

  deploy:
    executor: bun-executor
    steps:
      - checkout
      - attach_workspace:
          at: .
      - aws-cli/setup
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run:
          name: Install dependencies
          command: bun install
      - run:
          name: Deploy to AWS
          command: ${deployCommand}

${workflows ? `workflows:
  version: 2
  build-test-deploy:
    jobs:
      - test
      - build:
          requires:
            - test
      - deploy:
          requires:
            - build
          filters:
            branches:
              only: main
` : ''}
`
}

/**
 * Generate multi-environment config
*/
export function generateMultiEnvConfig(options: {
  environments: Array<{ name: string; branch: string }>
  awsRegion?: string
}): string {
  const { environments, awsRegion = 'us-east-1' } = options

  const deployJobs = environments.map(env => `
  deploy-${env.name}:
    executor: bun-executor
    steps:
      - checkout
      - attach_workspace:
          at: .
      - aws-cli/setup
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run:
          name: Install dependencies
          command: bun install
      - run:
          name: Deploy to ${env.name}
          command: bun run cloud deploy --env=${env.name}
`).join('\n')

  const workflowJobs = environments.map(env => `
      - deploy-${env.name}:
          requires:
            - build
          filters:
            branches:
              only: ${env.branch}
`).join('')

  return `version: 2.1

orbs:
  aws-cli: circleci/aws-cli@4.0

executors:
  bun-executor:
    docker:
      - image: oven/bun:latest
    environment:
      AWS_DEFAULT_REGION: ${awsRegion}

jobs:
  test:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - save_cache:
          paths:
            - node_modules
          key: dependencies-{{ checksum "package.json" }}
      - run: bun test

  build:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - run: bun run build
      - persist_to_workspace:
          root: .
          paths:
            - dist
${deployJobs}

workflows:
  version: 2
  build-test-deploy:
    jobs:
      - test
      - build:
          requires:
            - test
${workflowJobs}
`
}

/**
 * Generate scheduled workflow config
*/
export function generateScheduledConfig(options: {
  schedule: string
  environment: string
  awsRegion?: string
}): string {
  const { schedule, environment, awsRegion = 'us-east-1' } = options

  return `version: 2.1

orbs:
  aws-cli: circleci/aws-cli@4.0

executors:
  bun-executor:
    docker:
      - image: oven/bun:latest
    environment:
      AWS_DEFAULT_REGION: ${awsRegion}
      ENVIRONMENT: ${environment}

jobs:
  deploy:
    executor: bun-executor
    steps:
      - checkout
      - aws-cli/setup
      - run:
          name: Install dependencies
          command: bun install
      - run:
          name: Deploy to \${ENVIRONMENT}
          command: bun run cloud deploy --env=\${ENVIRONMENT}

workflows:
  version: 2
  scheduled-deployment:
    triggers:
      - schedule:
          cron: "${schedule}"
          filters:
            branches:
              only: main
    jobs:
      - deploy
`
}

/**
 * Generate approval workflow config
*/
export function generateApprovalConfig(options: {
  environments: string[]
  awsRegion?: string
}): string {
  const { environments, awsRegion = 'us-east-1' } = options

  const deployJobs = environments.map(env => `
  deploy-${env}:
    executor: bun-executor
    steps:
      - checkout
      - attach_workspace:
          at: .
      - aws-cli/setup
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - run: bun run cloud deploy --env=${env}
`).join('\n')

  const workflowJobs = environments.map(env => `
      - hold-${env}:
          type: approval
          requires:
            - build
          filters:
            branches:
              only: main
      - deploy-${env}:
          requires:
            - hold-${env}
`).join('')

  return `version: 2.1

orbs:
  aws-cli: circleci/aws-cli@4.0

executors:
  bun-executor:
    docker:
      - image: oven/bun:latest
    environment:
      AWS_DEFAULT_REGION: ${awsRegion}

jobs:
  test:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - save_cache:
          paths:
            - node_modules
          key: dependencies-{{ checksum "package.json" }}
      - run: bun test

  build:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - run: bun run build
      - persist_to_workspace:
          root: .
          paths:
            - dist
${deployJobs}

workflows:
  version: 2
  build-test-deploy-with-approval:
    jobs:
      - test
      - build:
          requires:
            - test
${workflowJobs}
`
}

/**
 * Generate parallel deployment config
*/
export function generateParallelConfig(options: {
  regions: string[]
  environment: string
  awsRegion?: string
}): string {
  const { regions, environment } = options

  const deployJobs = regions.map(region => `
  deploy-${region.replace(/-/g, '_')}:
    executor: bun-executor
    environment:
      AWS_REGION: ${region}
    steps:
      - checkout
      - attach_workspace:
          at: .
      - aws-cli/setup
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - run: bun run cloud deploy --env=${environment} --region=${region}
`).join('\n')

  const workflowJobs = regions.map(region => `
      - deploy-${region.replace(/-/g, '_')}:
          requires:
            - build
`).join('')

  return `version: 2.1

orbs:
  aws-cli: circleci/aws-cli@4.0

executors:
  bun-executor:
    docker:
      - image: oven/bun:latest

jobs:
  test:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - save_cache:
          paths:
            - node_modules
          key: dependencies-{{ checksum "package.json" }}
      - run: bun test

  build:
    executor: bun-executor
    steps:
      - checkout
      - restore_cache:
          keys:
            - dependencies-{{ checksum "package.json" }}
      - run: bun install
      - run: bun run build
      - persist_to_workspace:
          root: .
          paths:
            - dist
${deployJobs}

workflows:
  version: 2
  multi-region-deploy:
    jobs:
      - test
      - build:
          requires:
            - test
${workflowJobs}
`
}
