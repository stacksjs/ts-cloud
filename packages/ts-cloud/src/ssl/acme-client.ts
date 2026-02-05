/**
 * ACME Client for Let's Encrypt
 * Implements RFC 8555 (ACME Protocol) for certificate issuance
 *
 * This is a pure TypeScript/Bun implementation without external dependencies.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

// ACME Directory URLs
export const ACME_DIRECTORIES = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const

export interface AcmeClientOptions {
  /**
   * Use staging server for testing
   * @default false
   */
  staging?: boolean

  /**
   * Account email for Let's Encrypt notifications
   */
  email: string

  /**
   * Account key in PEM format (optional, will be generated if not provided)
   */
  accountKey?: string
}

export interface AcmeChallenge {
  type: 'http-01' | 'dns-01'
  token: string
  keyAuthorization: string
  /**
   * For HTTP-01: URL path to serve the challenge
   * For DNS-01: TXT record name
   */
  identifier: string
  /**
   * For DNS-01: The value to put in the TXT record
   */
  dnsValue?: string
}

export interface AcmeCertificate {
  certificate: string
  privateKey: string
  chain: string
  fullchain: string
  expiresAt: Date
}

interface AcmeDirectory {
  newNonce: string
  newAccount: string
  newOrder: string
  revokeCert: string
  keyChange: string
}

/**
 * ACME Client for Let's Encrypt certificate management
 */
export class AcmeClient {
  private directoryUrl: string
  private email: string
  private accountKey: string
  private accountUrl: string | null = null
  private directory: AcmeDirectory | null = null
  private nonce: string | null = null

  constructor(options: AcmeClientOptions) {
    this.directoryUrl = options.staging
      ? ACME_DIRECTORIES.staging
      : ACME_DIRECTORIES.production
    this.email = options.email
    this.accountKey = options.accountKey || this.generateAccountKey()
  }

  /**
   * Generate a new account key pair
   */
  private generateAccountKey(): string {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    })
    return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  }

  /**
   * Get the ACME directory
   */
  private async getDirectory(): Promise<AcmeDirectory> {
    if (this.directory) return this.directory

    const response = await fetch(this.directoryUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch ACME directory: ${response.status}`)
    }

    this.directory = await response.json() as AcmeDirectory
    return this.directory
  }

  /**
   * Get a fresh nonce for requests
   */
  private async getNonce(): Promise<string> {
    if (this.nonce) {
      const nonce = this.nonce
      this.nonce = null
      return nonce
    }

    const directory = await this.getDirectory()
    const response = await fetch(directory.newNonce, { method: 'HEAD' })
    const nonce = response.headers.get('replay-nonce')

    if (!nonce) {
      throw new Error('Failed to get nonce from ACME server')
    }

    return nonce
  }

  /**
   * Create JWK from account key
   */
  private getJwk(): Record<string, string> {
    // Parse the EC private key to extract public key components
    const keyLines = this.accountKey.split('\n')
      .filter(line => !line.startsWith('-----'))
      .join('')

    // For EC P-256, we need to extract x and y coordinates
    // This is a simplified version - in production you'd use a proper ASN.1 parser
    const keyBuffer = Buffer.from(keyLines, 'base64')

    // EC public key is the last 65 bytes (04 || x || y for uncompressed point)
    // For P-256: 32 bytes for x, 32 bytes for y
    const publicKeyStart = keyBuffer.length - 65
    const x = keyBuffer.subarray(publicKeyStart + 1, publicKeyStart + 33)
    const y = keyBuffer.subarray(publicKeyStart + 33, publicKeyStart + 65)

    return {
      kty: 'EC',
      crv: 'P-256',
      x: this.base64UrlEncode(x),
      y: this.base64UrlEncode(y),
    }
  }

  /**
   * Calculate JWK thumbprint
   */
  private getJwkThumbprint(): string {
    const jwk = this.getJwk()
    // Canonical JSON for EC key
    const canonical = JSON.stringify({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    })

    const hash = createHash('sha256').update(canonical).digest()
    return this.base64UrlEncode(hash)
  }

  /**
   * Base64URL encode
   */
  private base64UrlEncode(data: Buffer | string): string {
    const buffer = typeof data === 'string' ? Buffer.from(data) : data
    return buffer.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  /**
   * Sign a payload for ACME request
   */
  private async signPayload(url: string, payload: any): Promise<string> {
    const nonce = await this.getNonce()
    const jwk = this.getJwk()

    const protectedHeader: Record<string, any> = {
      alg: 'ES256',
      nonce,
      url,
    }

    // Use kid if we have an account URL, otherwise use jwk
    if (this.accountUrl) {
      protectedHeader.kid = this.accountUrl
    } else {
      protectedHeader.jwk = jwk
    }

    const protectedB64 = this.base64UrlEncode(JSON.stringify(protectedHeader))
    const payloadB64 = payload === ''
      ? ''
      : this.base64UrlEncode(JSON.stringify(payload))

    const signatureInput = `${protectedB64}.${payloadB64}`

    const sign = createSign('SHA256')
    sign.update(signatureInput)
    const signature = sign.sign(this.accountKey)

    // Convert DER signature to raw r||s format for ES256
    const r = signature.subarray(4, 4 + signature[3])
    const sStart = 4 + signature[3] + 2
    const s = signature.subarray(sStart, sStart + signature[sStart - 1])

    // Pad r and s to 32 bytes
    const rPadded = Buffer.alloc(32)
    const sPadded = Buffer.alloc(32)
    r.copy(rPadded, 32 - r.length)
    s.copy(sPadded, 32 - s.length)

    const rawSignature = Buffer.concat([rPadded, sPadded])

    return JSON.stringify({
      protected: protectedB64,
      payload: payloadB64,
      signature: this.base64UrlEncode(rawSignature),
    })
  }

  /**
   * Make a signed ACME request
   */
  private async acmeRequest(url: string, payload: any): Promise<{ body: any; headers: Headers }> {
    const body = await this.signPayload(url, payload)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/jose+json',
      },
      body,
    })

    // Store the new nonce for the next request
    const newNonce = response.headers.get('replay-nonce')
    if (newNonce) {
      this.nonce = newNonce
    }

    let responseBody: any
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json') || contentType?.includes('application/problem+json')) {
      responseBody = await response.json()
    } else {
      responseBody = await response.text()
    }

    if (!response.ok) {
      throw new Error(`ACME request failed: ${JSON.stringify(responseBody)}`)
    }

    return { body: responseBody, headers: response.headers }
  }

  /**
   * Register or get existing account
   */
  async registerAccount(): Promise<string> {
    const directory = await this.getDirectory()

    const { body, headers } = await this.acmeRequest(directory.newAccount, {
      termsOfServiceAgreed: true,
      contact: [`mailto:${this.email}`],
    })

    const location = headers.get('location')
    if (!location) {
      throw new Error('No account URL returned')
    }

    this.accountUrl = location
    return location
  }

  /**
   * Create a new certificate order
   */
  async createOrder(domains: string[]): Promise<{
    orderUrl: string
    authorizations: string[]
    finalize: string
  }> {
    if (!this.accountUrl) {
      await this.registerAccount()
    }

    const directory = await this.getDirectory()

    const { body, headers } = await this.acmeRequest(directory.newOrder, {
      identifiers: domains.map(domain => ({
        type: 'dns',
        value: domain,
      })),
    })

    const orderUrl = headers.get('location')
    if (!orderUrl) {
      throw new Error('No order URL returned')
    }

    return {
      orderUrl,
      authorizations: body.authorizations,
      finalize: body.finalize,
    }
  }

  /**
   * Get authorization challenges
   */
  async getAuthorization(authUrl: string): Promise<{
    domain: string
    challenges: AcmeChallenge[]
  }> {
    const { body } = await this.acmeRequest(authUrl, '')

    const domain = body.identifier.value
    const thumbprint = this.getJwkThumbprint()

    const challenges: AcmeChallenge[] = body.challenges
      .filter((c: any) => c.type === 'http-01' || c.type === 'dns-01')
      .map((c: any) => {
        const keyAuthorization = `${c.token}.${thumbprint}`

        if (c.type === 'http-01') {
          return {
            type: 'http-01' as const,
            token: c.token,
            keyAuthorization,
            identifier: `/.well-known/acme-challenge/${c.token}`,
          }
        } else {
          // DNS-01: TXT record value is base64url(sha256(keyAuthorization))
          const dnsValue = this.base64UrlEncode(
            createHash('sha256').update(keyAuthorization).digest()
          )
          return {
            type: 'dns-01' as const,
            token: c.token,
            keyAuthorization,
            identifier: `_acme-challenge.${domain}`,
            dnsValue,
          }
        }
      })

    return { domain, challenges }
  }

  /**
   * Respond to a challenge (tell ACME server we're ready)
   */
  async respondToChallenge(challengeUrl: string): Promise<void> {
    await this.acmeRequest(challengeUrl, {})
  }

  /**
   * Poll for authorization status
   */
  async waitForAuthorization(authUrl: string, maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const { body } = await this.acmeRequest(authUrl, '')

      if (body.status === 'valid') {
        return
      }

      if (body.status === 'invalid') {
        throw new Error(`Authorization failed: ${JSON.stringify(body)}`)
      }

      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error('Authorization timed out')
  }

  /**
   * Generate a CSR (Certificate Signing Request)
   */
  private generateCsr(domains: string[]): { csr: string; privateKey: string } {
    // Generate a new key pair for the certificate
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })

    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

    // For a proper CSR, we'd need to use a library like node-forge
    // This is a simplified placeholder - in production, use proper CSR generation
    // For now, we'll create a minimal CSR structure

    // The CSR needs proper ASN.1 encoding with the domains in Subject Alternative Names
    // This requires either a native module or a library like node-forge

    // Placeholder: In a real implementation, generate proper CSR
    const csrPlaceholder = this.createSimpleCsr(domains, privateKey as any)

    return {
      csr: csrPlaceholder,
      privateKey: privateKeyPem,
    }
  }

  /**
   * Create a simple CSR (placeholder - would need proper implementation)
   */
  private createSimpleCsr(domains: string[], privateKey: any): string {
    // This is a placeholder. A real implementation would:
    // 1. Create proper ASN.1 structure for CSR
    // 2. Include Subject Alternative Names for all domains
    // 3. Sign with the private key

    // For production, use a library like @peculiar/x509 or node-forge
    throw new Error(
      'CSR generation requires additional implementation. ' +
      'Consider using the shell-based certbot approach instead.'
    )
  }

  /**
   * Finalize the order and get the certificate
   */
  async finalizeOrder(finalizeUrl: string, domains: string[]): Promise<AcmeCertificate> {
    const { csr, privateKey } = this.generateCsr(domains)

    const { body } = await this.acmeRequest(finalizeUrl, {
      csr: this.base64UrlEncode(Buffer.from(csr, 'base64')),
    })

    // Poll for certificate
    let certificateUrl = body.certificate
    if (!certificateUrl) {
      // Need to poll the order
      throw new Error('Certificate not immediately available - polling not implemented')
    }

    // Download certificate
    const certResponse = await fetch(certificateUrl)
    const fullchain = await certResponse.text()

    // Split fullchain into certificate and chain
    const certs = fullchain.split(/(?=-----BEGIN CERTIFICATE-----)/g)
    const certificate = certs[0]
    const chain = certs.slice(1).join('')

    return {
      certificate,
      privateKey,
      chain,
      fullchain,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
    }
  }

  /**
   * Get the account key (for storage/reuse)
   */
  getAccountKey(): string {
    return this.accountKey
  }
}
