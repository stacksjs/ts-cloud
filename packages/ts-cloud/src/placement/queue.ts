import type { QueueOperationHandler } from '../queue'
import type { RemoteBuildDriver } from './types'
import { PlacementStore } from './store'

const digest=/^sha256:[a-f0-9]{64}$/
const uri=/^(?:s3|https|oci):\/\//
export function createRemoteBuildQueueHandlers(store:PlacementStore,drivers:readonly RemoteBuildDriver[]):Record<string,QueueOperationHandler>{return{'build.remote':async context=>{
  const input=context.operation.input&&typeof context.operation.input==='object'&&!Array.isArray(context.operation.input)?context.operation.input as Record<string,unknown>:{},build=store.getBuild(String(input.buildId??''));if(!build)throw new Error('Queued remote build was not found.')
  const pool=store.getPool(build.poolId);if(!pool||pool.purpose!=='build'||pool.status!=='active')throw new Error('The selected build pool is unavailable.')
  if(!pool.ephemeralWorkspaces)throw new Error('Remote builds require an ephemeral workspace pool.')
  if(build.credentialPolicy.productionSecrets||pool.allowProductionSecrets)throw new Error('Production secrets are forbidden in remote build workers.')
  if(new Date(build.credentialPolicy.shortLivedTokenExpiresAt)<=new Date())throw new Error('The short-lived build credential has expired.')
  const driver=drivers.find(item=>item.backend===pool.backend);if(!driver)throw new Error(`No ${pool.backend} remote build driver is configured.`)
  const workspace=`build://${pool.id}/${build.id}`;store.updateBuild(build.id,{status:'running',workspace});context.checkpoint('checkout',`Preparing isolated workspace for ${build.sourceSha}.`)
  try{context.throwIfCancellationRequested();context.checkpoint('build','Executing resource-limited build.');const result=await driver.run({build:store.getBuild(build.id)!,pool,signal:context.signal,log:message=>context.log(message,{stream:'stdout'})});context.throwIfCancellationRequested();if(!digest.test(result.artifactDigest)||!uri.test(result.artifactUri))throw new Error('Builder returned an unverified artifact reference.');store.updateBuild(build.id,{status:'uploading',cacheKey:result.cacheKey,artifactUri:result.artifactUri,artifactDigest:result.artifactDigest});context.checkpoint('verify','Verified content-addressed artifact upload.');await driver.cleanup({build:store.getBuild(build.id)!,pool});store.updateBuild(build.id,{status:'succeeded',workspace:undefined,cleanupAt:new Date().toISOString()});return{buildId:build.id,artifactUri:result.artifactUri,artifactDigest:result.artifactDigest,cacheKey:result.cacheKey??null}}
  catch(error){try{await driver.cleanup({build:store.getBuild(build.id)!,pool});store.updateBuild(build.id,{status:context.cancellationRequested()?'cancelled':'failed',workspace:undefined,cleanupAt:new Date().toISOString()})}catch{store.updateBuild(build.id,{status:'cleanup_required'})}throw error}
}}}
