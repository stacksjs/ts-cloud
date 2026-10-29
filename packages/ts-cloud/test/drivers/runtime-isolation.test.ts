import { expect, it } from 'bun:test'
import { buildSiteDeployScript } from '../../src/drivers/shared/deploy-script'
import { buildSiteServicesScript } from '../../src/drivers/shared/app-services'
import { runtimeIsolationSetup, runtimeIsolationUser } from '../../src/drivers/shared/runtime-isolation'

it('binds both cutover modes and every background service to the project identity', () => {
  for (const zeroDowntime of [true, false]) {
    const script = buildSiteDeployScript({ slug: 'lsu', siteName: 'api', appDir: '/var/www/lsu-api', releaseId: 'abc123', artifactFetch: [], execStart: '/usr/local/bin/bun server.ts', envEntries: {}, isolation: true, zeroDowntime, port: 3251, sharedPaths: [{path: 'storage/app', target: '/var/www/lsu-shared/training'}] }).join('\n')
    expect(script).toContain('User=tsc-lsu')
    expect(script).toContain('NoNewPrivileges=true')
    expect(script).toContain('TemporaryFileSystem=/var/www:ro')
    expect(script).toContain('BindPaths=/var/www/lsu-api -/var/www/lsu-shared')
    expect(script).toContain('chmod 600 /var/www/lsu-api/shared/.env')
    expect(script).toContain('chown -hR tsc-lsu:tsc-lsu /var/www/lsu-shared/training')
    expect(script.indexOf('useradd --system')).toBeLessThan(script.indexOf('User=tsc-lsu'))
  }
  const services = buildSiteServicesScript({slug:'lsu',siteName:'api',site:{start:'bun server.ts',isolation:true,queues:[{queue:'default'}],scheduler:true,daemons:[{command:'bun worker.ts'}]},appBase:'/var/www/lsu-api'}).join('\n')
  expect(services.match(/User=tsc-lsu/g)?.length).toBe(3)
  expect(() => buildSiteServicesScript({slug:'lsu',siteName:'api',site:{isolation:true,daemons:[{command:'bun worker.ts',user:'root'}]}})).toThrow('cannot change')
})

it('refuses unsafe identities and ownership outside the project, while long identities stay distinct', () => {
  expect(() => runtimeIsolationUser('lsu; id')).toThrow()
  expect(() => runtimeIsolationSetup('lsu','/var/www/training-api',[])).toThrow()
  expect(() => runtimeIsolationSetup('lsu','/var/www/lsu-api',['/var/www/training-shared'])).toThrow()
  expect(runtimeIsolationUser('a'.repeat(60))).not.toBe(runtimeIsolationUser('a'.repeat(59)+'b'))
  expect(runtimeIsolationUser('a'.repeat(60)).length).toBeLessThanOrEqual(32)
})

it('refuses missing/foreign compute residency and unsupported provider policies', async () => {
  const {assertComputeResidency}=await import('../../src/deploy/residency')
  const {createCloudDriver}=await import('../../src/drivers/factory')
  const policy={countries:['DE'],locations:['fsn1']}
  expect(()=>assertComputeResidency(policy,{country:'DE',location:'fsn1'})).not.toThrow()
  for(const evidence of [{},{country:'US',location:'ash'},{country:'DE',location:'nbg1'}])
    expect(()=>assertComputeResidency(policy,evidence)).toThrow()
  expect(()=>createCloudDriver({config:{project:{name:'lsu',slug:'lsu',region:'fsn1'},environments:{production:{type:'production'}},cloud:{provider:'ssh',residency:policy}}})).toThrow('live provider evidence')
})

it('checks actual provider target metadata before returning a deploy target', async () => {
  const {HetznerDriver}=await import('../../src/drivers/hetzner/driver')
  const server:any={id:9123456,name:'lsu-residency-test-production-app',status:'running',public_net:{ipv4:{ip:'192.0.2.44'}},location:{name:'fsn1',country:'DE'},labels:{'ts-cloud/project':'lsu-residency-test','ts-cloud/environment':'production','ts-cloud/role':'app'}}
  const driver=new HetznerDriver({apiToken:'fixture',client:{listServers:async()=>[server]} as any,residency:{countries:['DE'],locations:['fsn1']}})
  const target={slug:'lsu-residency-test',environment:'production' as const,role:'app' as const}
  expect((await driver.findComputeTargets(target)).length).toBe(1)
  server.location.country='US'
  await expect(driver.findComputeTargets(target)).rejects.toThrow('residency')
})
