/**
 * Server "recipes" — reusable bash scripts run on demand across one or more
 * provisioned servers, as a chosen user (Forge's Recipes feature). The driver
 * fans a recipe out over the target servers (SSH/SSM); this module builds the
 * single wrapped script that runs on each box: it sets a strict shell, runs the
 * recipe body as the requested user with a login shell (so PATH/pantry env are
 * loaded), and prints clear begin/end markers + the exit code so captured
 * output is easy to scan.
 */

export interface ServerRecipeOptions {
  /** Recipe name (shown in the output markers). */
  name: string
  /** The recipe body — bash command lines run on the server. */
  script: string[]
  /**
   * User to run the recipe as. Defaults to `root`. A non-root user is invoked
   * via `runuser -l` so it gets a login shell (profile + PATH, incl. pantry).
   */
  user?: string
}

/** Single-quote a value for safe embedding in the generated shell. */
function sq(value: string): string {
  return `'${value.split('\'').join('\'\\\'\'')}'`
}

/**
 * Build the wrapped recipe script run on a server. The body is written to a
 * temp file and executed as `user`; the wrapper captures the exit code and
 * prints `__TS_CLOUD_RECIPE_*__` markers around the run for the driver to parse.
 */
export function buildServerRecipeScript(options: ServerRecipeOptions): string[] {
  const user = options.user || 'root'
  const body = options.script.join('\n')
  // Run the recipe file through a LOGIN shell so /etc/profile.d (pantry, bun, …)
  // is sourced. As root: `bash -l <file>`. As another user: `runuser -l` (login)
  // running the same — the outer shell expands $TS_CLOUD_RECIPE into the string.
  const runLine = user === 'root'
    ? 'bash -l "$TS_CLOUD_RECIPE"'
    : `runuser -l ${sq(user)} -c "bash $TS_CLOUD_RECIPE"`
  return [
    'set -uo pipefail',
    `echo "__TS_CLOUD_RECIPE_BEGIN__ ${options.name} (user=${user})"`,
    // Write the body to a temp file so quoting/heredocs inside it are preserved,
    // then run it through a login shell as the target user.
    'TS_CLOUD_RECIPE=$(mktemp)',
    `cat > "$TS_CLOUD_RECIPE" <<'TS_CLOUD_RECIPE_EOF'`,
    body,
    'TS_CLOUD_RECIPE_EOF',
    'chmod +r "$TS_CLOUD_RECIPE"',
    runLine,
    'TS_CLOUD_RC=$?',
    'rm -f "$TS_CLOUD_RECIPE"',
    `echo "__TS_CLOUD_RECIPE_END__ ${options.name} exit=$TS_CLOUD_RC"`,
    'exit $TS_CLOUD_RC',
  ]
}
