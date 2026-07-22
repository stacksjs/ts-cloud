import type { JsonValue } from '../control-plane'
import type { CapacityPool, PoolBackend, RemoteBuild, RemoteBuildDriver } from './types'

export interface RemoteBuildTransport {
  provision(input:{backend:PoolBackend,pool:CapacityPool,build:RemoteBuild,tokenExpiresAt:string}):Promise<{handle:string}>
  execute(input:{handle:string,spec:JsonValue,sourceSha:string,signal:AbortSignal,onLog(message:string):void}):Promise<void>
  publish(input:{handle:string,sourceSha:string}):Promise<{artifactUri:string,artifactDigest:string,cacheKey?:string}>
  destroy(input:{handle:string}):Promise<void>
}

/** Provider-neutral orchestration over real server, ECS task, or ASG runner transports. */
export class TransportRemoteBuildDriver implements RemoteBuildDriver {
  private handles=new Map<string,string>()
  constructor(readonly backend:PoolBackend,private transport:RemoteBuildTransport){}
  async run({build,pool,signal,log}:{build:RemoteBuild,pool:CapacityPool,signal:AbortSignal,log(message:string):void}):Promise<{artifactUri:string,artifactDigest:string,cacheKey?:string}>{const provisioned=await this.transport.provision({backend:this.backend,pool,build,tokenExpiresAt:build.credentialPolicy.shortLivedTokenExpiresAt});this.handles.set(build.id,provisioned.handle);log(`${this.backend} builder provisioned`);await this.transport.execute({handle:provisioned.handle,spec:build.buildSpec,sourceSha:build.sourceSha,signal,onLog:log});return this.transport.publish({handle:provisioned.handle,sourceSha:build.sourceSha})}
  async cleanup({build}:{build:RemoteBuild,pool:CapacityPool}):Promise<void>{const handle=this.handles.get(build.id);if(!handle)return;await this.transport.destroy({handle});this.handles.delete(build.id)}
}
export const createServerBuildDriver=(transport:RemoteBuildTransport):TransportRemoteBuildDriver=>new TransportRemoteBuildDriver('server',transport)
export const createEcsBuildDriver=(transport:RemoteBuildTransport):TransportRemoteBuildDriver=>new TransportRemoteBuildDriver('ecs',transport)
export const createAsgBuildDriver=(transport:RemoteBuildTransport):TransportRemoteBuildDriver=>new TransportRemoteBuildDriver('asg',transport)
