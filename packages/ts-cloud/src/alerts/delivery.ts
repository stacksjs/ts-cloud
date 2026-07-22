import type { JsonValue } from '../control-plane'
import type { Alert, NotificationChannel, NotificationDelivery, NotificationRoute } from './model'
import { createHmac } from 'node:crypto'
import { AlertStore } from './store'

export type NotificationFetch = (input: string, init: { method: string, headers: Record<string,string>, body: string, signal?: AbortSignal }) => Promise<{ ok: boolean, status: number }>
export type NotificationEmail = (input: { to: string|string[], from?: string, subject: string, text: string }) => Promise<unknown>

function minuteInZone(at: Date, timezone: string): { minute: number, weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(part=>[part.type,part.value]))
  const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return { minute:Number(parts.hour)*60+Number(parts.minute),weekday:weekdays.indexOf(parts.weekday) }
}
function clock(value:string):number{const match=/^(\d{2}):(\d{2})$/.exec(value);if(!match)throw new Error('Quiet hours require HH:MM times.');const minute=Number(match[1])*60+Number(match[2]);if(Number(match[1])>23||Number(match[2])>59)throw new Error('Quiet hours require valid HH:MM times.');return minute}
export function isQuietHours(route: NotificationRoute, at: Date): boolean { if(!route.quietHours)return false;const local=minuteInZone(at,route.quietHours.timezone),start=clock(route.quietHours.start),end=clock(route.quietHours.end);if(route.quietHours.weekdays?.length&&!route.quietHours.weekdays.includes(local.weekday))return false;return start<=end?local.minute>=start&&local.minute<end:local.minute>=start||local.minute<end }

function matches(route:NotificationRoute,alert:Alert,eventType:string):boolean{const m=route.matcher;return (!m.projectIds?.length||m.projectIds.includes(alert.projectId))&&(!m.environmentIds?.length||!!alert.environmentId&&m.environmentIds.includes(alert.environmentId))&&(!m.resourceIds?.length||!!alert.resourceId&&m.resourceIds.includes(alert.resourceId))&&(!m.severities?.length||m.severities.includes(alert.severity))&&(!m.eventTypes?.length||m.eventTypes.includes(eventType))}
function credential(value:string|undefined):Record<string,string>{if(!value)return{};try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'?parsed:{value}}catch{return{value}}}
function payload(alert: Alert, eventType: string): Record<string,JsonValue> {
  return {schemaVersion:1,event:eventType,alert:{id:alert.id,state:alert.state,severity:alert.severity,title:alert.title,projectId:alert.projectId,environmentId:alert.environmentId??null,resourceId:alert.resourceId??null,groupKey:alert.groupKey,firstSeenAt:alert.firstSeenAt,lastSeenAt:alert.lastSeenAt,firingAt:alert.firingAt??null,resolvedAt:alert.resolvedAt??null,evidence:alert.evidence}}
}

export class NotificationRouter {
  private readonly fetchImpl: NotificationFetch
  constructor(private readonly store:AlertStore,private readonly options:{fetchImpl?:NotificationFetch,emailImpl?:NotificationEmail,now?:()=>Date}={}){this.fetchImpl=options.fetchImpl??(globalThis.fetch as unknown as NotificationFetch)}
  private now():Date{return this.options.now?.()??new Date()}

  preview(organizationId: string, alert: Alert, eventType: string) {
    return this.store.listRoutes(organizationId).filter(route => route.enabled && matches(route, alert, eventType)).map(route => ({route,channels:route.channelIds.flatMap((id) => {
      const channel = this.store.getChannel(id)
      return channel?.status === 'active' ? [channel] : []
    }),quiet:isQuietHours(route,this.now())}))
  }
  enqueue(organizationId:string,alert:Alert,eventType:'firing'|'resolved'|'reminder'|'escalation'):NotificationDelivery[]{const marker=eventType==='resolved'?alert.resolvedAt:eventType==='firing'?alert.firingAt:alert.updatedAt;const deliveries:NotificationDelivery[]=[];for(const match of this.preview(organizationId,alert,eventType)){if(match.quiet&&eventType!=='resolved')continue;const nextAttemptAt=eventType==='resolved'||match.route.groupWaitSeconds===0?undefined:new Date(this.now().getTime()+match.route.groupWaitSeconds*1000).toISOString();for(const channel of match.channels)deliveries.push(this.store.createDelivery({alertId:alert.id,channelId:channel.id,routeId:match.route.id,eventType,idempotencyKey:`${alert.id}:${eventType}:${marker}:${channel.id}`,payload:payload(alert,eventType),nextAttemptAt}))}return deliveries}
  enqueueRemindersAndEscalations(organizationId:string,alerts:Alert[]):NotificationDelivery[]{const now=this.now(),deliveries:NotificationDelivery[]=[];for(const alert of alerts.filter(item=>item.state==='firing'&&!item.acknowledgedAt&&item.firingAt)){const ageSeconds=Math.max(0,(now.getTime()-new Date(alert.firingAt!).getTime())/1000);for(const match of this.preview(organizationId,alert,'reminder')){if(match.quiet)continue;if(match.route.reminderSeconds&&ageSeconds>=match.route.reminderSeconds){const slot=Math.floor(ageSeconds/match.route.reminderSeconds);for(const channel of match.channels)deliveries.push(this.store.createDelivery({alertId:alert.id,channelId:channel.id,routeId:match.route.id,eventType:'reminder',idempotencyKey:`${alert.id}:reminder:${match.route.id}:${slot}:${channel.id}`,payload:payload(alert,'reminder')}))}for(const [index,step] of match.route.escalation.entries())if(ageSeconds>=step.afterSeconds)for(const channelId of step.channelIds){const channel=this.store.getChannel(channelId);if(channel?.status==='active')deliveries.push(this.store.createDelivery({alertId:alert.id,channelId,routeId:match.route.id,eventType:'escalation',idempotencyKey:`${alert.id}:escalation:${match.route.id}:${index}:${channelId}`,payload:payload(alert,'escalation')}))}}}return deliveries}

  private async send(channel:NotificationChannel,body:Record<string,JsonValue>):Promise<{ok:boolean,status?:number,error?:string}>{const secret=credential(this.store.channelCredential(channel.id));const text=`[${String((body.alert as any)?.severity??'info').toUpperCase()}] ${String((body.alert as any)?.title??'ts-cloud alert')} · ${String((body.alert as any)?.state??body.event)}`;try{
    if(channel.kind==='email'){if(!this.options.emailImpl)return{ok:false,error:'Email adapter is not configured.'};await this.options.emailImpl({to:channel.config.to as string|string[],from:channel.config.from as string|undefined,subject:`[ts-cloud] ${String((body.alert as any)?.title??body.event)}`,text:`${text}\n\n${JSON.stringify(body,null,2)}`});return{ok:true,status:202}}
    let url = secret.url ?? secret.value
    let posted: unknown = body
    const headers: Record<string,string> = {'content-type':'application/json'}
    if(channel.kind==='slack')posted={text};if(channel.kind==='discord')posted={content:text};if(channel.kind==='teams')posted={text};if(channel.kind==='telegram'){const token=secret.botToken??secret.value;url=`https://api.telegram.org/bot${token}/sendMessage`;posted={chat_id:channel.config.chatId,text}}
    if(!url||!/^https:\/\//.test(url))return{ok:false,error:'Channel endpoint is unavailable or not HTTPS.'}
    const encoded=JSON.stringify(posted);if(channel.kind==='webhook'&&secret.signingSecret){const timestamp=Math.floor(this.now().getTime()/1000).toString();headers['x-ts-cloud-timestamp']=timestamp;headers['x-ts-cloud-signature']=`v1=${createHmac('sha256',secret.signingSecret).update(`${timestamp}.${encoded}`).digest('hex')}`}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {const response=await this.fetchImpl(url,{method:'POST',headers,body:encoded,signal:controller.signal});return response.ok?{ok:true,status:response.status}:{ok:false,status:response.status,error:`Channel returned HTTP ${response.status}.`}}finally{clearTimeout(timer)}
  }catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)}}}

  async deliver(id:string):Promise<NotificationDelivery>{const current=this.store.getDelivery(id);if(!current)throw new Error('Notification delivery was not found.');if(current.state==='delivered'||current.state==='dead'||current.nextAttemptAt&&current.nextAttemptAt>this.now().toISOString())return current;const channel=this.store.getChannel(current.channelId);if(!channel||channel.status==='disabled'||channel.status==='paused')return this.store.updateDelivery(id,{state:'failed',attempt:current.attempt+1,error:'Notification channel is unavailable.'});const attempt=current.attempt+1,result=await this.send(channel,current.payload);if(result.ok){this.store.setChannelStatus(channel.id,'active');return this.store.updateDelivery(id,{state:'delivered',attempt,responseStatus:result.status,deliveredAt:this.now().toISOString()})}const transient=!result.status||result.status===429||result.status>=500;const terminal=!transient||attempt>=current.maxAttempts;const nextAttemptAt=terminal?undefined:new Date(this.now().getTime()+Math.min(3600_000,30_000*2**(attempt-1))).toISOString();this.store.setChannelStatus(channel.id,'failing',result.error);return this.store.updateDelivery(id,{state:terminal?'dead':'retrying',attempt,nextAttemptAt,responseStatus:result.status,error:result.error})}
  async deliverAll(deliveries:NotificationDelivery[]):Promise<NotificationDelivery[]>{return Promise.all(deliveries.map(item=>this.deliver(item.id)))}
  async retryDue():Promise<NotificationDelivery[]>{const now=this.now().toISOString(),due=this.store.listDeliveries({states:['pending','retrying']}).filter(item=>!item.nextAttemptAt||item.nextAttemptAt<=now);return this.deliverAll(due)}
  async testChannel(id:string):Promise<{ok:boolean,status?:number,error?:string}>{const channel=this.store.getChannel(id);if(!channel)throw new Error('Notification channel was not found.');const result=await this.send(channel,{schemaVersion:1,event:'test',message:'ts-cloud notification channel test. No incident was created.'});this.store.markChannelTest(id,result.ok,result.error);return result}
}
