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
