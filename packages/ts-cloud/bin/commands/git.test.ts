import { describe, expect, it } from 'bun:test'
import { inferSourceRepository } from './git'

describe('Git command repository inference', () => {
  it('defaults owner/name input to GitHub', () => {
    expect(inferSourceRepository('acme/web')).toEqual({ provider: 'github', host: 'https://github.com', fullName: 'acme/web', cloneUrl: undefined })
  })

  it('recognizes hosted HTTPS clone URLs', () => {
    expect(inferSourceRepository('https://gitlab.com/acme/web.git')).toEqual({ provider: 'gitlab', host: 'https://gitlab.com', fullName: 'acme/web', cloneUrl: 'https://gitlab.com/acme/web.git' })
  })

  it('recognizes generic SSH clone URLs and explicit providers', () => {
    expect(inferSourceRepository('git@git.example:acme/web.git')).toEqual({ provider: 'generic_ssh', host: 'https://git.example', fullName: 'acme/web', cloneUrl: 'git@git.example:acme/web.git' })
    expect(inferSourceRepository('acme/web', { provider: 'gitea', host: 'https://code.example' })).toMatchObject({ provider: 'gitea', host: 'https://code.example' })
  })

  it('rejects ambiguous or malformed repository names', () => {
    expect(() => inferSourceRepository('acme')).toThrow('owner/name')
    expect(() => inferSourceRepository('https://github.com/acme/web/extra')).toThrow('owner/name')
    expect(() => inferSourceRepository('acme/web', { provider: 'unknown' as any })).toThrow('Unsupported Git provider')
  })
})
