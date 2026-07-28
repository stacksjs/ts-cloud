import { describe, expect, it } from 'bun:test'
import { parseUsersFile } from './dashboard-users'

describe('dashboard user store', () => {
  it('ignores legacy identities with usernames the authentication store rejects', () => {
    const users = parseUsersFile(
      JSON.stringify({
        users: [
          {
            username: 'admin',
            passwordHash: 'valid-hash',
            role: 'admin',
            sites: {},
          },
          {
            username: 'legacy@example',
            passwordHash: 'legacy-hash',
            role: 'admin',
            sites: {},
          },
        ],
      }),
    )

    expect(users).toHaveLength(1)
    expect(users[0]?.username).toBe('admin')
  })
})
