/**
 * The global `--profile` and `--region` flags.
 *
 * They were declared on the CLI and read by nothing, so `cloud cdn:status <id>
 * --profile prod` parsed and then used whatever credentials happened to be in
 * the environment. Most commands build AWS clients without a profile, so the
 * flags reach them through the environment instead.
 */

interface CommandLike {
  options: Array<{ name: string, description: string }>
}

/**
 * Apply the global AWS flags to `env` before the matched command runs.
 *
 * An explicit `--profile` wins over keys already in the environment, which are
 * often loaded from a `.env` file, as the AWS CLI's `--profile` does and as
 * src/aws/credentials.ts documents for an explicit profile. Without that, the
 * environment keys would silently be used instead of the profile asked for.
 *
 * A command that declares its own non-AWS `--profile` (ssh:preflight's
 * `raspberry-pi` / `generic`) keeps the flag to itself. A command that declares
 * its own `--region` already reads it, often with a `us-east-1` default that
 * clapp fills in even when the flag was not passed, so it is left alone rather
 * than written over AWS_REGION.
 */
export function applyGlobalAwsOptions(
  options: Record<string, unknown>,
  command: CommandLike | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const own = command?.options.find(option => option.name === 'profile')
  const profileIsAws = !own || /\baws\b/i.test(own.description)

  if (profileIsAws && typeof options.profile === 'string' && options.profile) {
    env.AWS_PROFILE = options.profile
    delete env.AWS_ACCESS_KEY_ID
    delete env.AWS_SECRET_ACCESS_KEY
    delete env.AWS_SESSION_TOKEN
  }

  const ownRegion = command?.options.some(option => option.name === 'region')
  if (!ownRegion && typeof options.region === 'string' && options.region) {
    env.AWS_REGION = options.region
    env.AWS_DEFAULT_REGION = options.region
  }
}
