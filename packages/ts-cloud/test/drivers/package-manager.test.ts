import { describe, expect, it } from 'bun:test'
import {
  buildPantryBootstrapScript,
  buildPantryInstallScript,
  buildPantryServiceScript,
  PANTRY_INSTALL_DIR,
  PANTRY_PACKAGES,
  PANTRY_PROJECT_DIR,
  pantryDomain,
  pantryEnvActivation,
} from '../../src/drivers/shared/package-manager'

describe('buildPantryBootstrapScript', () => {
  it('installs the pantry CLI headlessly in system service scope', () => {
    const script = buildPantryBootstrapScript().join('\n')
    expect(script).toContain('export PANTRY_SERVICE_SCOPE=system')
    expect(script).toContain(`export PANTRY_INSTALL_DIR=${PANTRY_INSTALL_DIR}`)
    // The pantry.dev pipe installer is dead (404s) — the CLI comes from its
    // GitHub release zip, platform-detected on the box.
    expect(script).toContain('https://github.com/home-lang/pantry/releases/')
    expect(script).toContain('pantry-${OS}-${ARCH}.zip')
    // Idempotent: skip when pantry already present.
    expect(script).toContain('command -v pantry >/dev/null 2>&1 ||')
    // curl + unzip are the only apt prerequisites.
    expect(script).toContain('apt-get install -y curl ca-certificates')
    expect(script).toContain('apt-get install -y unzip')
    expect(script).toContain(`mkdir -p ${PANTRY_PROJECT_DIR}`)
  })

  it('defaults to the latest release but can pin a version', () => {
    expect(buildPantryBootstrapScript().join('\n')).toContain('PANTRY_VERSION:-latest')
    const pinned = buildPantryBootstrapScript({ version: '0.9.39' }).join('\n')
    expect(pinned).toContain('export PANTRY_VERSION=\'0.9.39\'')
  })
})

describe('buildPantryInstallScript', () => {
  it('resolves all packages in a single project-scoped pass', () => {
    const script = buildPantryInstallScript(['php.net', 'nginx.org', 'getcomposer.org'])
    expect(script).toEqual([`(cd ${PANTRY_PROJECT_DIR} && pantry install 'php.net' 'nginx.org' 'getcomposer.org')`])
  })

  it('supports pinned versions and dedupes', () => {
    const script = buildPantryInstallScript(['php.net@8.3', 'php.net@8.3', 'redis.io']).join('\n')
    expect(script).toContain('\'php.net@8.3\'')
    expect(script).toContain('\'redis.io\'')
    // Deduped: php.net@8.3 appears once.
    expect(script.match(/php\.net@8\.3/g)?.length).toBe(1)
  })

  it('returns nothing for an empty list', () => {
    expect(buildPantryInstallScript([])).toEqual([])
  })
})

describe('buildPantryServiceScript', () => {
  it('starts then enables each service in the project', () => {
    expect(buildPantryServiceScript(['php-fpm', 'nginx'])).toEqual([
      `(cd ${PANTRY_PROJECT_DIR} && pantry start 'php-fpm')`,
      `(cd ${PANTRY_PROJECT_DIR} && pantry enable 'php-fpm')`,
      `(cd ${PANTRY_PROJECT_DIR} && pantry start 'nginx')`,
      `(cd ${PANTRY_PROJECT_DIR} && pantry enable 'nginx')`,
    ])
  })
})

describe('pantryEnvActivation', () => {
  it('activates the project env from the project dir', () => {
    expect(pantryEnvActivation()).toBe(`eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)" || true`)
  })
})

describe('pantryDomain', () => {
  it('maps logical keys to package domains', () => {
    expect(pantryDomain('php')).toBe('php.net')
    expect(pantryDomain('redis')).toBe('redis.io')
    expect(PANTRY_PACKAGES.meilisearch).toBe('meilisearch.com')
  })

  it('passes an explicit domain through unchanged', () => {
    expect(pantryDomain('nginx.org')).toBe('nginx.org')
  })
})
