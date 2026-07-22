import type { HealthCheck, HealthResult } from './model'
import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import { AlertEvaluator, type AlertEvaluation } from './evaluator'
import { AlertStore } from './store'

type FetchLike = (input: string, init: { method: string, headers?: Record<string,string>, signal: AbortSignal, redirect: 'manual' }) => Promise<Response>
type CommandLike = (command: string[], timeoutMs: number) => Promise<{ exitCode: number, stdout: string, stderr: string }>

async function commandDefault(command: string[], timeoutMs: number): Promise<{ exitCode: number, stdout: string, stderr: string }> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }
  }
  finally {
    clearTimeout(timer)
  }
}

export class HealthCheckRunner {
  constructor(private readonly store:AlertStore,private readonly options:{fetchImpl?:FetchLike,commandImpl?:CommandLike,lookupImpl?:(hostname:string)=>Promise<unknown>,now?:()=>Date,agent?:string,region?:string}={}){}
  private now():Date{return this.options.now?.()??new Date()}
  async probe(check:HealthCheck):Promise<Omit<HealthResult,'id'>>{const started=performance.now(),checkedAt=this.now().toISOString(),agent=this.options.agent??'local';try{
    if(check.kind==='http'){const url=new URL(check.target);const dnsStart=performance.now();await (this.options.lookupImpl??lookup)(url.hostname);const dnsMs=performance.now()-dnsStart;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),check.timeoutSeconds*1000);try{const requestStart=performance.now();const response=await (this.options.fetchImpl??fetch)(url.toString(),{method:check.config.method??'GET',headers:check.config.headers,signal:controller.signal,redirect:'manual'});const ttfbMs=performance.now()-requestStart;const text=check.config.expectedBody?await response.text():'';const expected=check.config.expectedStatuses??[200,201,202,204];const ok=expected.includes(response.status)&&(!check.config.expectedBody||text.includes(check.config.expectedBody));return{checkId:check.id,status:ok?'healthy':'unhealthy',agent,region:this.options.region,statusCode:response.status,message:ok?undefined:`Expected ${expected.join('/')} and configured body match.`,timings:{dnsMs,ttfbMs,totalMs:performance.now()-started},checkedAt}}finally{clearTimeout(timer)}}
    if(check.kind==='tcp'){const port=Number(check.config.port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('TCP health check requires a valid port.');const connectStart=performance.now();await new Promise<void>((resolve,reject)=>{const socket=connect({host:check.target,port});const timer=setTimeout(()=>{socket.destroy();reject(new Error('TCP health check timed out.'))},check.timeoutSeconds*1000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve()});socket.once('error',error=>{clearTimeout(timer);reject(error)})});return{checkId:check.id,status:'healthy',agent,region:this.options.region,timings:{connectMs:performance.now()-connectStart,totalMs:performance.now()-started},checkedAt}}
    const command = check.config.command ?? []
    if (!command.length) throw new Error('Command health check is not configured.')
    const outcome = await (this.options.commandImpl ?? commandDefault)(command, check.timeoutSeconds * 1000)
    return {checkId:check.id,status:outcome.exitCode===0?'healthy':'unhealthy',agent,region:this.options.region,message:outcome.exitCode===0?undefined:(outcome.stderr||outcome.stdout||`Command exited ${outcome.exitCode}`).slice(0,1000),timings:{totalMs:performance.now()-started},checkedAt}
  }catch(error){return{checkId:check.id,status:'unhealthy',agent,region:this.options.region,message:(error instanceof Error?error.message:String(error)).slice(0,1000),timings:{totalMs:performance.now()-started},checkedAt}}}
  async run(check:HealthCheck):Promise<HealthResult>{return this.store.appendHealthResult(await this.probe(check))}
  async runAndEvaluate(check:HealthCheck):Promise<{result:HealthResult,evaluations:AlertEvaluation[]}>{const result=await this.run(check),evaluator=new AlertEvaluator(this.store),rules=this.store.listRules(check.projectId,check.environmentId).filter(rule=>rule.healthCheckId===check.id);return{result,evaluations:rules.map(rule=>evaluator.evaluate(rule,{status:result.status,timestamp:result.checkedAt,group:{agent:result.agent,region:result.region??''},evidence:{healthResultId:result.id,statusCode:result.statusCode??null,message:result.message??null,timings:result.timings}}))}}
}
