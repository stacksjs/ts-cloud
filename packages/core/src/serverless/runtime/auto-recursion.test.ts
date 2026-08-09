import type { ApiGatewayProxyEventV2 } from './adapter'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHttpHandler } from './adapter'
import {
  checkInvocation,
  installRecursionFetch,
  invocationContext,
  resetRecursionRuntime,
  resolveRecursionConfig,
  withInvocation,
} from './auto-recursion'
import { CHAIN_HEADER, DEPTH_HEADER, functionFingerprint, TRACE_HEADER } from './recursion'

const ENV_KEYS = ['TS_CLOUD_RECURSION_PROTECTION', 'TS_CLOUD_RECURSION_DETECTION_ONLY', 'TS_CLOUD_FUNCTION_ID']

beforeEach(() => {
  resetRecursionRuntime()
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.TS_CLOUD_FUNCTION_ID = 'fn-a'
})

afterEach(() => {
  resetRecursionRuntime()
  for (const key of ENV_KEYS) delete process.env[key]
})

function event(headers: Record<string, string> = {}): ApiGatewayProxyEventV2 {
  return {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    headers,
    requestContext: { http: { method: 'GET', path: '/' }, domainName: 'app.test' },
  } as unknown as ApiGatewayProxyEventV2
}

function deepChain(length: number): string {
  return Array.from({ length }, (_, index) => functionFingerprint(`fn-${index}`)).join('.')
}

describe('configuration', () => {
  it('is on by default, because a protection you must enable protects nobody', () => {
    expect(resolveRecursionConfig()).toMatchObject({ enabled: true, detectionOnly: false })
  })

  it('can be turned off by config or by environment', () => {
    expect(resolveRecursionConfig(false).enabled).toBe(false)
    expect(resolveRecursionConfig({ enabled: false }).enabled).toBe(false)
    process.env.TS_CLOUD_RECURSION_PROTECTION = '0'
    expect(resolveRecursionConfig().enabled).toBe(false)
  })

  it('lets the environment override config, so an incident needs no redeploy', () => {
    process.env.TS_CLOUD_RECURSION_PROTECTION = '0'
    expect(resolveRecursionConfig({ enabled: true }).enabled).toBe(false)
    process.env.TS_CLOUD_RECURSION_DETECTION_ONLY = 'true'
    expect(resolveRecursionConfig({ detectionOnly: false }).detectionOnly).toBe(true)
  })

  it('names the function from the environment when nothing is configured', () => {
    process.env.TS_CLOUD_FUNCTION_ID = 'orders-http'
    expect(resolveRecursionConfig().functionId).toBe('orders-http')
  })
})

describe('automatic inspection', () => {
  it('allows an ordinary invocation and hands back a chain', () => {
    const check = checkInvocation({})
    expect(check?.blocked).toBe(false)
    expect(check?.verdict.chain).toEqual([functionFingerprint('fn-a')])
  })

  it('blocks a loop without the application doing anything', () => {
    const check = checkInvocation({ [CHAIN_HEADER]: deepChain(12) })
    expect(check?.blocked).toBe(true)
    expect(check?.verdict.reason).toBe('depth_exceeded')
  })

  it('observes instead of blocking in detection-only mode', () => {
    const check = checkInvocation({ [CHAIN_HEADER]: deepChain(12) }, { detectionOnly: true })
    expect(check?.blocked).toBe(false)
    expect(check?.observed).toBe(true)
  })

  it('returns nothing at all when disabled, so no work is done', () => {
    expect(checkInvocation({ [CHAIN_HEADER]: deepChain(12) }, false)).toBeUndefined()
  })

  it('shares one guard across invocations, so the breaker can actually count', () => {
    const looping = { [CHAIN_HEADER]: deepChain(12) }
    for (let index = 0; index < 5; index++) checkInvocation(looping)
    // A fresh guard per invocation would reset the count and never open.
    const check = checkInvocation({})
    expect(check?.verdict.reason).toBe('breaker_open')
  })
})

describe('outbound propagation', () => {
  it('attaches the chain to an outbound fetch', async () => {
    const seen: Headers[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, init: any) => {
      seen.push(new Headers(init?.headers))
      return new Response('ok')
    }) as typeof fetch
    try {
      const check = checkInvocation({})!
      await withInvocation(check.verdict, async () => {
        await fetch('https://downstream.test/')
      })
    } finally {
      globalThis.fetch = original
    }
    expect(seen[0].get(CHAIN_HEADER)).toBe(functionFingerprint('fn-a'))
    expect(seen[0].get(DEPTH_HEADER)).toBe('1')
    expect(seen[0].get(TRACE_HEADER)).toBeTruthy()
  })

  it('preserves the caller headers it is adding to', async () => {
    const seen: Headers[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, init: any) => {
      seen.push(new Headers(init?.headers))
      return new Response('ok')
    }) as typeof fetch
    try {
      const check = checkInvocation({})!
      await withInvocation(check.verdict, async () => {
        await fetch('https://downstream.test/', { headers: { authorization: 'Bearer x' } })
      })
    } finally {
      globalThis.fetch = original
    }
    expect(seen[0].get('authorization')).toBe('Bearer x')
    expect(seen[0].get(CHAIN_HEADER)).toBeTruthy()
  })

  it('leaves fetch alone outside an invocation', async () => {
    const seen: Headers[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, init: any) => {
      seen.push(new Headers(init?.headers))
      return new Response('ok')
    }) as typeof fetch
    try {
      installRecursionFetch()
      await fetch('https://downstream.test/')
    } finally {
      globalThis.fetch = original
    }
    expect(seen[0].get(CHAIN_HEADER)).toBeNull()
  })

  it('does not stack wrappers when installed twice', () => {
    const original = globalThis.fetch
    try {
      installRecursionFetch()
      const first = globalThis.fetch
      installRecursionFetch()
      // A second wrapper would append the chain entry twice per hop.
      expect(globalThis.fetch).toBe(first)
    } finally {
      globalThis.fetch = original
      resetRecursionRuntime()
    }
  })

  it('keeps one invocation chain out of another running concurrently', async () => {
    const seen: Record<string, string | null> = {}
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init: any) => {
      seen[String(input)] = new Headers(init?.headers).get(TRACE_HEADER)
      return new Response('ok')
    }) as typeof fetch
    try {
      const a = checkInvocation({ [TRACE_HEADER]: 'trace-a' })!
      const b = checkInvocation({ [TRACE_HEADER]: 'trace-b' })!
      await Promise.all([
        withInvocation(a.verdict, async () => {
          await Bun.sleep(5)
          await fetch('https://a.test/')
        }),
        withInvocation(b.verdict, async () => {
          await fetch('https://b.test/')
        }),
      ])
    } finally {
      globalThis.fetch = original
    }
    expect(seen['https://a.test/']).toBe('trace-a')
    expect(seen['https://b.test/']).toBe('trace-b')
  })
})

describe('the HTTP handler applies it without any application change', () => {
  it('serves an ordinary request', async () => {
    const handler = createHttpHandler(async () => new Response('hello'))
    const result = await handler(event())
    expect(result.statusCode).toBe(200)
    expect(result.body).toBe('hello')
  })

  it('refuses a looping request with a 508 before the handler runs', async () => {
    let ran = false
    const handler = createHttpHandler(async () => {
      ran = true
      return new Response('hello')
    })
    const result = await handler(event({ [CHAIN_HEADER]: deepChain(12) }))
    expect(result.statusCode).toBe(508)
    expect(ran).toBe(false)
    expect(JSON.parse(String(result.body))).toMatchObject({ error: 'recursion_blocked' })
    expect(result.headers?.['retry-after']).toBe('60')
  })

  it('runs the handler inside the invocation context, so its fetch is tagged', async () => {
    const seen: Headers[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, init: any) => {
      seen.push(new Headers(init?.headers))
      return new Response('ok')
    }) as typeof fetch
    try {
      const handler = createHttpHandler(async () => {
        await fetch('https://downstream.test/')
        return new Response('hello')
      })
      await handler(event())
    } finally {
      globalThis.fetch = original
    }
    expect(seen[0].get(CHAIN_HEADER)).toBe(functionFingerprint('fn-a'))
  })

  it('lets a loop through but logs it in detection-only mode', async () => {
    let ran = false
    const handler = createHttpHandler(
      async () => {
        ran = true
        return new Response('hello')
      },
      { recursionProtection: { detectionOnly: true } },
    )
    const result = await handler(event({ [CHAIN_HEADER]: deepChain(12) }))
    expect(result.statusCode).toBe(200)
    expect(ran).toBe(true)
  })

  it('can be switched off entirely', async () => {
    const handler = createHttpHandler(async () => new Response('hello'), { recursionProtection: false })
    expect((await handler(event({ [CHAIN_HEADER]: deepChain(12) }))).statusCode).toBe(200)
  })

  it('answers maintenance before recursion, so a parked app stays parked', async () => {
    const handler = createHttpHandler(async () => new Response('hello'), {
      maintenance: { enabled: true },
    })
    const result = await handler(event({ [CHAIN_HEADER]: deepChain(12) }))
    expect(result.statusCode).toBe(503)
  })

  it('leaves warmer pings untouched', async () => {
    const handler = createHttpHandler(async () => new Response('hello'))
    const result = await handler({ warmer: true } as unknown as ApiGatewayProxyEventV2)
    expect(result.body).toBe('warm')
  })

  it('does not leak the invocation context past the response', async () => {
    const handler = createHttpHandler(async () => new Response('hello'))
    await handler(event())
    expect(invocationContext.getStore()).toBeUndefined()
  })
})
