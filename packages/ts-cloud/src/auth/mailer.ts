import type { CloudConfig } from '@ts-cloud/core'

export interface AuthenticationEmail {
  to: string
  subject: string
  text: string
  html?: string
}

/** Deliver authentication mail through ts-cloud's existing SES client. */
export async function sendAuthenticationEmail(config: CloudConfig, message: AuthenticationEmail): Promise<boolean> {
  const from = config.notifications?.email?.from
  if (!from)
    return false
  try {
    const { EmailClient } = await import('../aws/email')
    const email = new EmailClient({ region: config.project.region, defaultFrom: from })
    await email.send(message)
    return true
  }
  catch {
    return false
  }
}
