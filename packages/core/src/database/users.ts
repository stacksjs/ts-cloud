/**
 * Database User Management
 * User creation, permissions, and access control
 */

export interface DatabaseUser {
  id: string
  username: string
  database: string
  privileges: DatabasePrivilege[]
  passwordSecretArn?: string
  createdAt: Date
  lastRotated?: Date
  rotationEnabled?: boolean
  rotationDays?: number
}

export interface DatabasePrivilege {
  database?: string
  table?: string
  privileges: PrivilegeType[]
}

export type PrivilegeType =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'CREATE'
  | 'DROP'
  | 'ALTER'
  | 'INDEX'
  | 'EXECUTE'
  | 'ALL'

export interface UserRole {
  id: string
  name: string
  description?: string
  privileges: DatabasePrivilege[]
  users: string[] // user IDs
}

export interface AccessAudit {
  id: string
  username: string
  action: 'LOGIN' | 'QUERY' | 'MODIFY' | 'GRANT' | 'REVOKE'
  database?: string
  table?: string
  query?: string
  timestamp: Date
  success: boolean
  ipAddress?: string
}

/**
 * Database user manager
 */
export class DatabaseUserManager {
  private users: Map<string, DatabaseUser> = new Map()
  private roles: Map<string, UserRole> = new Map()
  private audits: Map<string, AccessAudit> = new Map()
  private userCounter = 0
  private roleCounter = 0
  private auditCounter = 0

  /**
   * Create database user
   */
  createUser(user: Omit<DatabaseUser, 'id' | 'createdAt'>): DatabaseUser {
    const id = `db-user-${Date.now()}-${this.userCounter++}`

    const dbUser: DatabaseUser = {
      id,
      createdAt: new Date(),
      ...user,
    }

    this.users.set(id, dbUser)

    return dbUser
  }

  /**
   * Create read-only user
   */
  createReadOnlyUser(options: {
    username: string
    database: string
    passwordSecretArn?: string
    tables?: string[]
  }): DatabaseUser {
    const privileges: DatabasePrivilege[] = options.tables
      ? options.tables.map(table => ({
          database: options.database,
          table,
          privileges: ['SELECT' as PrivilegeType],
        }))
      : [
          {
            database: options.database,
            privileges: ['SELECT' as PrivilegeType],
          },
        ]

    return this.createUser({
      username: options.username,
      database: options.database,
      privileges,
      passwordSecretArn: options.passwordSecretArn,
      rotationEnabled: true,
      rotationDays: 90,
    })
  }

  /**
   * Create read-write user
   */
  createReadWriteUser(options: {
    username: string
    database: string
    passwordSecretArn?: string
    tables?: string[]
  }): DatabaseUser {
    const privileges: DatabasePrivilege[] = options.tables
      ? options.tables.map(table => ({
          database: options.database,
          table,
          privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as PrivilegeType[],
        }))
      : [
          {
            database: options.database,
            privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as PrivilegeType[],
          },
        ]

    return this.createUser({
      username: options.username,
      database: options.database,
      privileges,
      passwordSecretArn: options.passwordSecretArn,
      rotationEnabled: true,
      rotationDays: 60,
    })
  }

  /**
   * Create admin user
   */
  createAdminUser(options: {
    username: string
    database: string
    passwordSecretArn?: string
  }): DatabaseUser {
    return this.createUser({
      username: options.username,
      database: options.database,
      privileges: [
        {
          database: options.database,
          privileges: ['ALL' as PrivilegeType],
        },
      ],
      passwordSecretArn: options.passwordSecretArn,
      rotationEnabled: true,
      rotationDays: 30,
    })
  }

  /**
   * Create application user with specific table access
   */
  createApplicationUser(options: {
    username: string
    database: string
    tables: { name: string; privileges: PrivilegeType[] }[]
    passwordSecretArn?: string
  }): DatabaseUser {
    const privileges: DatabasePrivilege[] = options.tables.map(table => ({
      database: options.database,
      table: table.name,
      privileges: table.privileges,
    }))

    return this.createUser({
      username: options.username,
      database: options.database,
      privileges,
      passwordSecretArn: options.passwordSecretArn,
      rotationEnabled: true,
      rotationDays: 90,
    })
  }

  /**
   * Create user role
   */
  createRole(role: Omit<UserRole, 'id' | 'users'>): UserRole {
    const id = `role-${Date.now()}-${this.roleCounter++}`

    const userRole: UserRole = {
      id,
      users: [],
      ...role,
    }

    this.roles.set(id, userRole)

    return userRole
  }

  /**
   * Assign user to role
   */
  assignUserToRole(userId: string, roleId: string): void {
    const user = this.users.get(userId)
    const role = this.roles.get(roleId)

    if (!user) {
      throw new Error(`User not found: ${userId}`)
    }

    if (!role) {
      throw new Error(`Role not found: ${roleId}`)
    }

    role.users.push(userId)

    // Merge role privileges with user privileges
    for (const privilege of role.privileges) {
      const existingPrivilege = user.privileges.find(
        p => p.database === privilege.database && p.table === privilege.table
      )

      if (existingPrivilege) {
        // Merge privileges
        existingPrivilege.privileges = Array.from(
          new Set([...existingPrivilege.privileges, ...privilege.privileges])
        )
      } else {
        user.privileges.push({ ...privilege })
      }
    }
  }

  /**
   * Grant privileges to user
   */
  grantPrivileges(
    userId: string,
    privileges: DatabasePrivilege[]
  ): { success: boolean; message: string } {
    const user = this.users.get(userId)

    if (!user) {
      return { success: false, message: 'User not found' }
    }

    for (const privilege of privileges) {
      const existing = user.privileges.find(
        p => p.database === privilege.database && p.table === privilege.table
      )

      if (existing) {
        existing.privileges = Array.from(new Set([...existing.privileges, ...privilege.privileges]))
      } else {
        user.privileges.push(privilege)
      }
    }

    this.auditAccess({
      username: user.username,
      action: 'GRANT',
      database: privileges[0]?.database,
      table: privileges[0]?.table,
      success: true,
    })

    return { success: true, message: 'Privileges granted successfully' }
  }

  /**
   * Revoke privileges from user
   */
  revokePrivileges(
    userId: string,
    privileges: DatabasePrivilege[]
  ): { success: boolean; message: string } {
    const user = this.users.get(userId)

    if (!user) {
      return { success: false, message: 'User not found' }
    }

    for (const privilege of privileges) {
      const existingIndex = user.privileges.findIndex(
        p => p.database === privilege.database && p.table === privilege.table
      )

      if (existingIndex !== -1) {
        const existing = user.privileges[existingIndex]
        existing.privileges = existing.privileges.filter(
          p => !privilege.privileges.includes(p)
        )

        // Remove privilege entry if no privileges left
        if (existing.privileges.length === 0) {
          user.privileges.splice(existingIndex, 1)
        }
      }
    }

    this.auditAccess({
      username: user.username,
      action: 'REVOKE',
      database: privileges[0]?.database,
      table: privileges[0]?.table,
      success: true,
    })

    return { success: true, message: 'Privileges revoked successfully' }
  }

  /**
   * Rotate user password
   */
  rotatePassword(userId: string): { success: boolean; newSecretArn?: string } {
    const user = this.users.get(userId)

    if (!user) {
      return { success: false }
    }

    // In production, this would trigger Secrets Manager rotation
    const newSecretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:db-${user.username}-${Date.now()}`

    user.passwordSecretArn = newSecretArn
    user.lastRotated = new Date()

    console.log(`Password rotated for user: ${user.username}`)

    return { success: true, newSecretArn }
  }

  /**
   * Check if password rotation needed
   */
  needsPasswordRotation(userId: string): boolean {
    const user = this.users.get(userId)

    if (!user || !user.rotationEnabled || !user.lastRotated || !user.rotationDays) {
      return false
    }

    const daysSinceRotation =
      (Date.now() - user.lastRotated.getTime()) / (1000 * 60 * 60 * 24)

    return daysSinceRotation >= user.rotationDays
  }

  /**
   * Audit access
   */
  auditAccess(audit: Omit<AccessAudit, 'id' | 'timestamp'>): AccessAudit {
    const id = `audit-${Date.now()}-${this.auditCounter++}`

    const accessAudit: AccessAudit = {
      id,
      timestamp: new Date(),
      ...audit,
    }

    this.audits.set(id, accessAudit)

    return accessAudit
  }

  /**
   * Get user access history
   */
  getUserAccessHistory(username: string, limit: number = 100): AccessAudit[] {
    return Array.from(this.audits.values())
      .filter(audit => audit.username === username)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
  }

  /**
   * Get failed login attempts
   */
  getFailedLoginAttempts(username: string, hours: number = 24): AccessAudit[] {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000

    return Array.from(this.audits.values()).filter(
      audit =>
        audit.username === username &&
        audit.action === 'LOGIN' &&
        !audit.success &&
        audit.timestamp.getTime() > cutoffTime
    )
  }

  /**
   * Generate SQL for user creation
   */
  generateCreateUserSQL(user: DatabaseUser, engine: 'postgres' | 'mysql' = 'postgres'): string {
    const statements: string[] = []

    if (engine === 'postgres') {
      statements.push(`CREATE USER ${user.username} WITH PASSWORD '${user.passwordSecretArn}';`)

      for (const privilege of user.privileges) {
        if (privilege.privileges.includes('ALL')) {
          statements.push(`GRANT ALL PRIVILEGES ON DATABASE ${privilege.database} TO ${user.username};`)
        } else {
          const privs = privilege.privileges.join(', ')
          if (privilege.table) {
            statements.push(
              `GRANT ${privs} ON ${privilege.database}.${privilege.table} TO ${user.username};`
            )
          } else {
            statements.push(`GRANT ${privs} ON DATABASE ${privilege.database} TO ${user.username};`)
          }
        }
      }
    } else {
      // MySQL
      statements.push(
        `CREATE USER '${user.username}'@'%' IDENTIFIED BY '${user.passwordSecretArn}';`
      )

      for (const privilege of user.privileges) {
        const privs = privilege.privileges.includes('ALL')
          ? 'ALL PRIVILEGES'
          : privilege.privileges.join(', ')
        const target = privilege.table
          ? `${privilege.database}.${privilege.table}`
          : `${privilege.database}.*`

        statements.push(`GRANT ${privs} ON ${target} TO '${user.username}'@'%';`)
      }

      statements.push('FLUSH PRIVILEGES;')
    }

    return statements.join('\n')
  }

  /**
   * Get user
   */
  getUser(id: string): DatabaseUser | undefined {
    return this.users.get(id)
  }

  /**
   * List users
   */
  listUsers(): DatabaseUser[] {
    return Array.from(this.users.values())
  }

  /**
   * Get role
   */
  getRole(id: string): UserRole | undefined {
    return this.roles.get(id)
  }

  /**
   * List roles
   */
  listRoles(): UserRole[] {
    return Array.from(this.roles.values())
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.users.clear()
    this.roles.clear()
    this.audits.clear()
    this.userCounter = 0
    this.roleCounter = 0
    this.auditCounter = 0
  }
}

/**
 * Global database user manager instance
 */
export const databaseUserManager = new DatabaseUserManager()
