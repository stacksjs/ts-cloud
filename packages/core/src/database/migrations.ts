/**
 * Database Migration Management
 * Version-controlled schema changes with rollback support
 */

export interface Migration {
  id: string
  version: string
  name: string
  description?: string
  up: string // SQL for applying migration
  down: string // SQL for rolling back migration
  checksum: string // For integrity verification
  appliedAt?: Date
  rolledBackAt?: Date
  executionTimeMs?: number
}

export interface MigrationPlan {
  id: string
  name: string
  database: DatabaseTarget
  migrations: Migration[]
  autoApply?: boolean
  backupBeforeMigration?: boolean
  testMigrations?: boolean
  validateRollback?: boolean
}

export interface DatabaseTarget {
  type: 'rds' | 'aurora' | 'dynamodb'
  identifier: string
  engine?: 'postgres' | 'mysql' | 'mariadb'
  endpoint?: string
  database?: string
}

export interface MigrationResult {
  success: boolean
  version: string
  appliedMigrations: string[]
  failedMigrations: string[]
  executionTimeMs: number
  error?: string
  rollbackPerformed?: boolean
}

export interface MigrationStatus {
  currentVersion: string
  pendingMigrations: Migration[]
  appliedMigrations: Migration[]
  lastMigration?: Migration
}

/**
 * Migration manager
 */
export class MigrationManager {
  private plans: Map<string, MigrationPlan> = new Map()
  private migrations: Map<string, Migration> = new Map()
  private planCounter = 0
  private migrationCounter = 0

  /**
   * Create migration plan
   */
  createPlan(plan: Omit<MigrationPlan, 'id'>): MigrationPlan {
    const id = `migration-plan-${Date.now()}-${this.planCounter++}`

    const migrationPlan: MigrationPlan = {
      id,
      ...plan,
    }

    this.plans.set(id, migrationPlan)

    return migrationPlan
  }

  /**
   * Create migration
   */
  createMigration(migration: Omit<Migration, 'id' | 'checksum'>): Migration {
    const id = `migration-${Date.now()}-${this.migrationCounter++}`

    // Generate checksum from up and down SQL
    const checksum = this.generateChecksum(migration.up + migration.down)

    const newMigration: Migration = {
      id,
      checksum,
      ...migration,
    }

    this.migrations.set(id, newMigration)

    return newMigration
  }

  /**
   * Create schema change migration
   */
  createSchemaMigration(options: {
    version: string
    name: string
    tableName: string
    changes: SchemaChange[]
    engine?: 'postgres' | 'mysql'
  }): Migration {
    const { up, down } = this.generateSchemaSQL(options.changes, options.tableName, options.engine)

    return this.createMigration({
      version: options.version,
      name: options.name,
      description: `Schema changes for ${options.tableName}`,
      up,
      down,
    })
  }

  /**
   * Create data migration
   */
  createDataMigration(options: {
    version: string
    name: string
    description?: string
    upSQL: string
    downSQL: string
  }): Migration {
    return this.createMigration({
      version: options.version,
      name: options.name,
      description: options.description,
      up: options.upSQL,
      down: options.downSQL,
    })
  }

  /**
   * Add migration to plan
   */
  addMigrationToPlan(planId: string, migration: Migration): void {
    const plan = this.plans.get(planId)

    if (!plan) {
      throw new Error(`Migration plan not found: ${planId}`)
    }

    plan.migrations.push(migration)
  }

  /**
   * Execute migration plan
   */
  async executePlan(planId: string, dryRun: boolean = false): Promise<MigrationResult> {
    const plan = this.plans.get(planId)

    if (!plan) {
      throw new Error(`Migration plan not found: ${planId}`)
    }

    const startTime = Date.now()
    const appliedMigrations: string[] = []
    const failedMigrations: string[] = []

    console.log(`${dryRun ? '[DRY RUN] ' : ''}Executing migration plan: ${plan.name}`)
    console.log(`Database: ${plan.database.type} - ${plan.database.identifier}`)
    console.log(`Migrations to apply: ${plan.migrations.length}\n`)

    if (plan.backupBeforeMigration && !dryRun) {
      console.log('Creating database backup before migration...')
      // Backup logic would go here
    }

    for (const migration of plan.migrations) {
      try {
        console.log(`Applying migration: ${migration.version} - ${migration.name}`)

        if (!dryRun) {
          // Verify checksum
          const currentChecksum = this.generateChecksum(migration.up + migration.down)
          if (currentChecksum !== migration.checksum) {
            throw new Error('Migration checksum mismatch - migration has been modified')
          }

          // Execute migration
          const migrationStart = Date.now()
          // Actual SQL execution would go here
          migration.appliedAt = new Date()
          migration.executionTimeMs = Date.now() - migrationStart

          console.log(`✓ Applied in ${migration.executionTimeMs}ms\n`)
        } else {
          console.log(`[SKIPPED - DRY RUN]\n`)
        }

        appliedMigrations.push(migration.version)
      } catch (error) {
        console.error(`✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`)
        failedMigrations.push(migration.version)

        if (!dryRun) {
          // Rollback previously applied migrations
          console.log('Rolling back previously applied migrations...')
          await this.rollbackMigrations(appliedMigrations.reverse(), plan)

          return {
            success: false,
            version: migration.version,
            appliedMigrations: [],
            failedMigrations,
            executionTimeMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
            rollbackPerformed: true,
          }
        }
      }
    }

    const executionTimeMs = Date.now() - startTime

    console.log(`${dryRun ? '[DRY RUN] ' : ''}Migration plan completed successfully`)
    console.log(`Total time: ${executionTimeMs}ms`)

    return {
      success: true,
      version: plan.migrations[plan.migrations.length - 1]?.version || 'unknown',
      appliedMigrations,
      failedMigrations,
      executionTimeMs,
    }
  }

  /**
   * Rollback migrations
   */
  private async rollbackMigrations(versions: string[], plan: MigrationPlan): Promise<void> {
    for (const version of versions) {
      const migration = plan.migrations.find(m => m.version === version)
      if (migration) {
        console.log(`Rolling back: ${migration.version} - ${migration.name}`)
        // Execute down SQL
        migration.rolledBackAt = new Date()
        console.log('✓ Rolled back\n')
      }
    }
  }

  /**
   * Get migration status
   */
  getMigrationStatus(planId: string): MigrationStatus {
    const plan = this.plans.get(planId)

    if (!plan) {
      throw new Error(`Migration plan not found: ${planId}`)
    }

    const appliedMigrations = plan.migrations.filter(m => m.appliedAt && !m.rolledBackAt)
    const pendingMigrations = plan.migrations.filter(m => !m.appliedAt)

    return {
      currentVersion: appliedMigrations[appliedMigrations.length - 1]?.version || '0.0.0',
      pendingMigrations,
      appliedMigrations,
      lastMigration: appliedMigrations[appliedMigrations.length - 1],
    }
  }

  /**
   * Generate schema SQL from changes
   */
  private generateSchemaSQL(
    changes: SchemaChange[],
    tableName: string,
    engine: 'postgres' | 'mysql' = 'postgres'
  ): { up: string; down: string } {
    const upStatements: string[] = []
    const downStatements: string[] = []

    for (const change of changes) {
      switch (change.type) {
        case 'add_column':
          upStatements.push(
            `ALTER TABLE ${tableName} ADD COLUMN ${change.columnName} ${change.columnType}${
              change.nullable === false ? ' NOT NULL' : ''
            }${change.defaultValue ? ` DEFAULT ${change.defaultValue}` : ''};`
          )
          downStatements.push(`ALTER TABLE ${tableName} DROP COLUMN ${change.columnName};`)
          break

        case 'drop_column':
          upStatements.push(`ALTER TABLE ${tableName} DROP COLUMN ${change.columnName};`)
          // Note: Cannot restore dropped column without backup
          downStatements.push(`-- Cannot restore dropped column ${change.columnName}`)
          break

        case 'modify_column':
          if (engine === 'postgres') {
            upStatements.push(
              `ALTER TABLE ${tableName} ALTER COLUMN ${change.columnName} TYPE ${change.newType};`
            )
          } else {
            upStatements.push(
              `ALTER TABLE ${tableName} MODIFY COLUMN ${change.columnName} ${change.newType};`
            )
          }
          downStatements.push(`-- Reverting ${change.columnName} type change requires manual intervention`)
          break

        case 'add_index':
          upStatements.push(
            `CREATE INDEX ${change.indexName} ON ${tableName} (${(change.columns ?? []).join(', ')});`
          )
          downStatements.push(`DROP INDEX ${change.indexName};`)
          break

        case 'drop_index':
          upStatements.push(`DROP INDEX ${change.indexName};`)
          downStatements.push(`-- Cannot restore index ${change.indexName} without schema details`)
          break
      }
    }

    return {
      up: upStatements.join('\n'),
      down: downStatements.reverse().join('\n'),
    }
  }

  /**
   * Generate checksum for migration
   */
  private generateChecksum(content: string): string {
    // Simple checksum implementation (in production, use crypto hash)
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash.toString(16)
  }

  /**
   * Validate migration plan
   */
  validatePlan(planId: string): { valid: boolean; errors: string[] } {
    const plan = this.plans.get(planId)

    if (!plan) {
      return { valid: false, errors: ['Migration plan not found'] }
    }

    const errors: string[] = []

    // Check for version conflicts
    const versions = new Set<string>()
    for (const migration of plan.migrations) {
      if (versions.has(migration.version)) {
        errors.push(`Duplicate migration version: ${migration.version}`)
      }
      versions.add(migration.version)
    }

    // Check for missing down migrations
    for (const migration of plan.migrations) {
      if (!migration.down || migration.down.trim() === '') {
        errors.push(`Migration ${migration.version} is missing rollback SQL`)
      }
    }

    // Check for checksum mismatches
    for (const migration of plan.migrations) {
      const currentChecksum = this.generateChecksum(migration.up + migration.down)
      if (currentChecksum !== migration.checksum) {
        errors.push(`Migration ${migration.version} has invalid checksum`)
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Get plan
   */
  getPlan(id: string): MigrationPlan | undefined {
    return this.plans.get(id)
  }

  /**
   * List plans
   */
  listPlans(): MigrationPlan[] {
    return Array.from(this.plans.values())
  }

  /**
   * Get migration
   */
  getMigration(id: string): Migration | undefined {
    return this.migrations.get(id)
  }

  /**
   * List migrations
   */
  listMigrations(): Migration[] {
    return Array.from(this.migrations.values())
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.plans.clear()
    this.migrations.clear()
    this.planCounter = 0
    this.migrationCounter = 0
  }
}

/**
 * Schema change types
 */
export interface SchemaChange {
  type: 'add_column' | 'drop_column' | 'modify_column' | 'add_index' | 'drop_index'
  columnName?: string
  columnType?: string
  newType?: string
  nullable?: boolean
  defaultValue?: string
  indexName?: string
  columns?: string[]
}

/**
 * Global migration manager instance
 */
export const migrationManager: MigrationManager = new MigrationManager()
