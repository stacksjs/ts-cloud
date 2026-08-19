#!/usr/bin/env bun
/**
 * Deploys the Bun-on-Lambda PoC end to end, using only ts-cloud clients
 * (no AWS SDK / CLI). Idempotent: safe to re-run.
 *
 *   1. ensure an S3 deployment bucket
 *   2. upload + publish the Bun runtime layer (from build-layer.ts output)
 *   3. ensure a Lambda execution role (basic CloudWatch logging)
 *   4. create or update the function (provided.al2023 + Bun layer + handler)
 *   5. ensure a public Function URL and print a curl command
 *
 * ── THIS MAKES REAL AWS CALLS. It is not part of staging. ──
 *
 * Target account = whatever AWS_PROFILE / env credentials resolve to.
 * For paweldregan (account 923076644019):
 *
 *   bun build-layer.ts --arch arm64
 *   AWS_PROFILE=stacks bun deploy.ts --arch arm64
 *
 * Env overrides: AWS_REGION, FN_NAME, DEPLOY_BUCKET, ARCH.
 */
import { rm } from 'node:fs/promises'
import { $ } from 'bun'
import { IAMClient } from '../../packages/ts-cloud/src/aws/iam'
import { LambdaClient } from '../../packages/ts-cloud/src/aws/lambda'
import { S3Client } from '../../packages/ts-cloud/src/aws/s3'
import { STSClient } from '../../packages/ts-cloud/src/aws/sts'

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const ARCH = flag('arch', process.env.ARCH ?? 'arm64') as 'arm64' | 'x86_64'
const NAME = process.env.FN_NAME ?? 'bun-poc-api'
const ROLE_NAME = `${NAME}-exec`
const LAYER_NAME = `bun-runtime-${ARCH}`
const BASIC_EXEC_POLICY = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'

const here = import.meta.dir
const layerZip = `${here}/bun-lambda-layer-${ARCH}.zip`

const lambda = new LambdaClient(REGION)
const iam = new IAMClient(REGION)
const s3 = new S3Client(REGION)
const sts = new STSClient(REGION)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!(await Bun.file(layerZip).exists()))
    throw new Error(`Layer zip not found: ${layerZip}\n  Run: bun build-layer.ts --arch ${ARCH}`)

  const { Account } = await sts.getCallerIdentity()
  const bucket = process.env.DEPLOY_BUCKET ?? `${NAME}-deploy-${Account}`
  console.log(`Account ${Account} · region ${REGION} · arch ${ARCH}`)

  // 1. deployment bucket ------------------------------------------------------
  if (!(await s3.bucketExists(bucket))) {
    console.log(`Creating deployment bucket ${bucket}`)
    await s3.createBucket(bucket)
  }

  // 2. publish the Bun runtime layer -----------------------------------------
  const layerKey = `layers/${LAYER_NAME}-${Date.now()}.zip`
  console.log(`Uploading layer -> s3://${bucket}/${layerKey}`)
  await s3.putObject({
    bucket,
    key: layerKey,
    body: Buffer.from(await Bun.file(layerZip).arrayBuffer()),
    contentType: 'application/zip',
  })
  const layer = await lambda.publishLayerVersion({
    LayerName: LAYER_NAME,
    Description: 'Bun custom runtime',
    Content: { S3Bucket: bucket, S3Key: layerKey },
    CompatibleRuntimes: ['provided.al2023'],
    CompatibleArchitectures: [ARCH],
  })
  const layerArn = layer.LayerVersionArn!
  console.log(`Published layer ${layerArn}`)

  // 3. execution role ---------------------------------------------------------
  let roleArn: string
  try {
    const role = await iam.getRole({ RoleName: ROLE_NAME })
    roleArn = role.Arn
    console.log(`Using existing role ${roleArn}`)
  } catch {
    console.log(`Creating role ${ROLE_NAME}`)
    const role = await iam.createRole({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      }),
      Description: 'Execution role for the Bun-on-Lambda PoC',
    })
    await iam.attachRolePolicy({ RoleName: ROLE_NAME, PolicyArn: BASIC_EXEC_POLICY })
    roleArn = role.Arn
    console.log(`Created role ${roleArn} — waiting for IAM propagation...`)
    await sleep(12_000)
  }

  // 4. package the handler ----------------------------------------------------
  const build = `${here}/.build`
  const handlerZip = `${build}/handler.zip`
  await rm(build, { recursive: true, force: true })
  await $`mkdir -p ${build}`
  await $`cd ${here}/handler && zip -r -q -X ${handlerZip} index.ts`
  const code = Buffer.from(await Bun.file(handlerZip).arrayBuffer()).toString('base64')

  // 5. create or update the function -----------------------------------------
  let exists = true
  try {
    await lambda.getFunction(NAME)
  } catch {
    exists = false
  }

  if (exists) {
    console.log(`Updating function ${NAME}`)
    await lambda.updateFunctionCode({ FunctionName: NAME, ZipFile: code, Architectures: [ARCH] })
    await sleep(3000) // code update must settle before a config update
    await lambda.updateFunctionConfiguration({
      FunctionName: NAME,
      Runtime: 'provided.al2023',
      Handler: 'index.fetch',
      Layers: [layerArn],
    })
  } else {
    console.log(`Creating function ${NAME}`)
    // New roles can briefly fail to assume; retry a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        await lambda.createFunction({
          FunctionName: NAME,
          Runtime: 'provided.al2023',
          Role: roleArn,
          Handler: 'index.fetch',
          Architectures: [ARCH],
          Layers: [layerArn],
          MemorySize: 256,
          Timeout: 15,
          Code: { ZipFile: code },
          Description: 'Bun-on-Lambda PoC (issue #117)',
        })
        break
      } catch (err: any) {
        if (attempt >= 5 || !/assume|role/i.test(String(err?.message))) throw err
        console.log(`  role not assumable yet (attempt ${attempt}), retrying...`)
        await sleep(5000)
      }
    }
  }

  // 6. public Function URL ----------------------------------------------------
  let url: string | undefined
  try {
    url = (await lambda.getFunctionUrl(NAME))?.FunctionUrl
  } catch {
    const created = await lambda.createFunctionUrl({
      FunctionName: NAME,
      AuthType: 'NONE',
      Cors: { AllowOrigins: ['*'], AllowMethods: ['*'], AllowHeaders: ['*'] },
    })
    await lambda.addFunctionUrlPermission(NAME)
    url = created.FunctionUrl
  }

  console.log(`\n✓ Deployed. Function URL:\n  ${url}`)
  console.log(`\nTest it:\n  curl ${url?.replace(/\/$/, '')}/health`)
}

main().catch((err) => {
  console.error('Deploy failed:', err)
  process.exit(1)
})
