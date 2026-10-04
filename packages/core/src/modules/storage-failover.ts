/**
 * Cross-region failover for a website bucket (stacksjs/stacks#1159).
 *
 * The CloudFront half is an origin group (see `cdn-failover.ts`): the primary
 * bucket first, a replica bucket in another region second. This module holds
 * the pure pieces the bucket half needs:
 *
 * - {@link resolveStorageFailover} turns `infrastructure.storage.<name>.failover`
 *   into a concrete plan (replica name and region, status codes, connection
 *   tuning) and rejects configs CloudFront or S3 would refuse later.
 * - {@link buildReplicationRole} and {@link buildReplicationConfiguration}
 *   emit the IAM role and `ReplicationConfiguration` that copy every write to
 *   the replica.
 * - {@link STORAGE_FAILOVER_METADATA_KEY} names the template `Metadata` entry
 *   that tells a deployer which replicas to create before the stack and grant
 *   CloudFront access to after it. The replica cannot live in the stack: a
 *   CloudFormation stack only creates buckets in its own region.
 */

import type { StorageFailoverConfig } from '../types'
import { resolveFailoverStatusCodes, resolveOriginConnection } from './cdn-failover'

/**
 * Failover codes for a bucket origin when none are given. An S3 origin behind
 * origin access control answers a missing object with 403 (the distribution
 * may not list the bucket), so 403 and 404 cover an object the primary lost;
 * the 5xx codes cover the bucket or its region failing.
 */
export const DEFAULT_STORAGE_FAILOVER_STATUS_CODES: readonly number[] = [403, 404, 500, 502, 503, 504]

/** Template `Metadata` key listing the failover replicas a stack depends on. */
export const STORAGE_FAILOVER_METADATA_KEY = 'TsCloud::StorageFailover'

/** Sid of the replica bucket-policy statement that lets the distribution read it. */
export const FAILOVER_REPLICA_POLICY_SID = 'AllowCloudFrontFailoverRead'

/** One replica, as recorded in the template metadata and consumed by the deployer. */
export interface StorageFailoverReplica {
  /** `infrastructure.storage` key. */
  name: string
  primaryBucket: string
  primaryRegion: string
  replicaBucket: string
  replicaRegion: string
  /** Whether S3 replication copies writes to the replica (and so whether it must be versioned). */
  replicate: boolean
  /** Stack output holding the distribution ARN the replica policy is scoped to. */
  distributionArnOutput: string
}

export interface ResolvedStorageFailover {
  replicaBucket: string
  replicaRegion: string
  replicate: boolean
  statusCodes: number[]
  primaryConnection: { ConnectionAttempts?: number; ConnectionTimeout?: number }
}

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/**
 * Resolve and validate a bucket's failover config.
 *
 * @param where Names the bucket in errors, e.g. `infrastructure.storage.public`.
 * @throws when the region is missing, malformed or the primary's own region,
 * when the replica name is not a valid bucket name (or collides with the
 * primary), or when a status code or connection setting is out of range.
 */
export function resolveStorageFailover(options: {
  failover: StorageFailoverConfig
  primaryBucket: string
  primaryRegion: string
  where?: string
}): ResolvedStorageFailover {
  const { failover, primaryBucket, primaryRegion } = options
  const where = options.where ?? 'storage failover'

  if (!failover || typeof failover !== 'object') {
    throw new Error(`${where}.failover must be an object such as { region: 'us-west-2' }.`)
  }
  if (!failover.region || !REGION.test(failover.region)) {
    throw new Error(
      `${where}.failover.region must be an AWS region such as 'us-west-2', got ${JSON.stringify(failover.region)}.`,
    )
  }
  if (failover.region === primaryRegion) {
    throw new Error(
      `${where}.failover.region is ${failover.region}, the same region as the primary bucket. Failover only helps when the replica is in another region.`,
    )
  }

  const replicaBucket = failover.bucket ?? `${primaryBucket}-${failover.region}`
  if (!BUCKET_NAME.test(replicaBucket) || replicaBucket.includes('..')) {
    const hint =
      failover.bucket === undefined && replicaBucket.length > 63
        ? ` The default name (<primary bucket>-<region>) is ${replicaBucket.length} characters; S3 allows 63. Set ${where}.failover.bucket.`
        : ''
    throw new Error(`${where}.failover: "${replicaBucket}" is not a valid S3 bucket name.${hint}`)
  }
  if (replicaBucket === primaryBucket) {
    throw new Error(`${where}.failover.bucket must differ from the primary bucket "${primaryBucket}".`)
  }

  return {
    replicaBucket,
    replicaRegion: failover.region,
    replicate: failover.replicate !== false,
    statusCodes: resolveFailoverStatusCodes(failover.statusCodes ?? DEFAULT_STORAGE_FAILOVER_STATUS_CODES),
    primaryConnection: resolveOriginConnection(failover, `${where}.failover`),
  }
}

/** S3 REST endpoint of a bucket, the domain a CloudFront S3 origin uses. */
export function s3RegionalDomain(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`
}

/**
 * IAM role S3 assumes to replicate `primaryBucket` into `replicaBucket`. The
 * permissions are the minimum the S3 docs list for live replication,
 * including delete markers.
 */
export function buildReplicationRole(options: { primaryBucket: string; replicaBucket: string; roleName?: string }): any {
  const source = `arn:aws:s3:::${options.primaryBucket}`
  const destination = `arn:aws:s3:::${options.replicaBucket}`
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      ...(options.roleName ? { RoleName: options.roleName } : {}),
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      Policies: [
        {
          PolicyName: 'failover-replication',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: ['s3:GetReplicationConfiguration', 's3:ListBucket'], Resource: source },
              {
                Effect: 'Allow',
                Action: ['s3:GetObjectVersionForReplication', 's3:GetObjectVersionAcl', 's3:GetObjectVersionTagging'],
                Resource: `${source}/*`,
              },
              {
                Effect: 'Allow',
                Action: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags'],
                Resource: `${destination}/*`,
              },
            ],
          },
        },
      ],
    },
  }
}

/**
 * `ReplicationConfiguration` for the primary bucket: one rule copying every
 * object, and its deletes, to the replica.
 *
 * @param roleArn The replication role's ARN, usually `{ 'Fn::GetAtt': [roleLogicalId, 'Arn'] }`.
 */
export function buildReplicationConfiguration(options: { replicaBucket: string; roleArn: unknown }): any {
  return {
    Role: options.roleArn,
    Rules: [
      {
        Id: 'cloudfront-failover-replica',
        Status: 'Enabled',
        Priority: 1,
        Filter: { Prefix: '' },
        DeleteMarkerReplication: { Status: 'Enabled' },
        Destination: { Bucket: `arn:aws:s3:::${options.replicaBucket}` },
      },
    ],
  }
}

/**
 * The replica bucket-policy statement that lets one distribution, through
 * origin access control, read the replica.
 */
export function buildFailoverReplicaPolicyStatement(options: { replicaBucket: string; distributionArn: string }): any {
  return {
    Sid: FAILOVER_REPLICA_POLICY_SID,
    Effect: 'Allow',
    Principal: { Service: 'cloudfront.amazonaws.com' },
    Action: 's3:GetObject',
    Resource: `arn:aws:s3:::${options.replicaBucket}/*`,
    Condition: { StringEquals: { 'AWS:SourceArn': options.distributionArn } },
  }
}

/** Read the failover replicas a generated template depends on (empty when none). */
export function storageFailoverReplicasFromTemplate(template: unknown): StorageFailoverReplica[] {
  const parsed = typeof template === 'string' ? JSON.parse(template) : template
  const replicas = (parsed as { Metadata?: Record<string, unknown> } | undefined)?.Metadata?.[STORAGE_FAILOVER_METADATA_KEY]
  return Array.isArray(replicas) ? (replicas as StorageFailoverReplica[]) : []
}
