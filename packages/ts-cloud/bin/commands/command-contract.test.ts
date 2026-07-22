import { describe,expect,it } from 'bun:test'
import { readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { unsupportedCommand } from './capability-command'
describe('public command reliability contract',()=>{it('contains no TODO or timer-backed fake lifecycle success',()=>{const offenders=[] as string[];for(const name of readdirSync(import.meta.dir).filter(v=>v.endsWith('.ts')&&!v.endsWith('.test.ts'))){const source=readFileSync(join(import.meta.dir,name),'utf8');if(/\bTODO\b|await new Promise\(resolve => setTimeout/.test(source))offenders.push(name)}expect(offenders).toEqual([])});it('returns a typed deterministic unsupported result and non-zero exit',()=>{const result=unsupportedCommand('example',{provider:'ssh',target:'box',setProcessExitCode:false});expect(result).toMatchObject({ok:false,code:'unsupported_capability',exitCode:2,provider:'ssh',target:'box',retryable:false})})})
