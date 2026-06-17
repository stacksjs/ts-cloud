import { describe, expect, it } from 'bun:test'
import { generateAppImageDockerfile } from './app-image'

describe('generateAppImageDockerfile', () => {
  it('builds a Node image from the Lambda Node base', () => {
    const df = generateAppImageDockerfile({ kind: 'node', nodeMajor: '20' })
    expect(df).toContain('FROM public.ecr.aws/lambda/nodejs:20')
    expect(df).toContain('COPY app/')
  })

  it('builds a multi-stage PHP image (runtime build + provided base)', () => {
    const df = generateAppImageDockerfile({ kind: 'php', phpVersion: '8.3' })
    expect(df).toContain('AS phpbuild')
    expect(df).toContain('FROM public.ecr.aws/lambda/provided:al2023')
    expect(df).toContain('COPY --from=phpbuild /opt/ /opt/')
    expect(df).toContain('COPY runtime/ /opt/')
    expect(df).toContain('ENTRYPOINT [ "/opt/bootstrap" ]')
    expect(df).toContain('php83-php-fpm')
  })
})
