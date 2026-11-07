import type { ComputeStoragePolicy } from './compute-storage'

/** Operator maintenance, not an application worker. Serialized as the published host agent. */
export async function persistentStorageAgent(policy: ComputeStoragePolicy, command = 'status'): Promise<unknown> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const cp = await import('node:child_process')
  const declaration = policy.persistentStorage
  if (!declaration) return
  const volume = policy.volumes.find(item => item.key === declaration.volume)
  if (!volume) throw new Error('Persistent storage volume is not declared')
  const stateFile = '/var/lib/ts-cloud/persistent-storage-state.json'
  const alias = '/run/ts-cloud-root-data'
  const run = (program: string, args: string[]): string => cp.execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const read = (file: string, fallback: any): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error } }
  const save = (file: string, value: unknown): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.new`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); const fd = fs.openSync(`${file}.new`, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }; fs.renameSync(`${file}.new`, file); const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) } }
  const mounted = (file: string): boolean => cp.spawnSync('mountpoint', ['-q', file]).status === 0
  const same = (a: string, b: string): boolean => { try { const x = fs.statSync(a); const y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino } catch { return false } }
  type Entry = { source: string, destination: string, verified?: boolean, checksummedAt?: string, bytes?: number }
  let state: { entries: Entry[], stopped: string[], phase?: string, fstab?: string, dropins?: Record<string, string | null> } = read(stateFile, { entries: [], stopped: [] })
  const entries: Entry[] = declaration.paths.map(item => ({ source: item.path, destination: path.join(volume.mountPath, 'persistent', item.path.slice(1)) }))
  for (const old of state.entries) if (!entries.some(item => item.source === old.source && item.destination === old.destination)) throw new Error(`Refusing to remove active persistent placement: ${old.source}`)
  if (!mounted(volume.mountPath) || fs.statSync(volume.mountPath).dev !== fs.statSync(volume.device).rdev) throw new Error('Required persistent volume is missing or incorrect')
  const problems = (): string[] => entries.filter(item => !mounted(item.source) || !same(item.source, item.destination)).map(item => `Persistent mount missing: ${item.source}`)
  if (command === 'check') { if (problems().length) throw new Error(problems().join('; ')); return { healthy: true } }
  if (command === 'status') { const report = { entries, phase: state.phase, problems: problems() }; console.log(JSON.stringify(report)); return report }
  if (command !== 'apply' || process.getuid?.() !== 0) throw new Error('Persistent storage apply requires root')
  let pending = entries.filter(item => !state.entries.some(old => old.source === item.source && old.verified))

  if (!declaration.migrateExisting) throw new Error('Persistent data migration requires migrateExisting: true')
  const validateSources = (): void => { for (const item of pending) {
    if (mounted(item.source) && same(item.source, item.destination)) { if (!state.entries.some(old => old.source === item.source && old.checksummedAt)) throw new Error('Mounted persistent source has no verified cutover journal'); continue }
    if (fs.realpathSync(item.source) !== item.source || fs.lstatSync(item.source).isSymbolicLink() || !fs.statSync(item.source).isDirectory() || mounted(item.source)) throw new Error(`Unsafe persistent source: ${item.source}`)
    const nested = run('findmnt', ['-rn', '-o', 'TARGET']).split('\n').filter(target => target.startsWith(item.source + '/'))
    if (nested.length) throw new Error(`Persistent source contains another mount: ${item.source}`)
    let parent = item.destination
    while (!fs.existsSync(parent)) parent = path.dirname(parent)
    if (fs.realpathSync(parent) !== parent || !parent.startsWith(volume.mountPath)) throw new Error('Unsafe persistent destination ancestry')
    if (fs.existsSync(item.destination) && fs.readdirSync(item.destination).length && !state.entries.some(old => old.source === item.source)) throw new Error(`Refusing to overwrite unowned destination: ${item.destination}`)
  }
  }
  const { dlopen, read: memory } = await import('bun:ffi')
  const libc = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' }, __errno_location: { args: [], returns: 'ptr' } })
  const locks: number[] = []
  const lock = (file: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600)
    if (libc.symbols.flock(fd, 2) !== 0) { fs.closeSync(fd); throw new Error(`Storage lock failed: ${memory.i32(libc.symbols.__errno_location()!)}`) }
    locks.push(fd)
  }
  const rsync = async (item: Entry, checksum = false, verify = false): Promise<void> => {
    fs.mkdirSync(item.destination, { recursive: true })
    const args = ['-aHAXx', '--numeric-ids', '--delete', ...(checksum ? ['--checksum'] : []), ...(verify ? ['--dry-run', '--itemize-changes'] : []), item.source + '/', item.destination + '/']
    const child = Bun.spawn(['rsync', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0 || verify && out.trim()) throw new Error(`Persistent copy verification failed (${code}): ${item.source}${error ? ': ' + error.slice(-500) : ''}`)
  }
  const openFiles = (): string[] => {
    const found: string[] = []
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let fds: string[] = []; try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
      for (const fd of fds) try { const file = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); if (pending.some(item => file === item.source || file.startsWith(item.source + '/'))) found.push(file) } catch {}
    }
    return found
  }
  const matches = (unit: string, pattern: string): boolean => new Bun.Glob(pattern).match(unit)
  const patterns = [...new Set(declaration.paths.flatMap(item => item.units))]
  const health = async (): Promise<void> => {
    for (const url of [...new Set(declaration.paths.flatMap(item => item.healthChecks ?? []))]) {
      let healthy = false
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' }); await response.body?.cancel(); if (response.status >= 200 && response.status < 400) { healthy = true; break } } catch {}
        await Bun.sleep(1000)
      }
      if (!healthy) throw new Error(`Persistent storage health check failed: ${url}`)
    }
  }
  let activated = false
  let changing = false
  const restore = (): void => {
    if (state.fstab !== undefined) {
      const begin = '# BEGIN ts-cloud persistent storage'; const end = '# END ts-cloud persistent storage'
      const current = fs.readFileSync('/etc/fstab', 'utf8')
      const start = current.indexOf(begin); const finish = current.indexOf(end, start)
      const oldStart = state.fstab.indexOf(begin); const oldFinish = state.fstab.indexOf(end, oldStart)
      if (start >= 0) {
        if (finish < 0) throw new Error('Incomplete persistent fstab block during rollback')
        const originalBlock = oldStart >= 0 && oldFinish >= 0 ? state.fstab.slice(oldStart, oldFinish + end.length) : ''
        fs.writeFileSync('/etc/fstab', current.slice(0, start) + originalBlock + current.slice(finish + end.length))
      }
    }
    for (const [file, content] of Object.entries(state.dropins ?? {})) { if (content === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content) }
    try { run('systemctl', ['daemon-reload']) } catch { console.error('Rollback restored configuration; systemd reload needs retry') }
  }
  try {
    lock('/run/lock/ts-cloud-persistent-storage.lock')
    for (const file of [...new Set(declaration.locks ?? [])].sort()) lock(file)
    state = read(stateFile, { entries: [], stopped: [] })
    for (const old of state.entries) if (!entries.some(item => item.source === old.source && item.destination === old.destination)) throw new Error(`Refusing to remove active persistent placement: ${old.source}`)
    pending = entries.filter(item => !state.entries.some(old => old.source === item.source && old.verified))
    if (state.phase === 'complete' && !pending.length) { if (problems().length) throw new Error(problems().join('; ')); return { healthy: true } }
    activated = state.phase === 'active'
    validateSources()
    const bytes = Number(run('du', ['-scx', '--block-size=1', ...pending.map(item => item.source)]).trim().split('\n').at(-1)?.split(/\s+/)[0])
    const disk = fs.statfsSync(volume.mountPath)
    if (!Number.isFinite(bytes) || bytes + 1024 ** 3 > disk.bavail * disk.bsize) throw new Error('Insufficient volume capacity for persistent data')
    if (!activated) {
    state.fstab ??= fs.readFileSync('/etc/fstab', 'utf8'); state.dropins ??= {}
    changing = true
    state.entries = entries.map(item => state.entries.find(old => old.source === item.source) ?? item); state.phase = 'copying'; save(stateFile, state)
    for (const item of pending.filter(item => !mounted(item.source))) { console.log(`Online persistent copy: ${item.source}`); await rsync(item) }
    for (const file of [...new Set(declaration.deploymentLocks ?? [])].sort()) lock(file)
    const units = run('systemctl', ['list-units', '--all', '--plain', '--no-legend', '--no-pager']).split('\n').map(line => line.trim().split(/\s+/)).filter(parts => patterns.some(pattern => matches(parts[0], pattern)))
    const stillCurrent = (unit: string): boolean => {
      const instance = /^(.+)@([^/]+)\.service$/.exec(unit)
      if (instance && fs.existsSync(path.join(policy.webRoot, instance[1], 'releases'))) {
        const current = fs.realpathSync(path.join(policy.webRoot, instance[1], 'current'))
        return path.basename(current) === instance[2]
      }
      return units.some(parts => parts[0] === unit)
    }
    state.stopped = [...new Set([...state.stopped.filter(stillCurrent), ...units.filter(parts => parts[2] === 'active' || parts[2] === 'activating').map(parts => parts[0])])]
    state.phase = 'quiescing'; save(stateFile, state)
    if (state.stopped.length) run('systemctl', ['stop', ...state.stopped])
    const epoch = (unit: string): string => run('systemctl', ['show', unit, '--property=InvocationID,ExecMainStartTimestampMonotonic,ActiveEnterTimestampMonotonic'])
    const epochs = new Map(state.stopped.map(unit => [unit, epoch(unit)]))
    const assertQuiesced = (): void => {
      for (const [unit, before] of epochs) if (epoch(unit) !== before) throw new Error(`Persistent writer invocation changed during verification: ${unit}`)
      for (const unit of state.stopped) if (cp.spawnSync('systemctl', ['is-active', '--quiet', unit]).status === 0) throw new Error(`Persistent writer restarted during verification: ${unit}`)
      if (openFiles().length) throw new Error('Persistent files remain open after stopping declared writers')
    }
    assertQuiesced()
    for (const item of pending.filter(item => !mounted(item.source))) { console.log(`Final checksum verification: ${item.source}`); await rsync(item, true); assertQuiesced(); await rsync(item, true, true); assertQuiesced(); const saved = state.entries.find(old => old.source === item.source)!; saved.checksummedAt = new Date().toISOString(); saved.bytes = Number(run('du', ['-sx', '--block-size=1', item.source]).split(/\s+/)[0]); save(stateFile, state) }
    assertQuiesced()
    run('sync', [])
    fs.mkdirSync(alias, { recursive: true })
    if (!mounted(alias)) run('mount', ['--bind', '/', alias])
    run('mount', ['--make-private', alias])
    for (const item of pending) {
      const original = path.join(alias, item.source.slice(1))
      if (same(original, item.destination) || fs.statSync(original).dev !== fs.statSync('/').dev) throw new Error('Unsafe persistent recovery view')
      if (!mounted(item.source)) run('mount', ['--bind', item.destination, item.source])
      if (!same(item.source, item.destination)) throw new Error('Persistent bind identity mismatch')
      state.phase = 'switching'; save(stateFile, state)
    }
    const begin = '# BEGIN ts-cloud persistent storage'; const end = '# END ts-cloud persistent storage'
    const fstab = fs.readFileSync('/etc/fstab', 'utf8')
    const block = [begin, ...entries.map(item => `${item.destination} ${item.source} none bind,nofail,x-systemd.requires-mounts-for=${volume.mountPath} 0 0`), end].join('\n')
    const start = fstab.indexOf(begin); const finish = fstab.indexOf(end, start)
    if (start >= 0 && finish < 0) throw new Error('Incomplete persistent fstab block')
    fs.writeFileSync('/etc/fstab.persistent-new', start < 0 ? fstab.trimEnd() + '\n' + block + '\n' : fstab.slice(0, start) + block + fstab.slice(finish + end.length))
    fs.renameSync('/etc/fstab.persistent-new', '/etc/fstab')
    for (const item of declaration.paths) for (const pattern of item.units) {
      const unit = pattern.replace('@*.', '@.').replace('-*.', '-.')
      const directory = `/etc/systemd/system/${unit}.d`; fs.mkdirSync(directory, { recursive: true })
      const sources = declaration.paths.filter(other => other.units.includes(pattern)).map(other => other.path)
      const file = path.join(directory, 'ts-cloud-persistent-storage.conf')
      if (!(file in state.dropins!)) { state.dropins![file] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; save(stateFile, state) }
      fs.writeFileSync(file, `[Unit]\nRequiresMountsFor=${volume.mountPath} ${sources.join(' ')}\n`)
    }
    run('findmnt', ['--verify']); run('systemctl', ['daemon-reload'])
    state.phase = 'active'; save(stateFile, state); activated = true
    }
    if (problems().length) throw new Error(problems().join('; '))
    if (state.stopped.length) run('systemctl', ['start', ...state.stopped])
    await health()
    for (const unit of state.stopped) if (cp.spawnSync('systemctl', ['is-active', '--quiet', unit]).status !== 0) throw new Error(`Persistent writer did not recover: ${unit}`)
    fs.mkdirSync(alias, { recursive: true })
    if (!mounted(alias)) run('mount', ['--bind', '/', alias])
    run('mount', ['--make-private', alias])
    // All bytes were checksummed before activation. Only their redundant root
    // copies are reclaimed; live data and every backup remain on the volume.
    for (const item of pending) {
      if (!state.entries.some(old => old.source === item.source && old.checksummedAt)) throw new Error('Cannot reclaim an unverified root copy')
      if (!same(item.source, item.destination)) throw new Error('Persistent mount changed before reclamation')
      const original = path.join(alias, item.source.slice(1))
      if (same(original, item.destination) || fs.statSync(original).dev !== fs.statSync('/').dev) throw new Error('Unsafe persistent root reclamation')
      for (const name of fs.readdirSync(original)) fs.rmSync(path.join(original, name), { recursive: true, force: false })
    }
    for (const item of state.entries) item.verified = true
    state.phase = 'complete'; state.stopped = []; delete state.fstab; delete state.dropins; save(stateFile, state); run('sync', [])
    console.log(JSON.stringify({ healthy: true, entries, rootAvailableBytes: fs.statfsSync('/').bavail * fs.statfsSync('/').bsize }))
    if (mounted(alias)) run('umount', [alias])
    return { healthy: true }
  } catch (error) {
    // Never revert onto a stale root copy once writers have restarted.
    if (!activated && changing) {
      for (const item of [...pending].reverse()) if (mounted(item.source) && same(item.source, item.destination)) run('umount', [item.source])
      restore(); state.phase = 'copying'; save(stateFile, state)
      if (state.stopped.length) run('systemctl', ['start', ...state.stopped])
    }
    throw error
  } finally { for (const fd of locks.reverse()) { libc.symbols.flock(fd, 8); fs.closeSync(fd) } libc.close() }
}
