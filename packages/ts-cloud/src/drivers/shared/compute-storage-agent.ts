import type { ComputeStoragePolicy } from './compute-storage'

/** Self-contained Bun agent, also shipped by the script builder as one program. */
export async function computeStorageAgent(policy: ComputeStoragePolicy, argv: string[]): Promise<unknown> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const child = await import('node:child_process')
  const configPath = '/etc/ts-cloud/compute-storage.json'
  const statePath = '/var/lib/ts-cloud/compute-storage-state.json'
  const rootAlias = '/run/ts-cloud-root-web'
  type Entry = { source: string, destination: string }
  const command = argv[0] ?? 'status'
  if (!['plan', 'status', 'check', 'apply', 'ensure-site', 'reclaim'].includes(command)) throw new Error(`Unknown compute storage command: ${command}`)
  const readJson = (file: string, fallback: any): any => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error }
  }
  const save = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
    fs.renameSync(temporary, file)
  }
  const run = (program: string, args: string[]): string => child.execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const tryRun = (program: string, args: string[]): string => {
    const result = child.spawnSync(program, args, { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : ''
  }
  const mounted = (directory: string): boolean => !!tryRun('findmnt', ['-n', '--mountpoint', directory])
  const sameFile = (a: string, b: string): boolean => {
    try { const first = fs.statSync(a); const second = fs.statSync(b); return first.dev === second.dev && first.ino === second.ino }
    catch { return false }
  }
  let state: { entries: Entry[], activatedAt?: string } = readJson(statePath, { entries: [] })
  const placement = policy.deploymentStorage
  const deploymentVolume = policy.volumes.find(volume => volume.key === placement?.volume)
  const discover = (onlySite?: string, project?: string): Entry[] => {
    if (!deploymentVolume) return []
    const entries: Entry[] = []
    for (const site of fs.readdirSync(policy.webRoot, { withFileTypes: true })) {
      if (!site.isDirectory() || site.isSymbolicLink()) continue
      const base = path.join(policy.webRoot, site.name)
      if (onlySite && base !== onlySite && base !== path.join(policy.webRoot, `${project}-shared`)) continue
      for (const directory of ['releases', ...(placement?.includeBackups === false ? [] : ['backups'])]) {
        const source = path.join(base, directory)
        if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) continue
        entries.push({ source, destination: path.join(deploymentVolume.mountPath, directory, site.name) })
      }
    }
    return entries
  }
  const deviceMatches = (volume: ComputeStoragePolicy['volumes'][number]): boolean => {
    try { return mounted(volume.mountPath) && fs.statSync(volume.mountPath).dev === fs.statSync(volume.device).rdev }
    catch { return false }
  }
  const disk = (directory: string): Record<string, unknown> => {
    const stats = fs.statfsSync(directory)
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize
    const availableBytes = stats.bavail * stats.bsize
    return { path: directory, sizeBytes: stats.blocks * stats.bsize, usedBytes, availableBytes,
      usedPercent: Math.ceil(100 * usedBytes / (usedBytes + availableBytes)) }
  }
  const status = (): Record<string, any> => {
    const problems: string[] = []
    const disks = [disk('/')]
    for (const volume of policy.volumes) {
      if (!deviceMatches(volume)) problems.push(`missing or incorrect volume mount: ${volume.mountPath}`)
      else disks.push(disk(volume.mountPath))
    }
    for (const entry of state.entries)
      if (!mounted(entry.source) || !sameFile(entry.source, entry.destination)) problems.push(`missing deployment mount: ${entry.source}`)
    const known = new Set(state.entries.map(entry => entry.source))
    for (const entry of discover()) if (!known.has(entry.source)) problems.push(`deployment needs volume placement: ${entry.source}`)
    return { timestamp: new Date().toISOString(), volumes: policy.volumes.map(volume => ({ key: volume.key, name: volume.name, id: volume.id, size: volume.size, mountPath: volume.mountPath })),
      disks, mounts: state.entries.length, problems }
  }
  if (command === 'plan') return console.log(JSON.stringify({ volumes: policy.volumes, entries: discover(), state }, null, 2))
  if (command === 'status' || command === 'check') {
    const report = status()
    if (command === 'check') {
      save('/var/lib/ts-cloud/compute-storage-status.json', report)
      const alertPath = '/var/lib/ts-cloud/compute-storage-alert.json'
      const previous = readJson(alertPath, { problems: [] })
      if (JSON.stringify(previous.problems) !== JSON.stringify(report.problems)) {
        const details = report.problems.join('; ') || 'all configured mounts are healthy'
        const message = `${report.problems.length ? 'Storage alert' : 'Storage recovered'} on ${tryRun('hostname', [])}: ${details}`
        run('/usr/local/bin/ts-cloud-notify', [message.length > 1800 ? `${message.slice(0, 1600)}... Full report: /var/lib/ts-cloud/compute-storage-status.json` : message])
      }
      // Failed webhooks throw above, leaving the prior state intact for retry.
      save(alertPath, { problems: report.problems, timestamp: report.timestamp })
    }
    console.log(JSON.stringify(report))
    if (report.problems.length) process.exitCode = 1
    return report
  }
  if (process.getuid?.() !== 0) throw new Error('Compute storage changes require root')
  const persistMounts = (): void => {
    const begin = '# BEGIN ts-cloud compute storage'
    const end = '# END ts-cloud compute storage'
    const file = '/etc/fstab'
    const original = fs.readFileSync(file, 'utf8')
    if (!fs.existsSync(`${file}.before-ts-cloud-storage`)) fs.copyFileSync(file, `${file}.before-ts-cloud-storage`)
    const lines: string[] = []
    for (const volume of policy.volumes) {
      const uuid = run('blkid', ['-s', 'UUID', '-o', 'value', volume.device]).trim()
      if (!uuid) throw new Error(`Volume ${volume.name} has no filesystem UUID`)
      lines.push(`UUID=${uuid} ${volume.mountPath} ext4 defaults,noatime,nodev,nosuid,nofail,x-systemd.device-timeout=30s 0 2`)
    }
    for (const entry of state.entries)
      lines.push(`${entry.destination} ${entry.source} none bind,nofail,x-systemd.requires-mounts-for=${deploymentVolume!.mountPath} 0 0`)
    const block = `${begin}\n${lines.join('\n')}\n${end}`
    let updated: string
    if (original.includes(begin)) {
      const start = original.indexOf(begin); const finish = original.indexOf(end, start)
      if (finish < 0) throw new Error('Incomplete managed storage block in fstab')
      updated = original.slice(0, start) + block + original.slice(finish + end.length)
    }
    else updated = `${original.trimEnd()}\n${block}\n`
    fs.writeFileSync(`${file}.ts-cloud-new`, updated)
    fs.renameSync(`${file}.ts-cloud-new`, file)
  }
  const mountVolumes = (): void => {
    for (const volume of policy.volumes) {
      if (!fs.existsSync(volume.device) || !fs.statSync(volume.device).isBlockDevice()) throw new Error(`Volume device missing: ${volume.device}`)
      let format = tryRun('blkid', ['-s', 'TYPE', '-o', 'value', volume.device])
      if (!format) {
        if (!volume.allowFormat) throw new Error(`Refusing to format adopted volume ${volume.name}; no recognized filesystem`)
        run('mkfs.ext4', ['-m', '1', volume.device]); format = 'ext4'
      }
      if (format !== 'ext4') throw new Error(`Refusing to replace ${format} filesystem on ${volume.name}`)
      fs.mkdirSync(volume.mountPath, { recursive: true })
      if (mounted(volume.mountPath) && !deviceMatches(volume)) throw new Error(`Another filesystem occupies ${volume.mountPath}`)
      if (!mounted(volume.mountPath) && fs.readdirSync(volume.mountPath).length)
        throw new Error(`Refusing to hide existing files beneath ${volume.mountPath}`)
      if (!mounted(volume.mountPath)) run('mount', ['-o', 'noatime,nodev,nosuid', volume.device, volume.mountPath])
      if (!deviceMatches(volume)) throw new Error(`Volume identity verification failed: ${volume.name}`)
      run('resize2fs', [volume.device])
      volume.allowFormat = false
    }
    save(configPath, policy)
    persistMounts()
    run('systemctl', ['daemon-reload'])
  }
  const { dlopen } = await import('bun:ffi')
  const libc = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' } })
  const descriptors: number[] = []
  const lock = (file: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600)
    if (libc.symbols.flock(fd, 2) !== 0) { fs.closeSync(fd); throw new Error(`Could not acquire lock: ${file}`) }
    descriptors.push(fd)
  }
  const processFiles = (): Array<{ file: string, write: boolean, device: number }> => {
    const files: Array<{ file: string, write: boolean, device: number }> = []
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let fds: string[] = []
      try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
      for (const name of ['cwd', 'exe', ...fds.map(fd => `fd/${fd}`)]) {
        const link = `/proc/${pid}/${name}`
        try {
          const file = fs.readlinkSync(link)
          if (!file.startsWith(`${policy.webRoot}/`) || !file.includes('/releases/')) continue
          let write = false
          if (name.startsWith('fd/')) {
            const flags = fs.readFileSync(`/proc/${pid}/fdinfo/${name.slice(3)}`, 'utf8').match(/^flags:\s+(\d+)/m)
            write = !!flags && (Number.parseInt(flags[1], 8) & 3) !== 0 && fs.statSync(link).isFile()
          }
          files.push({ file, write, device: fs.statSync(link).dev })
        } catch {}
      }
    }
    return files
  }
  const sync = async (entry: Entry, checksum: boolean): Promise<void> => {
    fs.mkdirSync(entry.destination, { recursive: true })
    const args = ['rsync', '-aHAXx', '--numeric-ids', '--delete', ...(checksum ? ['--checksum'] : []), `${entry.source}/`, `${entry.destination}/`]
    const process = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
    const exit = await process.exited
    if (exit !== 0 && !(exit === 24 && !checksum)) throw new Error(`rsync failed (${exit}): ${entry.source}`)
  }
  const inspectApplications = async (): Promise<{ routes: Array<{ domain: string, path: string, ok: boolean, status: number }>, services: Record<string, number> }> => {
    const units = run('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain']).split('\n')
      .map(line => line.trim().split(/\s+/)[0]).filter(Boolean)
    const services: Record<string, number> = {}
    if (units.length) {
      const detail = run('systemctl', ['show', ...units, '-p', 'Id', '-p', 'MainPID', '-p', 'WorkingDirectory'])
      for (const block of detail.split('\n\n')) {
        const values = Object.fromEntries(block.split('\n').filter(Boolean).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
        if (values.WorkingDirectory?.startsWith(`${policy.webRoot}/`) || /^(?:mail|rpx-gateway|postgresql|mysql|redis)[@.]/.test(values.Id ?? ''))
          services[values.Id] = Number(values.MainPID)
      }
    }
    const targets = new Map<string, { domain: string, path: string }>()
    if (fs.existsSync('/etc/rpx/sites.d')) for (const file of fs.readdirSync('/etc/rpx/sites.d').filter(file => file.endsWith('.json'))) {
      const fragment = JSON.parse(fs.readFileSync(path.join('/etc/rpx/sites.d', file), 'utf8'))
      for (const route of fragment.proxies ?? []) {
        if (typeof route.to !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(route.to)) continue
        const routePath = typeof route.path === 'string' && route.path.startsWith('/') ? route.path : '/'
        targets.set(`${route.to}${routePath}`, { domain: route.to, path: routePath })
      }
    }
    const queue = [...targets.values()]
    const routes: Array<{ domain: string, path: string, ok: boolean, status: number }> = []
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (cursor < queue.length) {
        const target = queue[cursor++]
        const probe = Bun.spawn(['curl', '-sS', '--max-time', '12', '--output', '/dev/null', '--write-out', '%{http_code}',
          '--resolve', `${target.domain}:443:127.0.0.1`, `https://${target.domain}${target.path}`], { stdout: 'pipe', stderr: 'pipe' })
        const [output, , exit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited])
        const code = Number(output)
        routes.push({ ...target, status: code, ok: exit === 0 && code >= 200 && code < 500 })
      }
    }))
    return { routes: routes.sort((a, b) => `${a.domain}${a.path}`.localeCompare(`${b.domain}${b.path}`)), services }
  }
  const installDependencies = (): void => {
    const paths = [deploymentVolume!.mountPath, ...state.entries.map(entry => entry.source)]
    const units = new Set(['rpx-gateway.service', ...(placement?.dependentUnits ?? [])])
    for (const name of fs.readdirSync('/etc/systemd/system')) {
      if (!name.endsWith('.service')) continue
      try { if (fs.readFileSync(`/etc/systemd/system/${name}`, 'utf8').includes(policy.webRoot)) units.add(name) } catch {}
    }
    for (const unit of units) {
      const directory = `/etc/systemd/system/${unit}.d`; fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(`${directory}/ts-cloud-storage.conf`, `[Unit]\nRequiresMountsFor=${paths.join(' ')}\n`)
    }
    run('systemctl', ['daemon-reload'])
  }
  try {
    lock('/run/lock/ts-cloud-compute-storage.lock')
    state = readJson(statePath, { entries: [] })
    const previousPolicy = readJson(configPath, null) as ComputeStoragePolicy | null
    if (previousPolicy) {
      for (const previous of previousPolicy.volumes) {
        if (!policy.volumes.some(volume => volume.id === previous.id && volume.key === previous.key && volume.mountPath === previous.mountPath))
          throw new Error(`Refusing to remove or relocate managed volume ${previous.name}; migrate its data explicitly first`)
      }
      if (state.entries.length && (previousPolicy.deploymentStorage?.volume !== placement?.volume
        || (previousPolicy.deploymentStorage?.includeBackups !== false) !== (placement?.includeBackups !== false)))
        throw new Error('Refusing to change an active deployment-storage policy; migrate its data explicitly first')
    }
    if (command === 'apply') mountVolumes()
    for (const volume of policy.volumes) if (!deviceMatches(volume)) throw new Error(`Required volume is not mounted: ${volume.name}`)
    if (!placement || !deploymentVolume) return { volumes: policy.volumes }
    if (command === 'ensure-site') {
      const [base, slug] = argv.slice(1)
      if (!base?.startsWith(`${policy.webRoot}/`) || !/^[\w-]+$/.test(path.basename(base)) || base.includes('..') || !/^[\w-]+$/.test(slug ?? ''))
        throw new Error('Invalid deployment site path or project slug')
      fs.mkdirSync(path.join(base, 'releases'), { recursive: true })
      if (placement.includeBackups !== false) fs.mkdirSync(path.join(policy.webRoot, `${slug}-shared`, 'backups'), { recursive: true })
    }
    const entries = (command === 'reclaim' ? [] : discover(command === 'ensure-site' ? argv[1] : undefined, argv[2]))
      .filter(entry => !state.entries.some(previous => previous.source === entry.source))
    for (const entry of state.entries) {
      if (!mounted(entry.source) || !sameFile(entry.source, entry.destination)) throw new Error(`Recorded deployment mount is missing: ${entry.source}`)
    }
    if (!entries.length && command === 'ensure-site') return { inherited: true, volume: deploymentVolume.name }
    if (!placement.migrateExisting && entries.some(entry => fs.readdirSync(entry.source).length > 0))
      throw new Error('Existing deployments require deploymentStorage.migrateExisting: true')
    if (entries.length) {
      const bytes = run('du', ['-scx', '--block-size=1', ...entries.map(entry => entry.source)]).trim().split('\n').at(-1)?.split(/\s+/)[0]
      const free = fs.statfsSync(deploymentVolume.mountPath)
      if (Number(bytes) > free.bavail * free.bsize)
        throw new Error('Insufficient free volume capacity for a verified deployment copy')
    }
    if (!fs.existsSync(rootAlias)) fs.mkdirSync(rootAlias)
    if (!mounted(rootAlias)) run('mount', ['--bind', policy.webRoot, rootAlias])
    for (let index = 0; index < entries.length; index++) {
      if (mounted(entries[index].source) && sameFile(entries[index].source, entries[index].destination)) continue
      console.log(`copy ${index + 1}/${entries.length}: ${entries[index].source}`)
      await sync(entries[index], false)
    }
    for (const file of new Set([...(placement.locks ?? []), '/run/lock/ts-cloud-host-cleanup.lock'])) lock(file)
    for (const site of fs.readdirSync(policy.webRoot, { withFileTypes: true }).filter(site => site.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      lock(path.join(policy.webRoot, site.name, '.ts-cloud/deploy.lock'))
    for (const entry of command === 'reclaim' ? [] : discover(command === 'ensure-site' ? argv[1] : undefined, argv[2])) {
      if (!state.entries.some(previous => previous.source === entry.source) && !entries.some(previous => previous.source === entry.source)) entries.push(entry)
    }
    if (entries.length) console.log('Checking application services and HTTPS routes before activation')
    const beforeHealth = entries.length ? await inspectApplications() : undefined
    if (beforeHealth) save('/var/lib/ts-cloud/compute-storage-health-before.json', beforeHealth)
    const mutable = processFiles().filter(file => file.write)
    if (mutable.length) throw new Error(`Live writable files must be shared before migration: ${mutable.map(file => file.file).join(', ')}`)
    const before = { entries: [...state.entries], fstab: fs.readFileSync('/etc/fstab', 'utf8') }
    // Make the online copy durable before recording any boot-time bind mounts.
    if (entries.length) run('sync', [])
    const newMounts: Entry[] = []
    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (mounted(entry.source)) {
          // A previous invocation may have been interrupted between mount(2)
          // and its journal write. Only adopt the exact destination inode.
          if (!sameFile(entry.source, entry.destination)) throw new Error(`Unrecorded mount occupies ${entry.source}`)
          state.entries.push(entry); save(statePath, state); continue
        }
        console.log(`verify and mount ${index + 1}/${entries.length}: ${entry.source}`)
        await sync(entry, true)
        run('mount', ['--bind', entry.destination, entry.source])
        if (!sameFile(entry.source, entry.destination)) throw new Error(`Bind verification failed: ${entry.source}`)
        newMounts.push(entry); state.entries.push(entry)
        save(statePath, state)
        persistMounts()
      }
      persistMounts(); run('findmnt', ['--verify'])
      state.activatedAt = new Date().toISOString(); save(statePath, state)
      installDependencies()
      if (beforeHealth) {
        console.log('Checking application services and HTTPS routes after activation')
        const afterHealth = await inspectApplications()
        save('/var/lib/ts-cloud/compute-storage-health-after.json', afterHealth)
        const unhealthy = beforeHealth.routes.filter(route => route.ok && !afterHealth.routes.some(after => after.domain === route.domain && after.path === route.path && after.ok))
        const stopped = Object.keys(beforeHealth.services).filter(unit => !afterHealth.services[unit])
        if (unhealthy.length || stopped.length) throw new Error(`Application verification failed: ${unhealthy.map(route => route.domain + route.path).concat(stopped).join(', ')}`)
        console.log(`Verified ${afterHealth.routes.length} routes and ${Object.keys(afterHealth.services).length} services`)
      }
    } catch (error) {
      const retained: Entry[] = []
      for (const entry of newMounts.reverse()) {
        try { run('umount', [entry.source]) } catch { retained.push(entry); console.error(`Rollback mount busy, original data retained: ${entry.source}`) }
      }
      state.entries = [...before.entries, ...retained]; fs.writeFileSync('/etc/fstab', before.fstab)
      if (retained.length) persistMounts()
      save(statePath, state)
      run('systemctl', ['daemon-reload']); throw error
    }
    // Reclaim only verified duplicates. Keep the original current release and
    // every release still referenced by a running process; never restart apps.
    const rootDevice = fs.statSync(policy.webRoot).dev
    const protectedFiles = processFiles().filter(file => file.device === rootDevice).map(file => file.file)
    for (const entry of state.entries) {
      if (!mounted(entry.source) || !sameFile(entry.source, entry.destination)) throw new Error(`Lost deployment mount: ${entry.source}`)
      const original = path.join(rootAlias, path.relative(policy.webRoot, entry.source))
      if (!fs.existsSync(original)) continue
      let current = ''
      try { current = path.basename(fs.realpathSync(path.join(path.dirname(entry.source), 'current'))) } catch {}
      for (const item of fs.readdirSync(original, { withFileTypes: true })) {
        const file = path.join(original, item.name)
        if (path.basename(entry.source) === 'backups') {
          if (item.isFile() && fs.existsSync(path.join(entry.destination, item.name))) fs.unlinkSync(file)
        } else if (item.isDirectory() && !item.isSymbolicLink() && item.name !== current
          && !protectedFiles.some(reference => reference === path.join(entry.source, item.name) || reference.startsWith(`${path.join(entry.source, item.name)}/`))) {
          fs.rmSync(file, { recursive: true })
        }
      }
    }
    run('sync', [])
    const report = status(); save('/var/lib/ts-cloud/compute-storage-status.json', report)
    console.log(JSON.stringify(report)); return report
  } finally {
    for (const fd of descriptors.reverse()) { libc.symbols.flock(fd, 8); fs.closeSync(fd) }
    libc.close()
  }
}
