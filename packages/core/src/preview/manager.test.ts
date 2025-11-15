import { describe, expect, it, beforeEach } from 'bun:test'
import { PreviewEnvironmentManager } from './manager'

describe('PreviewEnvironmentManager', () => {
  let manager: PreviewEnvironmentManager

  beforeEach(() => {
    manager = new PreviewEnvironmentManager()
  })

  describe('createPreviewEnvironment', () => {
    it('should create preview environment from PR', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        pr: 42,
        commitSha: 'abc123def456',
        ttl: 24,
        baseConfig: {
          project: { name: 'Test Project', slug: 'test-project' },
        } as any,
      })

      expect(env).toBeDefined()
      expect(env.name).toBe('pr-42')
      expect(env.branch).toBe('feature/auth')
      expect(env.pr).toBe(42)
      expect(env.commitSha).toBe('abc123def456')
      expect(env.status).toBe('active')
      expect(env.stackName).toBe('preview-pr-42')
    })

    it('should create preview environment from branch without PR', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123def456',
        baseConfig: {
          project: { name: 'Test Project', slug: 'test-project' },
        } as any,
      })

      expect(env).toBeDefined()
      expect(env.name).toBe('feature-auth')
      expect(env.pr).toBeUndefined()
    })

    it('should set expiration based on TTL', async () => {
      const before = new Date()
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        ttl: 48, // 48 hours
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })
      const after = new Date()

      const expectedExpiration = new Date(before.getTime() + 48 * 60 * 60 * 1000)
      const timeDiff = Math.abs(env.expiresAt.getTime() - expectedExpiration.getTime())

      // Should be within 1 second of expected
      expect(timeDiff).toBeLessThan(1000)
    })

    it('should default TTL to 24 hours', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const now = new Date()
      const hoursDiff = (env.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60)

      expect(hoursDiff).toBeGreaterThan(23)
      expect(hoursDiff).toBeLessThan(25)
    })

    it('should sanitize branch names', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/AUTH#123',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      expect(env.name).toBe('feature-auth-123')
      expect(env.name).toMatch(/^[a-z0-9-]+$/)
    })

    it('should generate unique IDs', async () => {
      const env1 = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        pr: 42,
        commitSha: 'abc123def456',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const env2 = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        pr: 42,
        commitSha: 'xyz789uvw012',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      expect(env1.id).not.toBe(env2.id)
    })
  })

  describe('destroyPreviewEnvironment', () => {
    it('should destroy preview environment', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      await manager.destroyPreviewEnvironment(env.id)

      const retrieved = manager.getPreviewEnvironment(env.id)
      expect(retrieved).toBeUndefined()
    })

    it('should throw error for non-existent environment', async () => {
      expect(async () => {
        await manager.destroyPreviewEnvironment('non-existent-id')
      }).toThrow('not found')
    })
  })

  describe('getPreviewEnvironment', () => {
    it('should get environment by ID', async () => {
      const created = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const retrieved = manager.getPreviewEnvironment(created.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(created.id)
    })

    it('should return undefined for non-existent ID', () => {
      const retrieved = manager.getPreviewEnvironment('non-existent')
      expect(retrieved).toBeUndefined()
    })
  })

  describe('getPreviewEnvironmentByBranch', () => {
    it('should get environment by branch name', async () => {
      await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const retrieved = manager.getPreviewEnvironmentByBranch('feature/auth')

      expect(retrieved).toBeDefined()
      expect(retrieved?.branch).toBe('feature/auth')
    })

    it('should return undefined for non-existent branch', () => {
      const retrieved = manager.getPreviewEnvironmentByBranch('non-existent')
      expect(retrieved).toBeUndefined()
    })
  })

  describe('getPreviewEnvironmentByPR', () => {
    it('should get environment by PR number', async () => {
      await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        pr: 42,
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const retrieved = manager.getPreviewEnvironmentByPR(42)

      expect(retrieved).toBeDefined()
      expect(retrieved?.pr).toBe(42)
    })

    it('should return undefined for non-existent PR', () => {
      const retrieved = manager.getPreviewEnvironmentByPR(999)
      expect(retrieved).toBeUndefined()
    })
  })

  describe('listPreviewEnvironments', () => {
    it('should list all environments', async () => {
      await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      await manager.createPreviewEnvironment({
        branch: 'feature/payments',
        commitSha: 'def456',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const envs = manager.listPreviewEnvironments()

      expect(envs).toHaveLength(2)
    })

    it('should return empty array when no environments', () => {
      const envs = manager.listPreviewEnvironments()
      expect(envs).toEqual([])
    })
  })

  describe('listActivePreviewEnvironments', () => {
    it('should only list active environments', async () => {
      await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const env2 = await manager.createPreviewEnvironment({
        branch: 'feature/payments',
        commitSha: 'def456',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      // Destroy one environment
      await manager.destroyPreviewEnvironment(env2.id)

      const activeEnvs = manager.listActivePreviewEnvironments()

      expect(activeEnvs).toHaveLength(1)
      expect(activeEnvs[0].branch).toBe('feature/auth')
    })
  })

  describe('cleanupExpiredEnvironments', () => {
    it('should cleanup expired environments by TTL', async () => {
      // Create environment with expired TTL
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        ttl: -1, // Already expired
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const result = await manager.cleanupExpiredEnvironments()

      expect(result.destroyed).toContain(env.id)
      expect(result.failed).toHaveLength(0)
    })

    it('should cleanup environments older than maxAge', async () => {
      // Create environment and manually set old creation date
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      // Manually set old creation date (hack for testing)
      const retrieved = manager.getPreviewEnvironment(env.id)
      if (retrieved) {
        retrieved.createdAt = new Date(Date.now() - 50 * 60 * 60 * 1000) // 50 hours ago
      }

      const result = await manager.cleanupExpiredEnvironments({
        maxAge: 48, // 48 hours
      })

      expect(result.destroyed).toContain(env.id)
    })

    it('should keep only N most recent environments', async () => {
      const env1 = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      // Wait a tiny bit to ensure different creation times
      await new Promise(resolve => setTimeout(resolve, 10))

      const env2 = await manager.createPreviewEnvironment({
        branch: 'feature/payments',
        commitSha: 'def456',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      const env3 = await manager.createPreviewEnvironment({
        branch: 'feature/search',
        commitSha: 'ghi789',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const result = await manager.cleanupExpiredEnvironments({
        keepCount: 2,
      })

      expect(result.destroyed).toHaveLength(1)
      expect(result.destroyed).toContain(env1.id)
      expect(result.destroyed).not.toContain(env2.id)
      expect(result.destroyed).not.toContain(env3.id)
    })

    it('should support dry run mode', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        ttl: -1, // Already expired
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const result = await manager.cleanupExpiredEnvironments({
        dryRun: true,
      })

      expect(result.destroyed).toContain(env.id)

      // Environment should still exist
      const retrieved = manager.getPreviewEnvironment(env.id)
      expect(retrieved).toBeDefined()
    })

    it('should not cleanup active non-expired environments', async () => {
      await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        ttl: 48, // Not expired
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const result = await manager.cleanupExpiredEnvironments()

      expect(result.destroyed).toHaveLength(0)
      expect(result.failed).toHaveLength(0)
    })
  })

  describe('updatePreviewEnvironment', () => {
    it('should update environment with new commit', async () => {
      const env = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const updated = await manager.updatePreviewEnvironment(env.id, 'def456')

      expect(updated.commitSha).toBe('def456')
      expect(updated.status).toBe('active')
    })

    it('should throw error for non-existent environment', async () => {
      expect(async () => {
        await manager.updatePreviewEnvironment('non-existent', 'abc123')
      }).toThrow('not found')
    })
  })

  describe('getPreviewEnvironmentsCost', () => {
    it('should return cost summary', async () => {
      const env1 = await manager.createPreviewEnvironment({
        branch: 'feature/auth',
        commitSha: 'abc123',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const env2 = await manager.createPreviewEnvironment({
        branch: 'feature/payments',
        commitSha: 'def456',
        baseConfig: {
          project: { name: 'Test', slug: 'test' },
        } as any,
      })

      const cost = await manager.getPreviewEnvironmentsCost()

      expect(cost).toBeDefined()
      expect(cost.total).toBeDefined()
      expect(cost.byEnvironment).toBeDefined()
      expect(cost.byEnvironment[env1.id]).toBeDefined()
      expect(cost.byEnvironment[env2.id]).toBeDefined()
    })

    it('should return zero cost for empty environments', async () => {
      const cost = await manager.getPreviewEnvironmentsCost()

      expect(cost.total).toBe(0)
      expect(Object.keys(cost.byEnvironment)).toHaveLength(0)
    })
  })
})
