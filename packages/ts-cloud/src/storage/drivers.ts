import type { JsonValue } from '../control-plane'
import type { PersistentVolume, VolumeAttachment, VolumeCapabilities, VolumeDriver, VolumeDriverObservation, VolumeSnapshot } from './model'
import { volumeCapabilities } from './service'

export interface DockerVolumeCommandResult { code:number,stdout:string,stderr:string }
export type DockerVolumeCommand = (args:string[])=>Promise<DockerVolumeCommandResult>
const executeDocker:DockerVolumeCommand=async(args)=>{const process=Bun.spawn(['docker',...args],{stdout:'pipe',stderr:'pipe'}),[code,stdout,stderr]=await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);return{code,stdout,stderr}}
const dockerName=/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/

export class DockerNamedVolumeDriver implements VolumeDriver {
  readonly provider='docker';readonly type='docker' as const
  constructor(private readonly command:DockerVolumeCommand=executeDocker){}
  capabilities():VolumeCapabilities{return volumeCapabilities(['create','attach','detach','delete','adopt','usage'],{resize:{supported:false,reason:'Docker named volumes do not expose a portable capacity resize operation.'},snapshot:{supported:false,reason:'Attach a volume backup policy to create verified recovery points.'},restore:{supported:false,reason:'Restore this volume from its verified backup recovery point.'}})}
  private async run(args:string[],allowMissing=false):Promise<string>{const result=await this.command(args);if(result.code!==0&&!allowMissing)throw new Error(`Docker volume command failed: ${result.stderr.trim()||result.code}`);return result.stdout}
  private async inspect(name:string):Promise<VolumeDriverObservation|undefined>{const output=await this.run(['volume','inspect',name],true);if(!output.trim())return undefined;let item:any;try{item=JSON.parse(output)[0]}catch{return undefined}return{providerId:String(item.Name??name),raw:{driver:String(item.Driver??'local'),mountpoint:String(item.Mountpoint??''),labels:item.Labels??{}} as Record<string,JsonValue>}}
  async discover(_projectId?:string,_environmentId?:string):Promise<VolumeDriverObservation[]>{const output=await this.run(['volume','ls','--format','{{.Name}}']);const values=[];for(const name of output.split('\n').map(item=>item.trim()).filter(dockerName.test.bind(dockerName))){const item=await this.inspect(name);if(item)values.push(item)}return values}
  async create(volume:PersistentVolume):Promise<VolumeDriverObservation>{const name=typeof volume.desiredState.nativeName==='string'?volume.desiredState.nativeName:volume.name;if(!dockerName.test(name))throw new Error('Docker volume name is invalid.');await this.run(['volume','create','--label',`ts-cloud.volume=${volume.id}`,'--label',`ts-cloud.project=${volume.projectId}`,name]);return await this.inspect(name)??{providerId:name}}
  async attach(_volume:PersistentVolume,_attachment:VolumeAttachment):Promise<void>{/* desired mount is consumed by the release/Compose reconciler */}
  async detach(_volume:PersistentVolume,_attachment:VolumeAttachment):Promise<void>{/* drain and unmount are enforced by the service before desired mount removal */}
  async resize():Promise<VolumeDriverObservation>{throw new Error(this.capabilities().resize.reason)}
  async snapshot():Promise<{providerId?:string,sizeBytes?:number,checksum?:string}>{throw new Error(this.capabilities().snapshot.reason)}
  async restore(_volume:PersistentVolume,_snapshot:VolumeSnapshot,_target:PersistentVolume):Promise<VolumeDriverObservation>{throw new Error(this.capabilities().restore.reason)}
  async delete(volume:PersistentVolume):Promise<void>{if(!volume.providerId||!dockerName.test(volume.providerId))throw new Error('Docker volume provider identity is missing or invalid.');await this.run(['volume','rm',volume.providerId])}
  async usage(volume:PersistentVolume):Promise<{usedBytes?:number,capacityBytes?:number}>{const output=await this.run(['system','df','-v','--format','{{json .}}'],true),line=output.split('\n').find(item=>item.includes(`"Name":"${volume.providerId}"`));if(!line)return{};try{const parsed=JSON.parse(line);return{usedBytes:typeof parsed.Size==='number'?parsed.Size:undefined}}catch{return{}}}
}

export interface CloudVolumeTransport {
  list(projectId:string,environmentId?:string):Promise<VolumeDriverObservation[]>
  create(input:{name:string,projectId:string,environmentId?:string,capacityBytes?:number,encrypted:boolean,filesystem?:string}):Promise<VolumeDriverObservation>
  attach(providerId:string,resourceProviderId:string,targetPath:string,readOnly:boolean):Promise<void>
  detach(providerId:string,resourceProviderId:string,force:boolean):Promise<void>
  resize(providerId:string,capacityBytes:number):Promise<VolumeDriverObservation>
  snapshot(providerId:string,name:string):Promise<{providerId?:string,sizeBytes?:number,checksum?:string}>
  restore(providerId:string,snapshotProviderId:string,targetName:string):Promise<VolumeDriverObservation>
  delete(providerId:string):Promise<void>
  usage(providerId:string):Promise<{usedBytes?:number,capacityBytes?:number}>
}
export class CloudBlockVolumeDriver implements VolumeDriver {
  readonly type='ebs' as const
  constructor(readonly provider:string,private readonly transport:CloudVolumeTransport){}
  capabilities():VolumeCapabilities{return volumeCapabilities(['create','attach','detach','resize','snapshot','restore','delete','adopt','usage'],{resize:{supported:true,online:true,minimumBytes:1024**3}})}
  discover(projectId:string,environmentId?:string){return this.transport.list(projectId,environmentId)}
  create(volume:PersistentVolume){return this.transport.create({name:volume.name,projectId:volume.projectId,environmentId:volume.environmentId,capacityBytes:volume.capacityBytes,encrypted:volume.encrypted,filesystem:volume.filesystem})}
  private resource(volume:PersistentVolume,attachment:VolumeAttachment):string{const resource=volume.resourceId===attachment.resourceId?volume.observedState.resourceProviderId:undefined;const value=typeof resource==='string'?resource:attachment.driverOptions.resourceProviderId;if(typeof value!=='string'||!value)throw new Error('Cloud attachment requires a reviewed resourceProviderId driver option.');return value}
  attach(volume:PersistentVolume,attachment:VolumeAttachment){return this.transport.attach(volume.providerId!,this.resource(volume,attachment),attachment.targetPath,attachment.readOnly)}
  detach(volume:PersistentVolume,attachment:VolumeAttachment,options:{force:boolean}){return this.transport.detach(volume.providerId!,this.resource(volume,attachment),options.force)}
  resize(volume:PersistentVolume,capacityBytes:number){return this.transport.resize(volume.providerId!,capacityBytes)}
  snapshot(volume:PersistentVolume,snapshot:VolumeSnapshot){return this.transport.snapshot(volume.providerId!,snapshot.name)}
  restore(volume:PersistentVolume,snapshot:VolumeSnapshot,target:PersistentVolume){if(!snapshot.providerId)throw new Error('Cloud snapshot provider identity is unavailable.');return this.transport.restore(volume.providerId!,snapshot.providerId,target.name)}
  delete(volume:PersistentVolume){return this.transport.delete(volume.providerId!)}
  usage(volume:PersistentVolume){return this.transport.usage(volume.providerId!)}
}
