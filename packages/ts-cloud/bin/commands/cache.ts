import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { ElastiCacheClient } from '../../src/aws/elasticache'
import { loadValidatedConfig } from './shared'

export function registerCacheCommands(app: CLI): void {
  app
    .command('cache:list', 'List all ElastiCache clusters')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('ElastiCache Clusters')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const elasticache = new ElastiCacheClient(region)

        const spinner = new cli.Spinner('Fetching clusters...')
        spinner.start()

        const result = await elasticache.describeCacheClusters()
        const clusters = result.CacheClusters || []

        spinner.succeed(`Found ${clusters.length} cluster(s)`)

        if (clusters.length === 0) {
          cli.info('No ElastiCache clusters found')
          cli.info('Use `cloud cache:create` to create a new cluster')
          return
        }

        cli.table(
          ['Cluster ID', 'Engine', 'Node Type', 'Nodes', 'Status'],
          clusters.map(cluster => [
            cluster.CacheClusterId || 'N/A',
            `${cluster.Engine || 'N/A'} ${cluster.EngineVersion || ''}`,
            cluster.CacheNodeType || 'N/A',
            (cluster.NumCacheNodes || 0).toString(),
            cluster.CacheClusterStatus || 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list clusters: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cache:create <name>', 'Create a new ElastiCache cluster')
    .option('--engine <engine>', 'Cache engine (redis or memcached)', { default: 'redis' })
    .option('--node-type <type>', 'Node instance type', { default: 'cache.t3.micro' })
    .option('--nodes <number>', 'Number of cache nodes', { default: '1' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--version <version>', 'Engine version')
    .action(async (name: string, options: { engine: string; nodeType: string; nodes: string; region: string; version?: string }) => {
      cli.header('Create ElastiCache Cluster')

      try {
        const elasticache = new ElastiCacheClient(options.region)

        cli.info(`Cluster ID: ${name}`)
        cli.info(`Engine: ${options.engine}`)
        cli.info(`Node Type: ${options.nodeType}`)
        cli.info(`Number of Nodes: ${options.nodes}`)
        cli.info(`Region: ${options.region}`)

        const confirmed = await cli.confirm('\nCreate this cluster?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating cluster...')
        spinner.start()

        await elasticache.createCacheCluster({
          CacheClusterId: name,
          Engine: options.engine,
          CacheNodeType: options.nodeType,
          NumCacheNodes: Number.parseInt(options.nodes),
          EngineVersion: options.version,
        })

        spinner.succeed('Cluster creation initiated')

        cli.success(`\nCluster: ${name}`)
        cli.info('Status: creating')
        cli.info('\nNote: Cluster creation may take several minutes.')
        cli.info('Use `cloud cache:list` to check status.')
      }
      catch (error: any) {
        cli.error(`Failed to create cluster: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cache:delete <clusterId>', 'Delete an ElastiCache cluster')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (clusterId: string, options: { region: string }) => {
      cli.header('Delete ElastiCache Cluster')

      try {
        const elasticache = new ElastiCacheClient(options.region)

        cli.warn(`This will permanently delete cluster: ${clusterId}`)
        cli.warn('All data in the cluster will be lost!')

        const confirmed = await cli.confirm('\nDelete this cluster?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting cluster...')
        spinner.start()

        await elasticache.deleteCacheCluster({ CacheClusterId: clusterId })

        spinner.succeed('Cluster deletion initiated')

        cli.info('\nNote: Cluster deletion may take several minutes.')
      }
      catch (error: any) {
        cli.error(`Failed to delete cluster: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cache:stats <clusterId>', 'Show ElastiCache cluster statistics')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (clusterId: string, options: { region: string }) => {
      cli.header(`ElastiCache Stats: ${clusterId}`)

      try {
        const elasticache = new ElastiCacheClient(options.region)

        const spinner = new cli.Spinner('Fetching cluster details...')
        spinner.start()

        const result = await elasticache.describeCacheClusters({
          CacheClusterId: clusterId,
          ShowCacheNodeInfo: true,
        })

        const cluster = result.CacheClusters?.[0]

        if (!cluster) {
          spinner.fail('Cluster not found')
          return
        }

        spinner.succeed('Cluster details loaded')

        cli.info('\nCluster Information:')
        cli.info(`  Cluster ID: ${cluster.CacheClusterId}`)
        cli.info(`  Engine: ${cluster.Engine} ${cluster.EngineVersion}`)
        cli.info(`  Node Type: ${cluster.CacheNodeType}`)
        cli.info(`  Status: ${cluster.CacheClusterStatus}`)
        cli.info(`  Nodes: ${cluster.NumCacheNodes}`)

        if (cluster.ConfigurationEndpoint) {
          cli.info(`\nConfiguration Endpoint:`)
          cli.info(`  ${cluster.ConfigurationEndpoint.Address}:${cluster.ConfigurationEndpoint.Port}`)
        }

        if (cluster.CacheNodes && cluster.CacheNodes.length > 0) {
          cli.info('\nCache Nodes:')
          for (const node of cluster.CacheNodes) {
            cli.info(`  - ${node.CacheNodeId}: ${node.CacheNodeStatus}`)
            if (node.Endpoint) {
              cli.info(`    Endpoint: ${node.Endpoint.Address}:${node.Endpoint.Port}`)
            }
          }
        }

        if (cluster.CacheSecurityGroups && cluster.CacheSecurityGroups.length > 0) {
          cli.info('\nSecurity Groups:')
          for (const sg of cluster.CacheSecurityGroups) {
            cli.info(`  - ${sg.CacheSecurityGroupName}: ${sg.Status}`)
          }
        }

        cli.info('\nParameters:')
        cli.info(`  Parameter Group: ${cluster.CacheParameterGroup?.CacheParameterGroupName || 'default'}`)
        cli.info(`  Subnet Group: ${cluster.CacheSubnetGroupName || 'default'}`)
        cli.info(`  Preferred Maintenance: ${cluster.PreferredMaintenanceWindow || 'Not set'}`)
      }
      catch (error: any) {
        cli.error(`Failed to get cluster stats: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cache:flush <clusterId>', 'Flush all data from a Redis cluster')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (clusterId: string, options: { region: string }) => {
      cli.header('Flush ElastiCache Cluster')

      try {
        const elasticache = new ElastiCacheClient(options.region)

        // First get cluster info to get the endpoint
        const spinner = new cli.Spinner('Getting cluster endpoint...')
        spinner.start()

        const result = await elasticache.describeCacheClusters({
          CacheClusterId: clusterId,
          ShowCacheNodeInfo: true,
        })

        const cluster = result.CacheClusters?.[0]

        if (!cluster) {
          spinner.fail('Cluster not found')
          return
        }

        if (cluster.Engine !== 'redis') {
          spinner.fail('Flush is only supported for Redis clusters')
          cli.info('For Memcached, items expire automatically based on TTL.')
          return
        }

        spinner.stop()

        const endpoint = cluster.ConfigurationEndpoint || cluster.CacheNodes?.[0]?.Endpoint

        if (!endpoint) {
          cli.error('Could not determine cluster endpoint')
          return
        }

        cli.warn(`This will delete ALL data in cluster: ${clusterId}`)
        cli.warn(`Endpoint: ${endpoint.Address}:${endpoint.Port}`)
        cli.warn('This action cannot be undone!')

        const confirmed = await cli.confirm('\nFlush all data?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        cli.info('\nTo flush the Redis cluster, connect and run FLUSHALL:')
        cli.info(`  redis-cli -h ${endpoint.Address} -p ${endpoint.Port} FLUSHALL`)
        cli.info('\nNote: Direct FLUSHALL via AWS API is not supported.')
        cli.info('You must connect to the cluster directly to execute this command.')
      }
      catch (error: any) {
        cli.error(`Failed to get cluster info: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cache:reboot <clusterId>', 'Reboot cache cluster nodes')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--node <nodeId>', 'Specific node ID to reboot')
    .action(async (clusterId: string, options: { region: string; node?: string }) => {
      cli.header('Reboot ElastiCache Cluster')

      try {
        const elasticache = new ElastiCacheClient(options.region)

        // Get cluster info first
        const spinner = new cli.Spinner('Getting cluster info...')
        spinner.start()

        const result = await elasticache.describeCacheClusters({
          CacheClusterId: clusterId,
          ShowCacheNodeInfo: true,
        })

        const cluster = result.CacheClusters?.[0]

        if (!cluster) {
          spinner.fail('Cluster not found')
          return
        }

        spinner.stop()

        const nodeIds = options.node
          ? [options.node]
          : cluster.CacheNodes?.map(n => n.CacheNodeId!).filter(Boolean) || []

        if (nodeIds.length === 0) {
          cli.error('No nodes found to reboot')
          return
        }

        cli.warn(`This will reboot the following nodes: ${nodeIds.join(', ')}`)
        cli.warn('The cluster may be temporarily unavailable during reboot.')

        const confirmed = await cli.confirm('\nReboot these nodes?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const rebootSpinner = new cli.Spinner('Rebooting nodes...')
        rebootSpinner.start()

        await elasticache.rebootCacheCluster({
          CacheClusterId: clusterId,
          CacheNodeIdsToReboot: nodeIds,
        })

        rebootSpinner.succeed('Reboot initiated')

        cli.info('\nNote: Reboot may take several minutes to complete.')
        cli.info('Use `cloud cache:stats` to check status.')
      }
      catch (error: any) {
        cli.error(`Failed to reboot cluster: ${error.message}`)
        process.exit(1)
      }
    })
}
