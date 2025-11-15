import { describe, expect, it, beforeEach } from 'bun:test'
import {
  ImageScanningManager,
  imageScanningManager,
  BuildOptimizationManager,
  buildOptimizationManager,
  ContainerRegistryManager,
  containerRegistryManager,
  ServiceMeshManager,
  serviceMeshManager,
} from '.'

describe('Image Scanning Manager', () => {
  let manager: ImageScanningManager

  beforeEach(() => {
    manager = new ImageScanningManager()
  })

  describe('Scan Configuration', () => {
    it('should configure Trivy scan', () => {
      const config = manager.configureTrivyScan({
        repository: 'my-app',
        imageTag: 'v1.0.0',
        scanOnPush: true,
      })

      expect(config.id).toContain('scan-config')
      expect(config.scanner).toBe('trivy')
      expect(config.scanOnPush).toBe(true)
    })

    it('should configure Snyk scan', () => {
      const config = manager.configureSnykScan({
        repository: 'my-app',
        imageTag: 'latest',
      })

      expect(config.scanner).toBe('snyk')
      expect(config.failOnSeverity).toBe('HIGH')
    })

    it('should configure ECR scan', () => {
      const config = manager.configureECRScan({
        repository: 'my-repo',
        scanOnPush: true,
      })

      expect(config.scanner).toBe('ecr')
      expect(config.failOnSeverity).toBe('CRITICAL')
    })
  })

  describe('Image Scanning', () => {
    it('should scan image', async () => {
      const config = manager.configureTrivyScan({
        repository: 'test-app',
        imageTag: 'v1.0.0',
      })

      const result = await manager.scanImage(config.id)

      expect(result.id).toContain('scan-result')
      expect(result.scannerType).toBe('trivy')
      expect(result.summary).toBeDefined()
      expect(result.vulnerabilities).toBeDefined()
    })

    it('should evaluate scan result', async () => {
      const config = manager.configureTrivyScan({
        repository: 'test-app',
        imageTag: 'v1.0.0',
      })

      config.failOnSeverity = 'CRITICAL'

      const result = await manager.scanImage(config.id)

      expect(typeof result.passed).toBe('boolean')
    })
  })

  describe('Scan Policies', () => {
    it('should create strict policy', () => {
      const policy = manager.createStrictPolicy('production-policy')

      expect(policy.id).toContain('policy')
      expect(policy.maxCritical).toBe(0)
      expect(policy.maxHigh).toBe(0)
      expect(policy.blockOnFailure).toBe(true)
    })

    it('should create permissive policy', () => {
      const policy = manager.createPermissivePolicy('dev-policy')

      expect(policy.maxCritical).toBe(5)
      expect(policy.blockOnFailure).toBe(false)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate ECR scan CloudFormation', () => {
      const config = manager.configureECRScan({
        repository: 'my-repo',
        scanOnPush: true,
      })

      const cf = manager.generateECRScanCF(config)

      expect(cf.Type).toBe('AWS::ECR::Repository')
      expect(cf.Properties.ImageScanningConfiguration.ScanOnPush).toBe(true)
    })
  })

  it('should use global instance', () => {
    expect(imageScanningManager).toBeInstanceOf(ImageScanningManager)
  })
})

describe('Build Optimization Manager', () => {
  let manager: BuildOptimizationManager

  beforeEach(() => {
    manager = new BuildOptimizationManager()
  })

  describe('Build Configuration', () => {
    it('should create optimized build config', () => {
      const config = manager.createOptimizedBuildConfig({
        name: 'my-app-build',
        dockerfile: 'Dockerfile',
        enableCache: true,
        registry: 'my-registry.com',
      })

      expect(config.id).toContain('build-config')
      expect(config.cacheStrategy.type).toBe('registry')
      expect(config.cacheStrategy.cacheFrom).toBeDefined()
    })
  })

  describe('Multi-Stage Builds', () => {
    it('should create Node.js multi-stage build', () => {
      const config = manager.createNodeMultiStageBuild({
        name: 'nodejs-app',
        nodeVersion: '18-alpine',
        targetStage: 'production',
      })

      expect(config.id).toContain('multi-stage')
      expect(config.stages).toHaveLength(3)
      expect(config.stages[0].name).toBe('dependencies')
      expect(config.stages[1].name).toBe('build')
      expect(config.stages[2].name).toBe('production')
    })

    it('should generate Dockerfile from multi-stage config', () => {
      const config = manager.createNodeMultiStageBuild({
        name: 'test-app',
        nodeVersion: '18-alpine',
      })

      const dockerfile = manager.generateDockerfile(config.id)

      expect(dockerfile).toContain('FROM node:18-alpine AS dependencies')
      expect(dockerfile).toContain('FROM node:18-alpine AS build')
      expect(dockerfile).toContain('FROM node:18-alpine AS production')
    })
  })

  describe('Layer Analysis', () => {
    it('should analyze image layers', () => {
      const analysis = manager.analyzeImage('my-image:latest', [
        {
          index: 0,
          command: 'FROM node:18',
          size: 50,
          created: new Date(),
        },
        {
          index: 1,
          command: 'RUN apt-get update',
          size: 100,
          created: new Date(),
        },
        {
          index: 2,
          command: 'COPY . .',
          size: 25,
          created: new Date(),
        },
      ])

      expect(analysis.id).toContain('analysis')
      expect(analysis.layers).toHaveLength(3)
      expect(analysis.totalSize).toBe(175)
    })
  })

  describe('Optimization Recommendations', () => {
    it('should generate optimization recommendations', () => {
      const analysis = manager.analyzeImage('test-image', [
        { index: 0, command: 'FROM ubuntu:20.04', size: 200, created: new Date() },
        { index: 1, command: 'RUN apt-get update', size: 50, created: new Date() },
        { index: 2, command: 'RUN apt-get install -y curl', size: 30, created: new Date() },
        { index: 3, command: 'RUN apt-get install -y git', size: 40, created: new Date() },
        { index: 4, command: 'COPY . .', size: 20, created: new Date() },
      ])

      const optimization = manager.generateOptimizations(analysis.id)

      expect(optimization.id).toContain('optimization')
      expect(optimization.recommendations.length).toBeGreaterThan(0)
      expect(optimization.estimatedSavings).toBeDefined()
    })

    it('should recommend layer reduction', () => {
      const analysis = manager.analyzeImage('test-image', [
        { index: 0, command: 'FROM node:18', size: 100, created: new Date() },
        { index: 1, command: 'RUN npm install pkg1', size: 10, created: new Date() },
        { index: 2, command: 'RUN npm install pkg2', size: 10, created: new Date() },
        { index: 3, command: 'RUN npm install pkg3', size: 10, created: new Date() },
        { index: 4, command: 'RUN npm install pkg4', size: 10, created: new Date() },
        { index: 5, command: 'RUN npm install pkg5', size: 10, created: new Date() },
        { index: 6, command: 'RUN npm install pkg6', size: 10, created: new Date() },
      ])

      const optimization = manager.generateOptimizations(analysis.id)

      const layerReduction = optimization.recommendations.find(
        r => r.type === 'layer_reduction'
      )

      expect(layerReduction).toBeDefined()
      expect(layerReduction?.priority).toBe('high')
    })
  })

  it('should use global instance', () => {
    expect(buildOptimizationManager).toBeInstanceOf(BuildOptimizationManager)
  })
})

describe('Container Registry Manager', () => {
  let manager: ContainerRegistryManager

  beforeEach(() => {
    manager = new ContainerRegistryManager()
  })

  describe('Registry Creation', () => {
    it('should create ECR repository', () => {
      const registry = manager.createECRRepository({
        name: 'my-app',
        region: 'us-east-1',
        scanOnPush: true,
      })

      expect(registry.id).toContain('registry')
      expect(registry.registryType).toBe('ecr')
      expect(registry.repositoryUri).toContain('my-app')
      expect(registry.scanning?.scanOnPush).toBe(true)
    })

    it('should create repository with encryption', () => {
      const registry = manager.createECRRepository({
        name: 'secure-app',
        encryption: 'KMS',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
      })

      expect(registry.encryption?.encryptionType).toBe('KMS')
      expect(registry.encryption?.kmsKeyId).toBeDefined()
    })

    it('should create managed repository with lifecycle', () => {
      const registry = manager.createManagedRepository({
        name: 'managed-app',
        maxImageCount: 20,
        maxImageAgeDays: 60,
      })

      expect(registry.lifecycle).toBeDefined()
      expect(registry.lifecycle?.rules).toHaveLength(2)
      expect(registry.lifecycle?.rules[0].selection.countNumber).toBe(20)
    })
  })

  describe('Replication', () => {
    it('should enable cross-region replication', () => {
      const registry = manager.createECRRepository({
        name: 'replicated-app',
      })

      manager.enableReplication(registry.id, [
        { region: 'us-west-2' },
        { region: 'eu-west-1' },
      ])

      expect(registry.replication?.enabled).toBe(true)
      expect(registry.replication?.destinations).toHaveLength(2)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate ECR repository CloudFormation', () => {
      const registry = manager.createECRRepository({
        name: 'my-repo',
        scanOnPush: true,
      })

      const cf = manager.generateECRRepositoryCF(registry)

      expect(cf.Type).toBe('AWS::ECR::Repository')
      expect(cf.Properties.RepositoryName).toBe('my-repo')
      expect(cf.Properties.ImageScanningConfiguration.ScanOnPush).toBe(true)
    })

    it('should generate replication configuration', () => {
      const replication = {
        enabled: true,
        destinations: [
          { region: 'us-west-2' },
          { region: 'eu-west-1' },
        ],
      }

      const cf = manager.generateReplicationConfigCF(replication)

      expect(cf.Type).toBe('AWS::ECR::ReplicationConfiguration')
      expect(cf.Properties.ReplicationConfiguration.Rules).toHaveLength(2)
    })
  })

  it('should use global instance', () => {
    expect(containerRegistryManager).toBeInstanceOf(ContainerRegistryManager)
  })
})

describe('Service Mesh Manager', () => {
  let manager: ServiceMeshManager

  beforeEach(() => {
    manager = new ServiceMeshManager()
  })

  describe('Mesh Creation', () => {
    it('should create App Mesh', () => {
      const mesh = manager.createAppMesh({
        name: 'my-mesh',
        services: [
          {
            id: 'svc1',
            name: 'frontend',
            namespace: 'default',
            port: 8080,
            protocol: 'http',
          },
        ],
      })

      expect(mesh.id).toContain('mesh')
      expect(mesh.meshType).toBe('app_mesh')
      expect(mesh.services).toHaveLength(1)
    })
  })

  describe('Virtual Nodes', () => {
    it('should create HTTP virtual node', () => {
      const node = manager.createHTTPVirtualNode({
        name: 'frontend-node',
        serviceName: 'frontend',
        port: 8080,
        namespace: 'production',
      })

      expect(node.id).toContain('vnode')
      expect(node.listeners).toHaveLength(1)
      expect(node.listeners[0].protocol).toBe('http')
      expect(node.listeners[0].healthCheck).toBeDefined()
    })

    it('should include health check', () => {
      const node = manager.createHTTPVirtualNode({
        name: 'api-node',
        serviceName: 'api',
        port: 3000,
        namespace: 'production',
      })

      const healthCheck = node.listeners[0].healthCheck

      expect(healthCheck).toBeDefined()
      expect(healthCheck?.path).toBe('/health')
      expect(healthCheck?.protocol).toBe('http')
    })
  })

  describe('Virtual Routers', () => {
    it('should create canary route', () => {
      const router = manager.createCanaryRoute({
        name: 'canary-router',
        port: 8080,
        protocol: 'http',
        stableTarget: 'stable-node',
        canaryTarget: 'canary-node',
        canaryWeight: 20,
      })

      expect(router.id).toContain('vrouter')
      expect(router.routes).toHaveLength(1)
      expect(router.routes[0].action.weightedTargets).toHaveLength(2)
      expect(router.routes[0].action.weightedTargets[0].weight).toBe(80)
      expect(router.routes[0].action.weightedTargets[1].weight).toBe(20)
    })

    it('should include retry policy', () => {
      const router = manager.createCanaryRoute({
        name: 'retry-router',
        port: 8080,
        protocol: 'http',
        stableTarget: 'stable',
        canaryTarget: 'canary',
        canaryWeight: 10,
      })

      const retryPolicy = router.routes[0].retryPolicy

      expect(retryPolicy).toBeDefined()
      expect(retryPolicy?.maxRetries).toBe(3)
      expect(retryPolicy?.httpRetryEvents).toContain('server-error')
    })
  })

  describe('Virtual Gateways', () => {
    it('should create ingress gateway', () => {
      const gateway = manager.createIngressGateway({
        name: 'ingress-gateway',
        port: 443,
        enableTLS: true,
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc123',
      })

      expect(gateway.id).toContain('vgateway')
      expect(gateway.listeners).toHaveLength(1)
      expect(gateway.listeners[0].tls).toBeDefined()
      expect(gateway.listeners[0].tls?.mode).toBe('STRICT')
    })

    it('should create gateway without TLS', () => {
      const gateway = manager.createIngressGateway({
        name: 'http-gateway',
        port: 80,
      })

      expect(gateway.listeners[0].tls).toBeUndefined()
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate mesh CloudFormation', () => {
      const mesh = manager.createAppMesh({
        name: 'test-mesh',
        services: [],
      })

      const cf = manager.generateMeshCF(mesh)

      expect(cf.Type).toBe('AWS::AppMesh::Mesh')
      expect(cf.Properties.MeshName).toBe('test-mesh')
    })

    it('should generate virtual node CloudFormation', () => {
      const node = manager.createHTTPVirtualNode({
        name: 'test-node',
        serviceName: 'test-service',
        port: 8080,
        namespace: 'default',
      })

      const cf = manager.generateVirtualNodeCF(node, 'test-mesh')

      expect(cf.Type).toBe('AWS::AppMesh::VirtualNode')
      expect(cf.Properties.VirtualNodeName).toBe('test-node')
      expect(cf.Properties.Spec.Listeners).toHaveLength(1)
    })

    it('should generate virtual router CloudFormation', () => {
      const router = manager.createCanaryRoute({
        name: 'test-router',
        port: 8080,
        protocol: 'http',
        stableTarget: 'stable',
        canaryTarget: 'canary',
        canaryWeight: 10,
      })

      const cf = manager.generateVirtualRouterCF(router, 'test-mesh')

      expect(cf.Type).toBe('AWS::AppMesh::VirtualRouter')
      expect(cf.Properties.VirtualRouterName).toBe('test-router')
    })
  })

  it('should use global instance', () => {
    expect(serviceMeshManager).toBeInstanceOf(ServiceMeshManager)
  })
})
