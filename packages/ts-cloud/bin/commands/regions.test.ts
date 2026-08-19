import { describe, expect, it } from 'bun:test'
import { replicationKinds } from './regions'

describe('regional replication options', () => {
  it('normalizes supported replication kinds', () => {
    expect(replicationKinds('s3, dynamodb,secrets')).toEqual(['s3', 'dynamodb', 'secrets'])
  })

  it('rejects an unsupported replication kind before enqueueing work', () => {
    expect(() => replicationKinds('s3,rds')).toThrow('Unsupported replication kind: rds')
  })
})
