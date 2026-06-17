import { describe, expect, it } from 'bun:test'
import { buildServerRecipeScript } from '../../src/drivers/shared/server-recipes'

describe('buildServerRecipeScript', () => {
  it('wraps the body in a login shell as root with begin/end markers', () => {
    const s = buildServerRecipeScript({ name: 'clear-cache', script: ['php artisan cache:clear', 'echo done'] }).join('\n')
    expect(s).toContain('__TS_CLOUD_RECIPE_BEGIN__ clear-cache (user=root)')
    expect(s).toContain('php artisan cache:clear')
    expect(s).toContain('bash -l "$TS_CLOUD_RECIPE"')
    expect(s).toContain('__TS_CLOUD_RECIPE_END__ clear-cache exit=$TS_CLOUD_RC')
    expect(s).toContain('exit $TS_CLOUD_RC')
  })

  it('runs as a non-root user via a login shell', () => {
    const s = buildServerRecipeScript({ name: 'deploy', script: ['whoami'], user: 'www-data' }).join('\n')
    expect(s).toContain('(user=www-data)')
    expect(s).toContain('runuser -l \'www-data\' -c "bash $TS_CLOUD_RECIPE"')
  })

  it('preserves the body verbatim (heredocs/quotes) via a temp file', () => {
    const s = buildServerRecipeScript({ name: 'r', script: ['cat > /tmp/x <<\'EOF\'', 'literal $VAR', 'EOF'] }).join('\n')
    expect(s).toContain('literal $VAR')
    expect(s).toContain('TS_CLOUD_RECIPE=$(mktemp)')
  })
})
