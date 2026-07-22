import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { ECRClient } from '../aws/ecr'

export interface BuildContainerImageOptions {
  context: string
  dockerfile?: string
  repository: string
  region?: string
  profile?: string
  platform?: 'linux/amd64' | 'linux/arm64'
}

export interface BuiltContainerImage {
  repository: string
  tag: string
  imageUri: string
  digest: string
  digestUri: string
  contextSha256: string
}

export interface ContainerImageDependencies {
  ecr: Pick<
    ECRClient,
    'describeRepositories' | 'createRepository' | 'putLifecyclePolicy' | 'getAuthorizationToken' | 'describeImages'
  >
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'ignore' | 'inherit' },
  ) => void
}

const IGNORED_DIRECTORIES = new Set(['.git', '.ts-cloud', 'node_modules', 'dist', 'coverage'])

function filesIn(directory: string, base = directory): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory).sort()) {
    if (IGNORED_DIRECTORIES.has(name)) continue
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...filesIn(path, base))
    else if (stat.isFile()) files.push(relative(base, path))
  }
  return files
}

export function hashContainerContext(context: string): string {
  const root = resolve(context)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Container context does not exist: ${root}`)
  const hash = createHash('sha256')
  for (const filename of filesIn(root)) {
    hash.update(filename)
    hash.update('\0')
    hash.update(readFileSync(join(root, filename)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function createContainerImageDependencies(
  options: Pick<BuildContainerImageOptions, 'region' | 'profile'>,
): ContainerImageDependencies {
  return {
    ecr: new ECRClient(options.region || 'us-east-1', options.profile),
    run: (command, args, runOptions) => {
      execFileSync(command, args, { cwd: runOptions?.cwd, env: runOptions?.env, stdio: runOptions?.stdio || 'inherit' })
    },
  }
}

export async function buildAndPushContainerImage(
  options: BuildContainerImageOptions,
  injected?: ContainerImageDependencies,
): Promise<BuiltContainerImage> {
  const context = resolve(options.context)
  const dockerfile = resolve(options.dockerfile || join(context, 'Dockerfile'))
  if (!existsSync(dockerfile)) throw new Error(`Dockerfile does not exist: ${dockerfile}`)
  const repositorySegments = options.repository.split('/')
  const repositoryIsValid = repositorySegments.every(
    (segment) => /^[a-z0-9][a-z0-9._-]*$/.test(segment) && !/[._-]$/.test(segment) && !/[._-]{2}/.test(segment),
  )
  if (!repositoryIsValid) throw new Error('ECR repository name is invalid')
  const dependencies = injected || createContainerImageDependencies(options)
  const contextSha256 = hashContainerContext(context)
  const tag = `sha-${contextSha256.slice(0, 20)}`
  let repositoryUri = ''
  try {
    repositoryUri =
      (await dependencies.ecr.describeRepositories({ repositoryNames: [options.repository] })).repositories?.[0]
        ?.repositoryUri || ''
  } catch {}
  if (!repositoryUri) {
    const created = await dependencies.ecr.createRepository({
      repositoryName: options.repository,
      imageTagMutability: 'IMMUTABLE',
      imageScanningConfiguration: { scanOnPush: true },
      tags: [{ Key: 'ManagedBy', Value: 'ts-cloud' }],
    })
    repositoryUri = created.repository?.repositoryUri || ''
  }
  if (!repositoryUri) throw new Error(`Could not resolve ECR repository URI for ${options.repository}`)
  await dependencies.ecr.putLifecyclePolicy({
    repositoryName: options.repository,
    lifecyclePolicyText: JSON.stringify({
      rules: [
        {
          rulePriority: 1,
          description: 'Retain the newest 25 release images',
          selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 25 },
          action: { type: 'expire' },
        },
      ],
    }),
  })
  const imageUri = `${repositoryUri}:${tag}`
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ts-cloud-container-'))
  try {
    dependencies.run('docker', ['version'], { stdio: 'ignore' })
    dependencies.run(
      'docker',
      [
        'build',
        '--platform',
        options.platform || 'linux/amd64',
        '--provenance=false',
        '--sbom=false',
        '--file',
        dockerfile,
        '--tag',
        imageUri,
        context,
      ],
      { cwd: context },
    )
    const auth = (await dependencies.ecr.getAuthorizationToken()).authorizationData?.[0]
    if (!auth?.authorizationToken || !auth.proxyEndpoint)
      throw new Error('ECR did not return Docker authorization data')
    const registry = auth.proxyEndpoint.replace(/^https?:\/\//, '')
    const dockerConfig = join(temporaryDirectory, 'docker')
    mkdirSync(dockerConfig, { recursive: true })
    writeFileSync(
      join(dockerConfig, 'config.json'),
      JSON.stringify({ auths: { [registry]: { auth: auth.authorizationToken } } }),
      { mode: 0o600 },
    )
    dependencies.run('docker', ['push', imageUri], { env: { ...process.env, DOCKER_CONFIG: dockerConfig } })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  const image = (
    await dependencies.ecr.describeImages({ repositoryName: options.repository, imageIds: [{ imageTag: tag }] })
  ).imageDetails?.[0]
  const digest = image?.imageDigest
  if (!digest || !/^sha256:[a-f0-9]{64}$/i.test(digest))
    throw new Error(`ECR did not return an immutable digest for ${basename(imageUri)}`)
  return {
    repository: options.repository,
    tag,
    imageUri,
    digest,
    digestUri: `${repositoryUri}@${digest}`,
    contextSha256,
  }
}
