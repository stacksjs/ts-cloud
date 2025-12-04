#!/usr/bin/env bun
/**
 * Test script to run the IMAP server locally
 * This reads emails from S3 and serves them via IMAP
 *
 * Usage:
 *   bun run src/aws/test-imap.ts
 *
 * Then configure Mail.app:
 *   IMAP Server: localhost
 *   Port: 1143 (or 143 if running as root)
 *   Username: chris
 *   Password: test123
 */

import { startImapServer } from './imap-server'

async function main() {
  console.log('Starting IMAP-to-S3 bridge server...')
  console.log('')

  const port = Number.parseInt(process.env.IMAP_PORT || '1143', 10)
  const sslPort = Number.parseInt(process.env.IMAPS_PORT || '1993', 10)

  const server = await startImapServer({
    port, // Use 1143 for non-root, or 143 if running as root
    sslPort, // Use 1993 for non-root, or 993 if running as root
    host: '0.0.0.0',
    region: 'us-east-1',
    bucket: 'stacks-production-email',
    prefix: 'incoming/',
    domain: 'stacksjs.com',
    users: {
      chris: {
        password: 'test123',
        email: 'chris@stacksjs.com',
      },
      blake: {
        password: 'test123',
        email: 'blake@stacksjs.com',
      },
      glenn: {
        password: 'test123',
        email: 'glenn@stacksjs.com',
      },
    },
    // To enable TLS, provide certificate paths:
    // tls: {
    //   key: '/path/to/key.pem',
    //   cert: '/path/to/cert.pem',
    // },
  })

  console.log('')
  console.log('='.repeat(60))
  console.log('IMAP-to-S3 Bridge Server Running')
  console.log('='.repeat(60))
  console.log('')
  console.log('Mail.app Settings:')
  console.log('  Account Type:    IMAP')
  console.log('  Incoming Server: localhost')
  console.log(`  Port:            ${port}`)
  console.log('  Username:        chris (or blake, glenn)')
  console.log('  Password:        test123')
  console.log(`  SSL:             Off (or ${sslPort} with SSL)`)
  console.log('')
  console.log('For production, use ports 143/993 (requires root or port forwarding)')
  console.log('Set IMAP_PORT and IMAPS_PORT environment variables to change ports')
  console.log('')
  console.log('Press Ctrl+C to stop')

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await server.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...')
    await server.stop()
    process.exit(0)
  })
}

main().catch(console.error)
