/**
 * Service Mesh Integration
 * AWS App Mesh configuration for microservices
 */

export interface ServiceMesh {
  id: string
  name: string
  meshType: 'app_mesh' | 'istio' | 'linkerd'
  services: MeshService[]
  virtualNodes?: VirtualNode[]
  virtualRouters?: VirtualRouter[]
  virtualGateways?: VirtualGateway[]
}

export interface MeshService {
  id: string
  name: string
  namespace: string
  port: number
  protocol: 'http' | 'http2' | 'grpc' | 'tcp'
  backends?: string[]
  healthCheck?: HealthCheck
}

export interface VirtualNode {
  id: string
  name: string
  serviceName: string
  listeners: Listener[]
  backends?: Backend[]
  serviceDiscovery: ServiceDiscovery
}

export interface Listener {
  port: number
  protocol: 'http' | 'http2' | 'grpc' | 'tcp'
  healthCheck?: HealthCheck
  timeout?: Timeout
  tls?: TLSConfig
}

export interface HealthCheck {
  protocol: 'http' | 'tcp' | 'grpc'
  path?: string
  port?: number
  interval: number // seconds
  timeout: number // seconds
  healthyThreshold: number
  unhealthyThreshold: number
}

export interface Timeout {
  perRequest?: number // milliseconds
  idle?: number // milliseconds
}

export interface TLSConfig {
  mode: 'STRICT' | 'PERMISSIVE' | 'DISABLED'
  certificate?: {
    acm?: string
    file?: {
      certificateChain: string
      privateKey: string
    }
  }
  validation?: {
    trust: {
      acm?: string[]
      file?: {
        certificateChain: string
      }
    }
  }
}

export interface Backend {
  virtualServiceName: string
  clientPolicy?: ClientPolicy
}

export interface ClientPolicy {
  tls?: {
    enforce: boolean
    ports?: number[]
    validation: {
      trust: {
        acm?: string[]
      }
    }
  }
}

export interface ServiceDiscovery {
  type: 'aws_cloud_map' | 'dns'
  namespace?: string
  serviceName?: string
  hostname?: string
}

export interface VirtualRouter {
  id: string
  name: string
  listeners: RouterListener[]
  routes: Route[]
}

export interface RouterListener {
  port: number
  protocol: 'http' | 'http2' | 'grpc' | 'tcp'
}

export interface Route {
  name: string
  match: RouteMatch
  action: RouteAction
  priority?: number
  retryPolicy?: RetryPolicy
}

export interface RouteMatch {
  prefix?: string
  path?: string
  headers?: HeaderMatch[]
  method?: string
}

export interface HeaderMatch {
  name: string
  match?: {
    exact?: string
    prefix?: string
    suffix?: string
    regex?: string
  }
}

export interface RouteAction {
  weightedTargets: WeightedTarget[]
}

export interface WeightedTarget {
  virtualNode: string
  weight: number
  port?: number
}

export interface RetryPolicy {
  maxRetries: number
  perRetryTimeout: number
  httpRetryEvents?: string[]
  tcpRetryEvents?: string[]
}

export interface VirtualGateway {
  id: string
  name: string
  listeners: GatewayListener[]
  logging?: {
    accessLog?: {
      file?: {
        path: string
      }
    }
  }
}

export interface GatewayListener {
  port: number
  protocol: 'http' | 'http2' | 'grpc'
  healthCheck?: HealthCheck
  tls?: TLSConfig
}

/**
 * Service mesh manager
 */
export class ServiceMeshManager {
  private meshes: Map<string, ServiceMesh> = new Map()
  private virtualNodes: Map<string, VirtualNode> = new Map()
  private virtualRouters: Map<string, VirtualRouter> = new Map()
  private virtualGateways: Map<string, VirtualGateway> = new Map()
  private meshCounter = 0
  private nodeCounter = 0
  private routerCounter = 0
  private gatewayCounter = 0

  /**
   * Create service mesh
   */
  createMesh(mesh: Omit<ServiceMesh, 'id'>): ServiceMesh {
    const id = `mesh-${Date.now()}-${this.meshCounter++}`

    const serviceMesh: ServiceMesh = {
      id,
      ...mesh,
    }

    this.meshes.set(id, serviceMesh)

    return serviceMesh
  }

  /**
   * Create App Mesh
   */
  createAppMesh(options: {
    name: string
    services: MeshService[]
  }): ServiceMesh {
    return this.createMesh({
      name: options.name,
      meshType: 'app_mesh',
      services: options.services,
      virtualNodes: [],
      virtualRouters: [],
      virtualGateways: [],
    })
  }

  /**
   * Create virtual node
   */
  createVirtualNode(node: Omit<VirtualNode, 'id'>): VirtualNode {
    const id = `vnode-${Date.now()}-${this.nodeCounter++}`

    const virtualNode: VirtualNode = {
      id,
      ...node,
    }

    this.virtualNodes.set(id, virtualNode)

    return virtualNode
  }

  /**
   * Create HTTP virtual node
   */
  createHTTPVirtualNode(options: {
    name: string
    serviceName: string
    port: number
    namespace: string
  }): VirtualNode {
    return this.createVirtualNode({
      name: options.name,
      serviceName: options.serviceName,
      listeners: [
        {
          port: options.port,
          protocol: 'http',
          healthCheck: {
            protocol: 'http',
            path: '/health',
            interval: 30,
            timeout: 10,
            healthyThreshold: 2,
            unhealthyThreshold: 3,
          },
          timeout: {
            perRequest: 15000,
            idle: 300000,
          },
        },
      ],
      serviceDiscovery: {
        type: 'aws_cloud_map',
        namespace: options.namespace,
        serviceName: options.serviceName,
      },
    })
  }

  /**
   * Create virtual router
   */
  createVirtualRouter(router: Omit<VirtualRouter, 'id'>): VirtualRouter {
    const id = `vrouter-${Date.now()}-${this.routerCounter++}`

    const virtualRouter: VirtualRouter = {
      id,
      ...router,
    }

    this.virtualRouters.set(id, virtualRouter)

    return virtualRouter
  }

  /**
   * Create canary route
   */
  createCanaryRoute(options: {
    name: string
    port: number
    protocol: 'http' | 'http2' | 'grpc'
    stableTarget: string
    canaryTarget: string
    canaryWeight: number // 0-100
  }): VirtualRouter {
    return this.createVirtualRouter({
      name: options.name,
      listeners: [
        {
          port: options.port,
          protocol: options.protocol,
        },
      ],
      routes: [
        {
          name: 'canary-route',
          match: {
            prefix: '/',
          },
          action: {
            weightedTargets: [
              {
                virtualNode: options.stableTarget,
                weight: 100 - options.canaryWeight,
              },
              {
                virtualNode: options.canaryTarget,
                weight: options.canaryWeight,
              },
            ],
          },
          retryPolicy: {
            maxRetries: 3,
            perRetryTimeout: 5000,
            httpRetryEvents: ['server-error', 'gateway-error'],
            tcpRetryEvents: ['connection-error'],
          },
        },
      ],
    })
  }

  /**
   * Create virtual gateway
   */
  createVirtualGateway(gateway: Omit<VirtualGateway, 'id'>): VirtualGateway {
    const id = `vgateway-${Date.now()}-${this.gatewayCounter++}`

    const virtualGateway: VirtualGateway = {
      id,
      ...gateway,
    }

    this.virtualGateways.set(id, virtualGateway)

    return virtualGateway
  }

  /**
   * Create ingress gateway
   */
  createIngressGateway(options: {
    name: string
    port: number
    enableTLS?: boolean
    certificateArn?: string
  }): VirtualGateway {
    const listener: GatewayListener = {
      port: options.port,
      protocol: 'http',
      healthCheck: {
        protocol: 'http',
        path: '/health',
        interval: 30,
        timeout: 10,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      },
    }

    if (options.enableTLS && options.certificateArn) {
      listener.tls = {
        mode: 'STRICT',
        certificate: {
          acm: options.certificateArn,
        },
      }
    }

    return this.createVirtualGateway({
      name: options.name,
      listeners: [listener],
      logging: {
        accessLog: {
          file: {
            path: '/dev/stdout',
          },
        },
      },
    })
  }

  /**
   * Get mesh
   */
  getMesh(id: string): ServiceMesh | undefined {
    return this.meshes.get(id)
  }

  /**
   * List meshes
   */
  listMeshes(): ServiceMesh[] {
    return Array.from(this.meshes.values())
  }

  /**
   * Get virtual node
   */
  getVirtualNode(id: string): VirtualNode | undefined {
    return this.virtualNodes.get(id)
  }

  /**
   * List virtual nodes
   */
  listVirtualNodes(): VirtualNode[] {
    return Array.from(this.virtualNodes.values())
  }

  /**
   * Generate CloudFormation for App Mesh
   */
  generateMeshCF(mesh: ServiceMesh): any {
    return {
      Type: 'AWS::AppMesh::Mesh',
      Properties: {
        MeshName: mesh.name,
        Spec: {
          EgressFilter: {
            Type: 'ALLOW_ALL',
          },
        },
      },
    }
  }

  /**
   * Generate CloudFormation for Virtual Node
   */
  generateVirtualNodeCF(node: VirtualNode, meshName: string): any {
    return {
      Type: 'AWS::AppMesh::VirtualNode',
      Properties: {
        MeshName: meshName,
        VirtualNodeName: node.name,
        Spec: {
          Listeners: node.listeners.map(listener => ({
            PortMapping: {
              Port: listener.port,
              Protocol: listener.protocol,
            },
            ...(listener.healthCheck && {
              HealthCheck: {
                Protocol: listener.healthCheck.protocol,
                ...(listener.healthCheck.path && { Path: listener.healthCheck.path }),
                IntervalMillis: listener.healthCheck.interval * 1000,
                TimeoutMillis: listener.healthCheck.timeout * 1000,
                HealthyThreshold: listener.healthCheck.healthyThreshold,
                UnhealthyThreshold: listener.healthCheck.unhealthyThreshold,
              },
            }),
          })),
          ServiceDiscovery: {
            AWSCloudMap: {
              NamespaceName: node.serviceDiscovery.namespace,
              ServiceName: node.serviceDiscovery.serviceName,
            },
          },
        },
      },
    }
  }

  /**
   * Generate CloudFormation for Virtual Router
   */
  generateVirtualRouterCF(router: VirtualRouter, meshName: string): any {
    return {
      Type: 'AWS::AppMesh::VirtualRouter',
      Properties: {
        MeshName: meshName,
        VirtualRouterName: router.name,
        Spec: {
          Listeners: router.listeners.map(listener => ({
            PortMapping: {
              Port: listener.port,
              Protocol: listener.protocol,
            },
          })),
        },
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.meshes.clear()
    this.virtualNodes.clear()
    this.virtualRouters.clear()
    this.virtualGateways.clear()
    this.meshCounter = 0
    this.nodeCounter = 0
    this.routerCounter = 0
    this.gatewayCounter = 0
  }
}

/**
 * Global service mesh manager instance
 */
export const serviceMeshManager: ServiceMeshManager = new ServiceMeshManager()
