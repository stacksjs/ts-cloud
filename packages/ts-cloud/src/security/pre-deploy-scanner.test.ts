import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreDeployScanner } from './pre-deploy-scanner'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-secret-scan-'))
  temporaryDirectories.push(directory)
  writeFileSync(join(directory, name), content)
  return directory
}

describe('pre-deployment secret scanning', () => {
  it('does not classify SHA-1 manifest digests as generic AWS secrets', async () => {
    const directory = fixture(
      'source-manifest.json',
      JSON.stringify({
        source: 'bf1a3cf74d9e81052b670ea3988d05653d1af1a2',
        lock: 'c60ee280874d77e9ce121835535a98565a23578a',
      }),
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('still detects a named AWS secret even when its value is hexadecimal', async () => {
    const directory = fixture(
      'config.json',
      JSON.stringify({
        aws_secret_access_key: 'bf1a3cf74d9e81052b670ea3988d05653d1af1a2',
      }),
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(false)
    expect(result.findings.some(finding => finding.pattern.name === 'AWS Secret Access Key')).toBe(true)
  })

  it('does not classify a 40-character TypeScript identifier as a generic AWS secret', async () => {
    const directory = fixture(
      'routes.ts',
      'const handler = ActionResourceDeploymentConfigurationNam\n',
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('does not classify a 40-character action module path as a generic AWS secret', async () => {
    const directory = fixture(
      'routes.ts',
      "route.post('/checkout', 'Actions/Payment/CreateSubscriptionAction')\n",
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('does not classify mixed-case framework paths as generic AWS secrets', async () => {
    const directory = fixture(
      'features.ts',
      [
        "const path = 'resources/components/Dashboard/Commerce/'",
        'const contract = "getAuthUrl/getAccessToken/getUserByToken"',
      ].join('\n'),
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('does not scan generated framework backup trees', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-secret-scan-'))
    temporaryDirectories.push(directory)
    const backupDirectory = join(directory, 'storage/framework/framework.bak/framework.bak')
    mkdirSync(backupDirectory, { recursive: true })
    writeFileSync(join(backupDirectory, 'config.ts'), 'const value = "aB3dE5fG7hI9jK/lMnOpQrStUvWxYz0123456789"\n')
    writeFileSync(join(directory, 'app.ts'), 'export const app = true\n')

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(true)
    expect(result.scannedFiles).toBe(1)
    expect(result.findings).toEqual([])
  })

  it('still detects diverse unlabelled AWS-secret-shaped material', async () => {
    const directory = fixture(
      'config.ts',
      'const credential = "aB3dE5fG7hI9jK/lMnOpQrStUvWxYz0123456789"\n',
    )

    const result = await new PreDeployScanner().scan({
      directory,
      failOnSeverity: 'high',
    })

    expect(result.passed).toBe(false)
    expect(result.findings.some(finding => finding.pattern.name === 'AWS Secret Key (Generic)')).toBe(true)
  })
})

describe('scan exclusions', () => {
  function projectWithVendoredSecret(): string {
    const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-secret-scan-'))
    temporaryDirectories.push(directory)
    // Own code: clean.
    writeFileSync(join(directory, 'index.ts'), 'export const greeting = "hello"\n')
    // A vendored submodule's test fixture that trips the AWS key heuristic.
    // This is the real shape: TypeScript's compiler baselines contain
    // identifiers long enough to look like a generic secret, and nothing the
    // project does to its own code makes them go away.
    const vendored = join(directory, '_submodules', 'typescript-go', 'testdata')
    mkdirSync(vendored, { recursive: true })
    writeFileSync(join(vendored, 'baseline.js'), 'export var publicVarWithPrivateModulePropertyTypes1 = exporter.x()\n')
    return directory
  }

  it('flags the vendored fixture by default, which is the problem being solved', async () => {
    const scanner = new PreDeployScanner()
    const result = await scanner.scan({ directory: projectWithVendoredSecret() })

    expect(result.findings.some((f) => f.file.includes('_submodules'))).toBe(true)
  })

  it('leaves an excluded directory out of the walk entirely', async () => {
    const directory = projectWithVendoredSecret()
    const scanner = new PreDeployScanner()

    const withoutExclusion = await scanner.scan({ directory })
    const withExclusion = await scanner.scan({ directory, exclude: ['_submodules'] })

    expect(withExclusion.scannedFiles).toBeLessThan(withoutExclusion.scannedFiles)
    expect(withExclusion.findings.some((f) => f.file.includes('_submodules'))).toBe(false)
  })

  it('does not let an exclusion hide a secret in the project own code', async () => {
    const directory = projectWithVendoredSecret()
    writeFileSync(join(directory, 'leak.ts'), 'const token = "ghp_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12"\n')

    const scanner = new PreDeployScanner()
    const result = await scanner.scan({ directory, exclude: ['_submodules'] })

    expect(result.findings.some((f) => f.file.includes('leak.ts'))).toBe(true)
  })
})
