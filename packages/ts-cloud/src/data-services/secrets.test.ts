import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { EncryptedDataSecretStore } from './secrets'

describe('encrypted data-service secret store', () => {
  it('persists only authenticated ciphertext and removes references', async () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }),
      secrets = new EncryptedDataSecretStore(
        controlPlane,
        'dashboard-encryption-key',
      ),
      reference = 'secret://data-services/project/orders/app'
    await secrets.put(reference, 'not-in-the-database')
    expect(await secrets.resolve(reference)).toBe('not-in-the-database')
    expect(
      Buffer.from(controlPlane.database.serialize()).toString(),
    ).not.toContain('not-in-the-database')
    await expect(
      new EncryptedDataSecretStore(controlPlane, 'wrong-key').resolve(
        reference,
      ),
    ).rejects.toThrow('could not be decrypted')
    await secrets.remove(reference)
    await expect(secrets.resolve(reference)).rejects.toThrow('was not found')
    controlPlane.close()
  })
})
