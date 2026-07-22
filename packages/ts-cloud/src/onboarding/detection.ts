import type { BuildStrategy, DetectionCandidate, DetectionEvidence, DetectionFile } from './types'

function fileMap(files: DetectionFile[]): Map<string, DetectionFile> {
  return new Map(files.map(file => [file.path.replace(/^\.\//, '').replace(/\\/g, '/'), file]))
}

function evidence(path: string, reason: string, weight: number): DetectionEvidence { return { path, reason, weight } }

function packageJson(file?: DetectionFile): Record<string, any> {
  try { return file?.content ? JSON.parse(file.content) as Record<string, any> : {} }
  catch { return {} }
}

function candidate(framework: DetectionCandidate['framework'], strategy: BuildStrategy['kind'], confidence: number, evidenceValues: DetectionEvidence[], build: BuildStrategy, description: string): DetectionCandidate {
  const target = strategy === 'static' ? 'serverless' : strategy === 'serverless' ? 'serverless' : strategy === 'dockerfile' || strategy === 'prebuilt_image' ? 'container' : 'server'
  return { framework, strategy, confidence, evidence: evidenceValues, defaults: { build, runtime: { target, architecture: 'x86_64', port: strategy === 'static' || strategy === 'serverless' ? undefined : 3000, healthCheck: strategy === 'static' ? undefined : { protocol: 'http', path: '/health' } } }, description }
}

/** Pure, bounded detection over caller-provided file metadata/content. */
export function detectApplication(files: DetectionFile[]): DetectionCandidate[] {
  const byPath = fileMap(files.slice(0, 10_000))
  const results: DetectionCandidate[] = []
  if (byPath.has('Dockerfile')) results.push(candidate('dockerfile', 'dockerfile', 0.99, [evidence('Dockerfile', 'A root Dockerfile defines an explicit reproducible build.', 1)], { kind: 'dockerfile', context: '.', dockerfile: 'Dockerfile' }, 'Build the repository with its Dockerfile and run the resulting OCI image.'))
  const composer = packageJson(byPath.get('composer.json'))
  if (byPath.has('artisan') && composer.require?.['laravel/framework']) results.push(candidate('laravel', 'server', 0.98, [evidence('artisan', 'Laravel Artisan entrypoint is present.', .45), evidence('composer.json', 'Requires laravel/framework.', .55)], { kind: 'server', runtime: 'php', runtimeVersion: '8.3', installCommand: 'composer install --no-dev --prefer-dist --optimize-autoloader', buildCommand: 'php artisan config:cache && php artisan route:cache && php artisan view:cache', startCommand: 'php artisan serve --host=0.0.0.0 --port=$PORT' }, 'Install a production Composer tree, warm Laravel caches, and run the HTTP application.'))
  else if (byPath.has('composer.json')) results.push(candidate('php', 'server', 0.82, [evidence('composer.json', 'Composer metadata identifies a PHP application.', .8)], { kind: 'server', runtime: 'php', runtimeVersion: '8.3', installCommand: 'composer install --no-dev --prefer-dist --optimize-autoloader', startCommand: 'php -S 0.0.0.0:$PORT -t public' }, 'Install Composer dependencies and run the configured PHP document root.'))
  const pkg = packageJson(byPath.get('package.json'))
  if (byPath.has('package.json')) {
    const isBun = byPath.has('bun.lock') || byPath.has('bun.lockb') || pkg.engines?.bun
    const runtime = isBun ? 'bun' : 'node'
    const framework = isBun ? 'bun' : 'node'
    const ev = [evidence('package.json', `Defines ${pkg.scripts?.build ? 'build and ' : ''}${pkg.scripts?.start ? 'start ' : ''}scripts.`, .55)]
    if (isBun) ev.push(evidence(byPath.has('bun.lock') ? 'bun.lock' : byPath.has('bun.lockb') ? 'bun.lockb' : 'package.json', 'Pins the Bun package manager/runtime.', .35))
    const staticFramework = !!(pkg.dependencies?.vite || pkg.devDependencies?.vite || pkg.dependencies?.['@stacksjs/bunpress'] || pkg.devDependencies?.['@stacksjs/bunpress']) && !pkg.scripts?.start
    const build: BuildStrategy = staticFramework
      ? { kind: 'static', installCommand: `${runtime} install --frozen-lockfile`, buildCommand: `${runtime} run build`, publishDirectory: 'dist' }
      : { kind: 'server', runtime, installCommand: `${runtime} install --frozen-lockfile`, buildCommand: pkg.scripts?.build ? `${runtime} run build` : undefined, startCommand: pkg.scripts?.start ? `${runtime} run start` : runtime === 'bun' ? 'bun run index.ts' : 'node index.js' }
    results.push(candidate(framework, build.kind, Math.min(.94, ev.reduce((sum, item) => sum + item.weight, 0)), ev, build, staticFramework ? 'Install dependencies, build static assets, and publish the output directory.' : `Install dependencies, build if configured, and start the ${runtime} server.`))
  }
  if (!results.length && (byPath.has('index.html') || byPath.has('public/index.html'))) results.push(candidate('static', 'static', 0.78, [evidence(byPath.has('index.html') ? 'index.html' : 'public/index.html', 'A static HTML entrypoint is present.', .78)], { kind: 'static', publishDirectory: byPath.has('index.html') ? '.' : 'public' }, 'Publish the static directory without a runtime process.'))
  if (!results.length) results.push(candidate('unknown', 'buildpack', 0.2, [], { kind: 'buildpack', runtime: 'node' }, 'No supported framework signature was conclusive; choose commands and runtime manually.'))
  return results.sort((left, right) => right.confidence - left.confidence || left.framework.localeCompare(right.framework))
}
