/**
 * Container-image build + push for serverless apps using `packaging: 'image'`.
 *
 * Stages a Docker build context (app files + a generated Dockerfile, plus the
 * PHP runtime assets for PHP apps), builds the image, ensures an ECR repository,
 * logs in, and pushes a content-tagged image. Returns the image URI the deploy
 * orchestrator passes to CloudFormation + UpdateFunctionCode.
 */

import type { ServerlessAppConfig } from '@ts-cloud/core'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  collectPhpAppEntries,
  generateAppImageDockerfile,
  packageServerlessApp,
  phpRuntimeLayerAssets,
  runPhpBuildHooks,
  sha256,
} from '@ts-cloud/core'
import { ECRClient } from '../aws/ecr'
import * as cli from '../utils/cli'

export interface BuildImageOptions {
  app: ServerlessAppConfig
  projectRoot: string
  region: string
  /** ECR repository name (created if missing). */
  repository: string
  /** Skip local build hooks. */
  skipBuild?: boolean
  onStep?: (m: string) => void
}

export interface BuiltImage {
  /** Full image URI including the content tag (repoUri:tag). */
  imageUri: string
  /** The content tag (artifact hash). */
  tag: string
  /** Lambda handler strings per function. */
  handlers: { http: string, queue: string, cli: string }
}

function writeEntries(baseDir: string, entries: Array<{ name: string, data: Buffer | Uint8Array | string, mode?: number }>): void {
  for (const e of entries) {
    const dest = join(baseDir, e.name)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, e.data as any, e.mode ? { mode: e.mode } : undefined)
  }
}

export async function buildAndPushServerlessImage(opts: BuildImageOptions): Promise<BuiltImage> {
  const { app, projectRoot, region, repository } = opts
  const arch = app.architecture ?? 'x86_64'
  const platform = arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  const isPhp = app.kind === 'php'
  const step = opts.onStep ?? (() => {})

  const stage = mkdtempSync(join(tmpdir(), 'tscloud-img-'))
  try {
    const appDir = join(stage, 'app')
    mkdirSync(appDir, { recursive: true })

    let handlers: { http: string, queue: string, cli: string }
    let contentHash: string

    if (isPhp) {
      runPhpBuildHooks({ projectRoot, app, skipBuild: opts.skipBuild, onStep: step })
      step('staging application tree')
      const entries = collectPhpAppEntries(projectRoot)
      writeEntries(appDir, entries)
      // Stage the PHP runtime assets (bootstrap etc.) under ./runtime → /opt.
      writeEntries(join(stage, 'runtime'), phpRuntimeLayerAssets().map(a => ({ name: a.path, data: a.contents, mode: a.mode })))
      const handler = app.handlers?.http ?? 'public/index.php'
      handlers = { http: handler, queue: app.handlers?.queue ?? handler, cli: app.handlers?.cli ?? handler }
      contentHash = sha256(entries.map(e => `${e.name}:${e.data.length}`).join('|'))
    }
    else {
      step('bundling application')
      const artifact = await packageServerlessApp({ projectRoot, app, skipBuild: opts.skipBuild, onStep: step })
      writeFileSync(join(appDir, 'index.mjs'), artifact.bundle)
      handlers = artifact.handlers
      contentHash = artifact.sha256
    }

    const tag = contentHash.slice(0, 16)
    writeFileSync(join(stage, 'Dockerfile'), generateAppImageDockerfile({
      kind: app.kind ?? 'node',
      phpVersion: app.phpVersion,
      architecture: arch,
    }))

    // Ensure the ECR repository exists and get its URI.
    const ecr = new ECRClient(region)
    let repoUri: string
    try {
      const desc = await ecr.describeRepositories({ repositoryNames: [repository] })
      repoUri = desc.repositories?.[0]?.repositoryUri ?? ''
    }
    catch {
      repoUri = ''
    }
    if (!repoUri) {
      step(`creating ECR repository ${repository}`)
      const created = await ecr.createRepository({ repositoryName: repository, imageScanningConfiguration: { scanOnPush: true } })
      repoUri = created.repository?.repositoryUri ?? ''
    }
    if (!repoUri)
      throw new Error(`could not resolve ECR repository URI for ${repository}`)

    const imageUri = `${repoUri}:${tag}`

    step('docker build')
    execFileSync('docker', ['build', '--platform', platform, '-t', imageUri, stage], { stdio: 'inherit' })

    step('ecr login')
    const loginCmd = await ecr.getDockerLoginCommand()
    execSync(loginCmd, { stdio: 'inherit' })

    step('docker push')
    execFileSync('docker', ['push', imageUri], { stdio: 'inherit' })

    cli.info(`Image: ${imageUri}`)
    return { imageUri, tag, handlers }
  }
  finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
