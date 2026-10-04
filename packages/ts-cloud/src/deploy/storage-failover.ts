/**
 * Deploy-time half of cross-region bucket failover (stacksjs/stacks#1159).
 *
 * The generated stack replicates a website bucket into a replica in another
 * region and puts both behind one CloudFront origin group, but it cannot
 * create the replica: a CloudFormation stack only makes buckets in its own
 * region. The template lists the replicas it needs under
 * `Metadata['TsCloud::StorageFailover']` (read it with
 * `storageFailoverReplicasFromTemplate`), and a deployer runs:
 *
 * 1. {@link ensureFailoverReplicaBuckets} before creating or updating the
 *    stack, because S3 rejects a replication rule whose destination bucket is
 *    missing or unversioned;
 * 2. {@link grantFailoverReplicaAccess} after the stack, once the
 *    distribution exists, so origin access control can read the replica;
 * 3. {@link seedFailoverReplicas} after uploading content, to copy across
 *    objects written before replication was turned on (S3 replication only
 *    copies new writes).
 *
 * {@link deleteFailoverReplicaBuckets} removes them again; nothing calls it
 * automatically, since the replica is the copy that survives losing the stack.
 */

import type { StorageFailoverReplica } from '@ts-cloud/core'
import { buildFailoverReplicaPolicyStatement, FAILOVER_REPLICA_POLICY_SID } from '@ts-cloud/core'
import { S3Client } from '../aws/s3'

export type FailoverLogger = (message: string) => void

const noop: FailoverLogger = () => {}

/**
 * Create each replica bucket if it is missing, and make sure it is private,
 * encrypted, and (when the primary replicates into it) versioned. Idempotent.
 *
 * @throws when the bucket name is taken in another region or by another account.
 */
export async function ensureFailoverReplicaBuckets(
  replicas: readonly StorageFailoverReplica[],
  log: FailoverLogger = noop,
): Promise<void> {
  for (const replica of replicas) {
    const s3 = new S3Client(replica.replicaRegion)
    let head: { exists: boolean; region?: string }
    try {
      head = await s3.headBucket(replica.replicaBucket)
    } catch (error: any) {
      if (error?.statusCode === 301) {
        throw new Error(
          `Failover replica bucket ${replica.replicaBucket} already exists outside ${replica.replicaRegion}. Pick another failover.bucket or region for infrastructure.storage.${replica.name}.`,
        )
      }
      if (error?.statusCode === 403) {
        throw new Error(
          `Failover replica bucket ${replica.replicaBucket} exists but this account cannot reach it (S3 names are global, so another account may own it). Set infrastructure.storage.${replica.name}.failover.bucket to a name you own.`,
        )
      }
      throw error
    }

    if (head.exists && head.region && head.region !== replica.replicaRegion) {
      throw new Error(
        `Failover replica bucket ${replica.replicaBucket} is in ${head.region}, not ${replica.replicaRegion}.`,
      )
    }
    if (!head.exists) {
      log(`Creating failover replica bucket ${replica.replicaBucket} in ${replica.replicaRegion}`)
      await s3.createBucket(replica.replicaBucket)
    }

    await s3.putPublicAccessBlock(replica.replicaBucket, {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      // The replica's only reader is CloudFront through a service-principal
      // policy, which is not a public policy, so this can stay fully blocked.
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    })
    await s3.putBucketEncryption(replica.replicaBucket, 'AES256')
    if (replica.replicate) {
      const versioning = await s3.getBucketVersioning(replica.replicaBucket)
      if (versioning.Status !== 'Enabled') {
        log(`Enabling versioning on ${replica.replicaBucket} (S3 replication requires it)`)
        await s3.putBucketVersioning(replica.replicaBucket, 'Enabled')
      }
    }
  }
}

/**
 * Let each stack's distribution read its replica through origin access
 * control, by adding (or replacing) one statement in the replica's bucket
 * policy. Other statements in that policy are kept.
 *
 * @param outputs The stack outputs; each replica names the output holding its distribution ARN.
 * @throws when an output is missing, which means the stack did not deploy the distribution.
 */
export async function grantFailoverReplicaAccess(
  replicas: readonly StorageFailoverReplica[],
  outputs: Record<string, string>,
  log: FailoverLogger = noop,
): Promise<void> {
  for (const replica of replicas) {
    const distributionArn = outputs[replica.distributionArnOutput]
    if (!distributionArn) {
      throw new Error(
        `Stack output ${replica.distributionArnOutput} is missing, so the failover replica ${replica.replicaBucket} cannot be scoped to its distribution.`,
      )
    }

    const s3 = new S3Client(replica.replicaRegion)
    const existing = (await s3.getBucketPolicy(replica.replicaBucket)) as { Statement?: any[] } | null
    const kept = (existing?.Statement ?? []).filter((statement) => statement?.Sid !== FAILOVER_REPLICA_POLICY_SID)
    const policy = {
      Version: '2012-10-17',
      Statement: [
        ...kept,
        buildFailoverReplicaPolicyStatement({ replicaBucket: replica.replicaBucket, distributionArn }),
      ],
    }
    log(`Granting ${distributionArn} read access to ${replica.replicaBucket}`)
    await s3.putBucketPolicy(replica.replicaBucket, policy)
  }
}

/**
 * Copy objects the replica is missing (or holds at a different size) from the
 * primary. S3 replication only copies writes made after it was configured, so
 * a site that turns failover on later would otherwise fail over to an empty
 * bucket. Objects are copied server side.
 *
 * @returns how many objects were copied per replica.
 */
export async function seedFailoverReplicas(
  replicas: readonly StorageFailoverReplica[],
  log: FailoverLogger = noop,
): Promise<Record<string, number>> {
  const copied: Record<string, number> = {}
  for (const replica of replicas) {
    const primary = new S3Client(replica.primaryRegion)
    const secondary = new S3Client(replica.replicaRegion)
    const [source, target] = await Promise.all([
      primary.listAllObjects({ bucket: replica.primaryBucket }),
      secondary.listAllObjects({ bucket: replica.replicaBucket }),
    ])
    const have = new Map(target.map((object) => [object.Key, object.Size]))
    const missing = source.filter((object) => have.get(object.Key) !== object.Size)

    for (const object of missing) {
      await secondary.copyObject({
        sourceBucket: replica.primaryBucket,
        sourceKey: object.Key,
        destinationBucket: replica.replicaBucket,
        destinationKey: object.Key,
      })
    }
    if (missing.length > 0) log(`Copied ${missing.length} object(s) from ${replica.primaryBucket} to ${replica.replicaBucket}`)
    copied[replica.replicaBucket] = missing.length
  }
  return copied
}

/**
 * Empty (every version and delete marker) and delete each replica bucket.
 * Never called by a deploy: use it to tear down a site you are removing.
 */
export async function deleteFailoverReplicaBuckets(
  replicas: readonly StorageFailoverReplica[],
  log: FailoverLogger = noop,
): Promise<void> {
  for (const replica of replicas) {
    const s3 = new S3Client(replica.replicaRegion)
    const head = await s3.headBucket(replica.replicaBucket)
    if (!head.exists) continue
    await s3.emptyBucket(replica.replicaBucket)
    await s3.deleteBucket(replica.replicaBucket)
    log(`Deleted failover replica bucket ${replica.replicaBucket}`)
  }
}
