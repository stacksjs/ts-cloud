import { expect, test } from 'bun:test'
import { randomBytes, randomInt } from 'node:crypto'
import { buildServicesProvisionScript } from '../../src/drivers/shared/db-provision'

// Explicit opt-in: a root SSH account on a Linux host with Pantry installed.
// The test creates only randomly named fixture resources. No application,
// database, existing unit, account or data directory is adopted or removed.
const host = process.env.TS_CLOUD_TYPESENSE_TEST_HOST
const identity = process.env.TS_CLOUD_TYPESENSE_TEST_SSH_KEY

test.skipIf(!host || !identity)('managed Typesense authenticates, replays and recovers an interrupted key update on Linux', async () => {
  if (!/^[a-zA-Z0-9_.@:-]+$/.test(host!) || host!.startsWith('-')) throw new Error('Invalid fixture SSH host')
  const name = `ts-cloud-typesense-qa-${randomBytes(3).toString('hex')}`
  const collision = `${name}-x`
  const port = randomInt(22000, 29000)
  const firstKey = randomBytes(32).toString('hex')
  const nextKey = randomBytes(32).toString('hex')
  const environment = `/etc/ts-cloud/${name}.env`
  const applied = `/etc/ts-cloud/${name}.applied`
  const unit = `/etc/systemd/system/${name}.service`
  let owned = false

  async function remote(script: string, timeout = 360_000): Promise<{ code: number, stdout: string, stderr: string }> {
    const child = Bun.spawn(['ssh', '-i', identity!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', host!, 'bash', '-se'], {
      stdin: Buffer.from(`set +x\n${script}\n`), stdout: 'pipe', stderr: 'pipe', timeout,
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, stdout, stderr }
  }
  async function ok(script: string): Promise<string> {
    const result = await remote(script)
    if (result.code !== 0) throw new Error(`Owned Typesense fixture failed (${result.code}): ${result.stderr.slice(-2000)}`)
    return result.stdout
  }
  const provision = (key: string, instance = name): string => buildServicesProvisionScript({ typesense: { version: '30.2', apiKey: key, port } }).join('\n')
    .replaceAll('ts-cloud-typesense', instance)
    .replaceAll('/etc/ts-cloud/typesense.env', `/etc/ts-cloud/${instance}.env`)
    .replaceAll('/etc/ts-cloud/typesense.applied', `/etc/ts-cloud/${instance}.applied`)
  const request = (key: string, path: string, options = ''): string => `printf 'header = "X-TYPESENSE-API-KEY: %s"\\n' '${key}' | curl -q --noproxy '*' --config - -fsS --max-time 5 ${options} 'http://127.0.0.1:${port}${path}'`

  try {
    await ok(`
test "$(id -u)" = 0
test "$(df -Pk /var/lib | awk 'NR==2{print $4}')" -ge 4194304
test "$(awk '/MemAvailable:/{print $2}' /proc/meminfo)" -ge 524288
awk -v cores="$(getconf _NPROCESSORS_ONLN)" '{exit !($1/cores <= 1.5)}' /proc/loadavg
command -v pantry >/dev/null
test ! -e '${unit}' && test ! -e '${environment}' && test ! -e '${applied}'
test ! -e '/var/lib/${name}'
! id '${name}' >/dev/null 2>&1
! getent group '${name}' >/dev/null
! ss -ltnH | awk '{print $4}' | grep -Eq '[:.](${port}|${port - 1})$'
mkdir '/var/lock/${name}.owner'
`)
    owned = true
    await ok(provision(firstKey))
    const pid = (await ok(`systemctl show --property=MainPID --value '${name}.service'`)).trim()
    expect(Number(pid)).toBeGreaterThan(0)
    expect(await ok(`${request(firstKey, '/collections')}\n`)).toBe('[]')
    await ok(`
test "$(stat -c %a '${environment}')" = 600
test "$(stat -c %a '${applied}')" = 600
test "$(stat -c %a '/var/lib/${name}')" = 700
! runuser -u '${name}' -- test -r '${environment}'
! grep -q '${firstKey}' '${unit}'
! systemctl show --property=Environment '${name}.service' | grep -q '${firstKey}'
! ps -p '${pid}' -o args= | grep -q '${firstKey}'
`)
    // A real document survives replay and credential activation.
    await ok(request(firstKey, '/collections', `-X POST -H 'Content-Type: application/json' -d '{"name":"fixture","fields":[{"name":"label","type":"string"}]}'`))
    await ok(request(firstKey, '/collections/fixture/documents', `-X POST -H 'Content-Type: application/json' -d '{"id":"1","label":"retained fixture"}'`))
    await ok(provision(firstKey))
    expect((await ok(`systemctl show --property=MainPID --value '${name}.service'`)).trim()).toBe(pid)
    const refused = await remote(provision(firstKey, collision))
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('ports belong to another service')
    await ok(`test ! -e '/etc/ts-cloud/${collision}.env'`)
    // Simulate interruption after installing the desired file, before restart.
    await ok(`sed -i 's/${firstKey}/${nextKey}/' '${environment}'`)
    await ok(provision(nextKey))
    expect((await ok(`systemctl show --property=MainPID --value '${name}.service'`)).trim()).not.toBe(pid)
    expect(JSON.parse(await ok(request(nextKey, '/collections/fixture/documents/1'))).label).toBe('retained fixture')
    expect((await ok(`printf 'header = "X-TYPESENSE-API-KEY: %s"\\n' '${firstKey}' | curl -q --noproxy '*' --config - -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/collections'`)).trim()).toBe('401')
    expect((await ok(`curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/collections'`)).trim()).toBe('401')
    const journal = await ok(`journalctl -u '${name}.service' --no-pager -o cat`)
    expect(journal).not.toContain(firstKey)
    expect(journal).not.toContain(nextKey)
  }
  finally {
    if (owned) {
      const cleanup = await remote(`
if test -e '${unit}'; then
  systemctl stop '${name}.service'
  systemctl disable '${name}.service'
  test "$(systemctl show --property=MainPID --value '${name}.service')" = 0
fi
rm -f -- '${unit}' '${environment}' '${applied}' '/var/lock/${name}.lock'
systemctl daemon-reload
systemctl reset-failed '${name}.service' 2>/dev/null || true
rm -rf -- '/var/lib/${name}'
if id '${name}' >/dev/null 2>&1; then userdel '${name}'; fi
if getent group '${name}' >/dev/null; then groupdel '${name}'; fi
rmdir '/var/lock/${name}.owner'
test ! -e '${unit}' && test ! -e '${environment}' && test ! -e '/var/lib/${name}'
`, 60_000)
      expect(cleanup.code).toBe(0)
    }
  }
}, 600_000)
