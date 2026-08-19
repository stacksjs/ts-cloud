import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkReleaseContent } from './release-content'

const made: string[] = []

function tree(spec: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'release-content-'))
  made.push(root)
  for (const [path, contents] of Object.entries(spec)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

function emptyDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'release-content-'))
  made.push(root)
  return root
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true })
})

const check = (root: string, expectIndex = true): ReturnType<typeof checkReleaseContent> =>
  checkReleaseContent({ root, siteName: 'main', expectIndex })

describe('checkReleaseContent', () => {
  it('passes a static site with an index at the top', () => {
    const root = tree({ 'index.html': '<h1>hi</h1>', 'guide/index.html': 'g' })

    expect(check(root)).toEqual([])
  })

  it('errors when the root does not exist', () => {
    const issues = check(join(emptyDir(), 'missing'))

    expect(issues).toHaveLength(1)
    expect(issues[0]!.level).toBe('error')
    expect(issues[0]!.message).toContain('Build output not found')
  })

  it('errors when the root is a file', () => {
    const root = tree({ 'out.html': 'x' })

    const issues = check(join(root, 'out.html'))

    expect(issues[0]!.level).toBe('error')
    expect(issues[0]!.message).toContain('not a directory')
  })

  it('errors on a root that would ship an empty release', () => {
    const issues = check(emptyDir())

    expect(issues[0]!.level).toBe('error')
    expect(issues[0]!.message).toContain('empty release')
  })

  it('treats a root holding only junk files as empty', () => {
    const root = tree({ '.DS_Store': '', 'nested/.gitkeep': '' })

    expect(check(root)[0]!.message).toContain('empty release')
  })

  it('names the subdirectory when the generator wrote one level down', () => {
    // The BunPress shape: `--outdir dist/docs` renders into dist/docs/.bunpress.
    const root = tree({ '.bunpress/index.html': 'x', '.bunpress/guide/index.html': 'y' })

    const issues = check(root)

    expect(issues).toHaveLength(1)
    expect(issues[0]!.level).toBe('error')
    expect(issues[0]!.message).toContain('one level down')
    expect(issues[0]!.message).toContain(`Set root: '${root}/.bunpress'`)
  })

  it('warns rather than guessing when several subdirectories have an index', () => {
    const root = tree({ 'b/index.html': 'y', 'a/index.html': 'x' })

    const issues = check(root)

    expect(issues[0]!.level).toBe('warning')
    expect(issues[0]!.message).toContain('a, b')
  })

  it('warns when a static site has no index anywhere', () => {
    const root = tree({ 'styles.css': 'body{}' })

    const issues = check(root)

    expect(issues[0]!.level).toBe('warning')
    expect(issues[0]!.message).toContain('no index.html anywhere')
  })

  it('does not ask an app site for an index', () => {
    const root = tree({ 'server.ts': 'export default {}' })

    expect(check(root, false)).toEqual([])
  })

  it('still catches an empty root for an app site', () => {
    expect(check(emptyDir(), false)[0]!.message).toContain('empty release')
  })
})
