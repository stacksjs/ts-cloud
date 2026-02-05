/**
 * AWS RDS Operations
 * Direct API calls without AWS CLI dependency
*/

import { AWSClient, buildQueryParams } from './client'

export interface DBInstance {
  DBInstanceIdentifier?: string
  DBInstanceClass?: string
  Engine?: string
  EngineVersion?: string
  DBInstanceStatus?: string
  MasterUsername?: string
  DBName?: string
  Endpoint?: {
    Address?: string
    Port?: number
    HostedZoneId?: string
  }
  AllocatedStorage?: number
  InstanceCreateTime?: string
  PreferredBackupWindow?: string
  BackupRetentionPeriod?: number
  DBSecurityGroups?: Array<{
    DBSecurityGroupName?: string
    Status?: string
  }>
  VpcSecurityGroups?: Array<{
    VpcSecurityGroupId?: string
    Status?: string
  }>
  DBParameterGroups?: Array<{
    DBParameterGroupName?: string
    ParameterApplyStatus?: string
  }>
  AvailabilityZone?: string
  DBSubnetGroup?: {
    DBSubnetGroupName?: string
    DBSubnetGroupDescription?: string
    VpcId?: string
    SubnetGroupStatus?: string
    Subnets?: Array<{
      SubnetIdentifier?: string
      SubnetAvailabilityZone?: { Name?: string }
      SubnetStatus?: string
    }>
  }
  PreferredMaintenanceWindow?: string
  PendingModifiedValues?: Record<string, any>
  MultiAZ?: boolean
  AutoMinorVersionUpgrade?: boolean
  ReadReplicaSourceDBInstanceIdentifier?: string
  ReadReplicaDBInstanceIdentifiers?: string[]
  LicenseModel?: string
  OptionGroupMemberships?: Array<{
    OptionGroupName?: string
    Status?: string
  }>
  PubliclyAccessible?: boolean
  StorageType?: string
  StorageEncrypted?: boolean
  KmsKeyId?: string
  DbiResourceId?: string
  CACertificateIdentifier?: string
  DeletionProtection?: boolean
  TagList?: Array<{ Key?: string; Value?: string }>
}

export interface DBCluster {
  DBClusterIdentifier?: string
  DBClusterArn?: string
  Status?: string
  Engine?: string
  EngineVersion?: string
  Endpoint?: string
  ReaderEndpoint?: string
  Port?: number
  MasterUsername?: string
  DatabaseName?: string
  PreferredBackupWindow?: string
  PreferredMaintenanceWindow?: string
  MultiAZ?: boolean
  EngineMode?: string
  DBClusterMembers?: Array<{
    DBInstanceIdentifier?: string
    IsClusterWriter?: boolean
    DBClusterParameterGroupStatus?: string
  }>
  VpcSecurityGroups?: Array<{
    VpcSecurityGroupId?: string
    Status?: string
  }>
  HostedZoneId?: string
  StorageEncrypted?: boolean
  KmsKeyId?: string
  DeletionProtection?: boolean
  TagList?: Array<{ Key?: string; Value?: string }>
}

export interface DBSnapshot {
  DBSnapshotIdentifier?: string
  DBInstanceIdentifier?: string
  SnapshotCreateTime?: string
  Engine?: string
  AllocatedStorage?: number
  Status?: string
  Port?: number
  AvailabilityZone?: string
  VpcId?: string
  InstanceCreateTime?: string
  MasterUsername?: string
  EngineVersion?: string
  LicenseModel?: string
  SnapshotType?: string
  OptionGroupName?: string
  PercentProgress?: number
  SourceRegion?: string
  StorageType?: string
  Encrypted?: boolean
  KmsKeyId?: string
  DBSnapshotArn?: string
}

export interface DBSubnetGroup {
  DBSubnetGroupName?: string
  DBSubnetGroupDescription?: string
  VpcId?: string
  SubnetGroupStatus?: string
  Subnets?: Array<{
    SubnetIdentifier?: string
    SubnetAvailabilityZone?: { Name?: string }
    SubnetStatus?: string
  }>
  DBSubnetGroupArn?: string
}

/**
 * RDS service management using direct API calls
*/
export class RDSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Describe all RDS DB instances
  */
  async describeDBInstances(options?: {
    DBInstanceIdentifier?: string
    Filters?: Array<{ Name: string; Values: string[] }>
    MaxRecords?: number
    Marker?: string
  }): Promise<{ DBInstances?: DBInstance[]; Marker?: string }> {
    const params: Record<string, any> = {
      Action: 'DescribeDBInstances',
      Version: '2014-10-31',
    }

    if (options?.DBInstanceIdentifier) {
      params.DBInstanceIdentifier = options.DBInstanceIdentifier
    }

    if (options?.MaxRecords) {
      params.MaxRecords = options.MaxRecords
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filters.Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((value, j) => {
          params[`Filters.Filter.${i + 1}.Values.Value.${j + 1}`] = value
        })
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    // Parse the response - RDS returns XML wrapped in DescribeDBInstancesResult
    const response = result.DescribeDBInstancesResult || result

    // Handle array vs single instance
    let instances = response.DBInstances?.DBInstance || []
    if (!Array.isArray(instances)) {
      instances = instances ? [instances] : []
    }

    return {
      DBInstances: instances,
      Marker: response.Marker,
    }
  }

  /**
   * Describe a specific DB instance
  */
  async describeDBInstance(dbInstanceIdentifier: string): Promise<DBInstance | undefined> {
    const result = await this.describeDBInstances({ DBInstanceIdentifier: dbInstanceIdentifier })
    return result.DBInstances?.[0]
  }

  /**
   * Describe all RDS DB clusters (Aurora)
  */
  async describeDBClusters(options?: {
    DBClusterIdentifier?: string
    Filters?: Array<{ Name: string; Values: string[] }>
    MaxRecords?: number
    Marker?: string
  }): Promise<{ DBClusters?: DBCluster[]; Marker?: string }> {
    const params: Record<string, any> = {
      Action: 'DescribeDBClusters',
      Version: '2014-10-31',
    }

    if (options?.DBClusterIdentifier) {
      params.DBClusterIdentifier = options.DBClusterIdentifier
    }

    if (options?.MaxRecords) {
      params.MaxRecords = options.MaxRecords
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filters.Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((value, j) => {
          params[`Filters.Filter.${i + 1}.Values.Value.${j + 1}`] = value
        })
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.DescribeDBClustersResult || result

    let clusters = response.DBClusters?.DBCluster || []
    if (!Array.isArray(clusters)) {
      clusters = clusters ? [clusters] : []
    }

    return {
      DBClusters: clusters,
      Marker: response.Marker,
    }
  }

  /**
   * Describe DB snapshots
  */
  async describeDBSnapshots(options?: {
    DBInstanceIdentifier?: string
    DBSnapshotIdentifier?: string
    SnapshotType?: 'automated' | 'manual' | 'shared' | 'public' | 'awsbackup'
    MaxRecords?: number
    Marker?: string
  }): Promise<{ DBSnapshots?: DBSnapshot[]; Marker?: string }> {
    const params: Record<string, any> = {
      Action: 'DescribeDBSnapshots',
      Version: '2014-10-31',
    }

    if (options?.DBInstanceIdentifier) {
      params.DBInstanceIdentifier = options.DBInstanceIdentifier
    }

    if (options?.DBSnapshotIdentifier) {
      params.DBSnapshotIdentifier = options.DBSnapshotIdentifier
    }

    if (options?.SnapshotType) {
      params.SnapshotType = options.SnapshotType
    }

    if (options?.MaxRecords) {
      params.MaxRecords = options.MaxRecords
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.DescribeDBSnapshotsResult || result

    let snapshots = response.DBSnapshots?.DBSnapshot || []
    if (!Array.isArray(snapshots)) {
      snapshots = snapshots ? [snapshots] : []
    }

    return {
      DBSnapshots: snapshots,
      Marker: response.Marker,
    }
  }

  /**
   * Describe DB subnet groups
  */
  async describeDBSubnetGroups(options?: {
    DBSubnetGroupName?: string
    MaxRecords?: number
    Marker?: string
  }): Promise<{ DBSubnetGroups?: DBSubnetGroup[]; Marker?: string }> {
    const params: Record<string, any> = {
      Action: 'DescribeDBSubnetGroups',
      Version: '2014-10-31',
    }

    if (options?.DBSubnetGroupName) {
      params.DBSubnetGroupName = options.DBSubnetGroupName
    }

    if (options?.MaxRecords) {
      params.MaxRecords = options.MaxRecords
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.DescribeDBSubnetGroupsResult || result

    let groups = response.DBSubnetGroups?.DBSubnetGroup || []
    if (!Array.isArray(groups)) {
      groups = groups ? [groups] : []
    }

    return {
      DBSubnetGroups: groups,
      Marker: response.Marker,
    }
  }

  /**
   * Create a new DB instance
  */
  async createDBInstance(options: {
    DBInstanceIdentifier: string
    DBInstanceClass: string
    Engine: string
    MasterUsername?: string
    MasterUserPassword?: string
    DBName?: string
    AllocatedStorage?: number
    VpcSecurityGroupIds?: string[]
    DBSubnetGroupName?: string
    AvailabilityZone?: string
    PreferredMaintenanceWindow?: string
    PreferredBackupWindow?: string
    BackupRetentionPeriod?: number
    MultiAZ?: boolean
    EngineVersion?: string
    AutoMinorVersionUpgrade?: boolean
    LicenseModel?: string
    PubliclyAccessible?: boolean
    StorageType?: 'gp2' | 'gp3' | 'io1' | 'standard'
    StorageEncrypted?: boolean
    KmsKeyId?: string
    DeletionProtection?: boolean
    Tags?: Array<{ Key: string; Value: string }>
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'CreateDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
      DBInstanceClass: options.DBInstanceClass,
      Engine: options.Engine,
    }

    if (options.MasterUsername) params.MasterUsername = options.MasterUsername
    if (options.MasterUserPassword) params.MasterUserPassword = options.MasterUserPassword
    if (options.DBName) params.DBName = options.DBName
    if (options.AllocatedStorage) params.AllocatedStorage = options.AllocatedStorage
    if (options.DBSubnetGroupName) params.DBSubnetGroupName = options.DBSubnetGroupName
    if (options.AvailabilityZone) params.AvailabilityZone = options.AvailabilityZone
    if (options.PreferredMaintenanceWindow) params.PreferredMaintenanceWindow = options.PreferredMaintenanceWindow
    if (options.PreferredBackupWindow) params.PreferredBackupWindow = options.PreferredBackupWindow
    if (options.BackupRetentionPeriod !== undefined) params.BackupRetentionPeriod = options.BackupRetentionPeriod
    if (options.MultiAZ !== undefined) params.MultiAZ = options.MultiAZ
    if (options.EngineVersion) params.EngineVersion = options.EngineVersion
    if (options.AutoMinorVersionUpgrade !== undefined) params.AutoMinorVersionUpgrade = options.AutoMinorVersionUpgrade
    if (options.LicenseModel) params.LicenseModel = options.LicenseModel
    if (options.PubliclyAccessible !== undefined) params.PubliclyAccessible = options.PubliclyAccessible
    if (options.StorageType) params.StorageType = options.StorageType
    if (options.StorageEncrypted !== undefined) params.StorageEncrypted = options.StorageEncrypted
    if (options.KmsKeyId) params.KmsKeyId = options.KmsKeyId
    if (options.DeletionProtection !== undefined) params.DeletionProtection = options.DeletionProtection

    if (options.VpcSecurityGroupIds) {
      options.VpcSecurityGroupIds.forEach((id, i) => {
        params[`VpcSecurityGroupIds.VpcSecurityGroupId.${i + 1}`] = id
      })
    }

    if (options.Tags) {
      options.Tags.forEach((tag, i) => {
        params[`Tags.Tag.${i + 1}.Key`] = tag.Key
        params[`Tags.Tag.${i + 1}.Value`] = tag.Value
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.CreateDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Delete a DB instance
  */
  async deleteDBInstance(options: {
    DBInstanceIdentifier: string
    SkipFinalSnapshot?: boolean
    FinalDBSnapshotIdentifier?: string
    DeleteAutomatedBackups?: boolean
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'DeleteDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
    }

    if (options.SkipFinalSnapshot !== undefined) {
      params.SkipFinalSnapshot = options.SkipFinalSnapshot
    }

    if (options.FinalDBSnapshotIdentifier) {
      params.FinalDBSnapshotIdentifier = options.FinalDBSnapshotIdentifier
    }

    if (options.DeleteAutomatedBackups !== undefined) {
      params.DeleteAutomatedBackups = options.DeleteAutomatedBackups
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.DeleteDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Modify a DB instance
  */
  async modifyDBInstance(options: {
    DBInstanceIdentifier: string
    DBInstanceClass?: string
    AllocatedStorage?: number
    MasterUserPassword?: string
    BackupRetentionPeriod?: number
    PreferredBackupWindow?: string
    PreferredMaintenanceWindow?: string
    MultiAZ?: boolean
    EngineVersion?: string
    AutoMinorVersionUpgrade?: boolean
    PubliclyAccessible?: boolean
    VpcSecurityGroupIds?: string[]
    ApplyImmediately?: boolean
    StorageType?: 'gp2' | 'gp3' | 'io1' | 'standard'
    DeletionProtection?: boolean
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'ModifyDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
    }

    if (options.DBInstanceClass) params.DBInstanceClass = options.DBInstanceClass
    if (options.AllocatedStorage) params.AllocatedStorage = options.AllocatedStorage
    if (options.MasterUserPassword) params.MasterUserPassword = options.MasterUserPassword
    if (options.BackupRetentionPeriod !== undefined) params.BackupRetentionPeriod = options.BackupRetentionPeriod
    if (options.PreferredBackupWindow) params.PreferredBackupWindow = options.PreferredBackupWindow
    if (options.PreferredMaintenanceWindow) params.PreferredMaintenanceWindow = options.PreferredMaintenanceWindow
    if (options.MultiAZ !== undefined) params.MultiAZ = options.MultiAZ
    if (options.EngineVersion) params.EngineVersion = options.EngineVersion
    if (options.AutoMinorVersionUpgrade !== undefined) params.AutoMinorVersionUpgrade = options.AutoMinorVersionUpgrade
    if (options.PubliclyAccessible !== undefined) params.PubliclyAccessible = options.PubliclyAccessible
    if (options.ApplyImmediately !== undefined) params.ApplyImmediately = options.ApplyImmediately
    if (options.StorageType) params.StorageType = options.StorageType
    if (options.DeletionProtection !== undefined) params.DeletionProtection = options.DeletionProtection

    if (options.VpcSecurityGroupIds) {
      options.VpcSecurityGroupIds.forEach((id, i) => {
        params[`VpcSecurityGroupIds.VpcSecurityGroupId.${i + 1}`] = id
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.ModifyDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Start a DB instance
  */
  async startDBInstance(dbInstanceIdentifier: string): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'StartDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: dbInstanceIdentifier,
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.StartDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Stop a DB instance
  */
  async stopDBInstance(options: {
    DBInstanceIdentifier: string
    DBSnapshotIdentifier?: string
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'StopDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
    }

    if (options.DBSnapshotIdentifier) {
      params.DBSnapshotIdentifier = options.DBSnapshotIdentifier
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.StopDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Reboot a DB instance
  */
  async rebootDBInstance(options: {
    DBInstanceIdentifier: string
    ForceFailover?: boolean
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'RebootDBInstance',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
    }

    if (options.ForceFailover !== undefined) {
      params.ForceFailover = options.ForceFailover
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.RebootDBInstanceResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Create a DB snapshot
  */
  async createDBSnapshot(options: {
    DBInstanceIdentifier: string
    DBSnapshotIdentifier: string
    Tags?: Array<{ Key: string; Value: string }>
  }): Promise<{ DBSnapshot?: DBSnapshot }> {
    const params: Record<string, any> = {
      Action: 'CreateDBSnapshot',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
      DBSnapshotIdentifier: options.DBSnapshotIdentifier,
    }

    if (options.Tags) {
      options.Tags.forEach((tag, i) => {
        params[`Tags.Tag.${i + 1}.Key`] = tag.Key
        params[`Tags.Tag.${i + 1}.Value`] = tag.Value
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.CreateDBSnapshotResult || result
    return {
      DBSnapshot: response.DBSnapshot,
    }
  }

  /**
   * Delete a DB snapshot
  */
  async deleteDBSnapshot(dbSnapshotIdentifier: string): Promise<{ DBSnapshot?: DBSnapshot }> {
    const params: Record<string, any> = {
      Action: 'DeleteDBSnapshot',
      Version: '2014-10-31',
      DBSnapshotIdentifier: dbSnapshotIdentifier,
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.DeleteDBSnapshotResult || result
    return {
      DBSnapshot: response.DBSnapshot,
    }
  }

  /**
   * Restore DB instance from snapshot
  */
  async restoreDBInstanceFromDBSnapshot(options: {
    DBInstanceIdentifier: string
    DBSnapshotIdentifier: string
    DBInstanceClass?: string
    Port?: number
    AvailabilityZone?: string
    DBSubnetGroupName?: string
    MultiAZ?: boolean
    PubliclyAccessible?: boolean
    AutoMinorVersionUpgrade?: boolean
    StorageType?: 'gp2' | 'gp3' | 'io1' | 'standard'
    VpcSecurityGroupIds?: string[]
    DeletionProtection?: boolean
    Tags?: Array<{ Key: string; Value: string }>
  }): Promise<{ DBInstance?: DBInstance }> {
    const params: Record<string, any> = {
      Action: 'RestoreDBInstanceFromDBSnapshot',
      Version: '2014-10-31',
      DBInstanceIdentifier: options.DBInstanceIdentifier,
      DBSnapshotIdentifier: options.DBSnapshotIdentifier,
    }

    if (options.DBInstanceClass) params.DBInstanceClass = options.DBInstanceClass
    if (options.Port) params.Port = options.Port
    if (options.AvailabilityZone) params.AvailabilityZone = options.AvailabilityZone
    if (options.DBSubnetGroupName) params.DBSubnetGroupName = options.DBSubnetGroupName
    if (options.MultiAZ !== undefined) params.MultiAZ = options.MultiAZ
    if (options.PubliclyAccessible !== undefined) params.PubliclyAccessible = options.PubliclyAccessible
    if (options.AutoMinorVersionUpgrade !== undefined) params.AutoMinorVersionUpgrade = options.AutoMinorVersionUpgrade
    if (options.StorageType) params.StorageType = options.StorageType
    if (options.DeletionProtection !== undefined) params.DeletionProtection = options.DeletionProtection

    if (options.VpcSecurityGroupIds) {
      options.VpcSecurityGroupIds.forEach((id, i) => {
        params[`VpcSecurityGroupIds.VpcSecurityGroupId.${i + 1}`] = id
      })
    }

    if (options.Tags) {
      options.Tags.forEach((tag, i) => {
        params[`Tags.Tag.${i + 1}.Key`] = tag.Key
        params[`Tags.Tag.${i + 1}.Value`] = tag.Value
      })
    }

    const queryString = new URLSearchParams(buildQueryParams(params)).toString()

    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
    })

    const response = result.RestoreDBInstanceFromDBSnapshotResult || result
    return {
      DBInstance: response.DBInstance,
    }
  }

  /**
   * Wait for DB instance to become available
  */
  async waitForDBInstanceAvailable(
    dbInstanceIdentifier: string,
    maxAttempts = 60,
    delayMs = 30000
  ): Promise<DBInstance | undefined> {
    for (let i = 0; i < maxAttempts; i++) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier)

      if (instance?.DBInstanceStatus === 'available') {
        return instance
      }

      // Check for terminal states
      if (['deleted', 'failed', 'incompatible-restore', 'incompatible-parameters'].includes(instance?.DBInstanceStatus || '')) {
        throw new Error(`DB instance ${dbInstanceIdentifier} is in terminal state: ${instance?.DBInstanceStatus}`)
      }

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    throw new Error(`Timeout waiting for DB instance ${dbInstanceIdentifier} to become available`)
  }

  /**
   * Wait for DB instance to be deleted
  */
  async waitForDBInstanceDeleted(
    dbInstanceIdentifier: string,
    maxAttempts = 60,
    delayMs = 30000
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier)

        // Still exists, check state
        if (instance?.DBInstanceStatus === 'deleting') {
          await new Promise(resolve => setTimeout(resolve, delayMs))
          continue
        }

        // If it exists but not deleting, there might be an issue
        throw new Error(`DB instance ${dbInstanceIdentifier} is in state: ${instance?.DBInstanceStatus}`)
      }
      catch (error: any) {
        // DBInstanceNotFound means it's deleted
        if (error.code === 'DBInstanceNotFound' || error.code === 'DBInstanceNotFoundFault') {
          return
        }
        throw error
      }
    }

    throw new Error(`Timeout waiting for DB instance ${dbInstanceIdentifier} to be deleted`)
  }
}
