import { describe, expect, it } from 'bun:test'
import {
  describeCredentialReach,
  formatCredentialReach,
  unrelatedReachCount,
} from '../../src/deploy/attach-credentials'
import { TS_CLOUD_LABEL_PREFIX } from '../../src/drivers/hetzner/instance-sizes'

const PROJECT_LABEL = `${TS_CLOUD_LABEL_PREFIX}/project`

/** A server as a driver's `listServers()` returns it, labelled or not. */
function server(name: string, project?: string) {
  return project === undefined ? { name } : { name, labels: { [PROJECT_LABEL]: project } }
}

/** The fleet from the issue: one Hetzner project, five boxes. */
const fleet = [
  server('statushq-production-app', 'statushq'),
  server('bughq-production-app', 'bughq'),
  server('loghq-production-app', 'loghq'),
  server('stacks-production-app', 'stacks'),
  server('localtunnels-production-app', 'localtunnels'),
]

describe('describeCredentialReach', () => {
  it('separates the owner, this project, unrelated projects and unmanaged boxes', () => {
    const reach = describeCredentialReach(
      [...fleet, server('someones-database')],
      { ownerSlug: 'statushq', selfSlug: 'loghq' },
    )

    expect(reach.total).toBe(6)
    expect(reach.owner).toEqual(['statushq-production-app'])
    expect(reach.self).toEqual(['loghq-production-app'])
    expect([...reach.others.keys()].sort()).toEqual(['bughq', 'localtunnels', 'stacks'])
    expect(reach.unmanaged).toEqual(['someones-database'])
  })

  it('groups several servers under one project', () => {
    const reach = describeCredentialReach(
      [server('bughq-production-app', 'bughq'), server('bughq-production-lb', 'bughq')],
      { ownerSlug: 'statushq', selfSlug: 'loghq' },
    )

    expect(reach.others.get('bughq')).toEqual(['bughq-production-app', 'bughq-production-lb'])
  })

  it("treats this project's own boxes as unrelated when no selfSlug is given", () => {
    const reach = describeCredentialReach([server('loghq-production-app', 'loghq')], { ownerSlug: 'statushq' })

    expect(reach.self).toEqual([])
    expect(reach.others.get('loghq')).toEqual(['loghq-production-app'])
  })

  it('counts a blank project label as unmanaged rather than as a project named ""', () => {
    const reach = describeCredentialReach(
      [{ name: 'odd-box', labels: { [PROJECT_LABEL]: '   ' } }],
      { ownerSlug: 'statushq' },
    )

    expect(reach.unmanaged).toEqual(['odd-box'])
    expect(reach.others.size).toBe(0)
  })

  it('reports nothing reachable for an empty listing', () => {
    const reach = describeCredentialReach([], { ownerSlug: 'statushq', selfSlug: 'loghq' })

    expect(reach.total).toBe(0)
    expect(unrelatedReachCount(reach)).toBe(0)
  })
})

describe('unrelatedReachCount', () => {
  it('counts every server neither joined project owns', () => {
    const reach = describeCredentialReach([...fleet, server('someones-database')], {
      ownerSlug: 'statushq',
      selfSlug: 'loghq',
    })

    // bughq + stacks + localtunnels + the unlabelled box.
    expect(unrelatedReachCount(reach)).toBe(4)
  })
})

describe('formatCredentialReach', () => {
  it('says so in one line when only the two joined projects are reachable', () => {
    const reach = describeCredentialReach(
      [server('statushq-production-app', 'statushq'), server('loghq-production-app', 'loghq')],
      { ownerSlug: 'statushq', selfSlug: 'loghq' },
    )

    const lines = formatCredentialReach(reach, { ownerSlug: 'statushq', selfSlug: 'loghq' })

    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Nothing outside the two projects')
  })

  it('names every unrelated project and box, sorted so the plan is diffable', () => {
    const reach = describeCredentialReach([...fleet, server('someones-database')], {
      ownerSlug: 'statushq',
      selfSlug: 'loghq',
    })

    const lines = formatCredentialReach(reach, { ownerSlug: 'statushq', selfSlug: 'loghq' })
    const body = lines.join('\n')

    expect(lines[0]).toContain('all 6 server(s)')
    expect(body).toContain('4 of them belong to neither project')
    expect(body).toContain('bughq: bughq-production-app')
    expect(body).toContain('localtunnels: localtunnels-production-app')
    expect(body).toContain('stacks: stacks-production-app')
    expect(body).toContain('not managed by ts-cloud: someones-database')

    // The unrelated projects appear in sorted order.
    expect(body.indexOf('bughq:')).toBeLessThan(body.indexOf('localtunnels:'))
    expect(body.indexOf('localtunnels:')).toBeLessThan(body.indexOf('stacks:'))
  })

  it('states the isolation tradeoff, since that is the decision being made', () => {
    const reach = describeCredentialReach(fleet, { ownerSlug: 'statushq', selfSlug: 'loghq' })

    expect(formatCredentialReach(reach, { ownerSlug: 'statushq', selfSlug: 'loghq' }).join('\n'))
      .toContain('own provider project')
  })

  it('is stable across runs for the same input', () => {
    const reach = describeCredentialReach([...fleet].reverse(), { ownerSlug: 'statushq', selfSlug: 'loghq' })
    const a = formatCredentialReach(reach, { ownerSlug: 'statushq', selfSlug: 'loghq' })
    const b = formatCredentialReach(reach, { ownerSlug: 'statushq', selfSlug: 'loghq' })

    expect(a).toEqual(b)
  })
})
