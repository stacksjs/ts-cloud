/**
 * Forge-style git-clone-on-server deploys: the box clones the site's repository
 * into a fresh release directory rather than receiving a tarball over SCP.
 *
 * The clone is shallow (`--depth 1`) on the configured branch for speed. When a
 * specific commit is requested, it is fetched and checked out so deploys are
 * reproducible. The resolved commit SHA is written to `<release>/.ts-cloud-sha`
 * so later steps (and rollbacks) can identify the release.
 */
import type { SiteRepositoryConfig } from '@ts-cloud/core'

export interface GitCheckoutOptions {
  /** Repository to clone. */
  repository: SiteRepositoryConfig
  /** Absolute release directory to clone into (`<base>/releases/<id>`). */
  releaseDir: string
  /**
   * Specific commit to deploy. When omitted, the branch tip is used (Forge's
   * push-to-deploy behaviour).
   */
  commit?: string
}

/** Default branch when the repository config omits one. */
export const DEFAULT_DEPLOY_BRANCH = 'main'

/** Default tag glob when `strategy: 'tag'` and no explicit tag is set. */
export const DEFAULT_TAG_PATTERN = 'v*'

/**
 * Build the shell commands that clone + checkout the repository into the
 * release directory. Assumes `git` is installed (the bootstrap installs it).
 *
 * Strategy is taken from `repository.strategy`:
 *  - `'push'` (default) — clone the branch tip (or a pinned `commit`).
 *  - `'tag'` — clone a version tag: the explicit `repository.tag`, else the
 *    highest tag matching `repository.tagPattern`, resolved on the box via
 *    `git ls-remote --sort=-v:refname`.
 */
export function buildGitCheckoutScript(options: GitCheckoutOptions): string[] {
  const { repository, releaseDir, commit } = options
  const branch = repository.branch || DEFAULT_DEPLOY_BRANCH
  const url = repository.url

  const lines: string[] = [`rm -rf ${releaseDir}`, `mkdir -p ${releaseDir}`]

  if (repository.strategy === 'tag') {
    if (repository.tag) {
      // git clone --branch accepts a tag name as well as a branch.
      lines.push(`git clone -q --depth 1 --branch ${shellQuote(repository.tag)} ${shellQuote(url)} ${releaseDir}`)
      lines.push(`printf '%s' ${shellQuote(repository.tag)} > ${releaseDir}/.ts-cloud-tag`)
    } else {
      const pattern = repository.tagPattern || DEFAULT_TAG_PATTERN
      // Resolve the highest version tag matching the pattern on the remote, then
      // shallow-clone exactly that tag. `-v:refname` sorts semver-ish names.
      lines.push(
        `TS_CLOUD_TAG="$(git ls-remote --tags --refs --sort=-v:refname ${shellQuote(url)} ${shellQuote(`refs/tags/${pattern}`)} | head -n1 | sed 's#.*refs/tags/##')"`,
        `test -n "$TS_CLOUD_TAG" || { echo "no tags matching" ${shellQuote(pattern)} "found in" ${shellQuote(url)} >&2; exit 1; }`,
        `git clone -q --depth 1 --branch "$TS_CLOUD_TAG" ${shellQuote(url)} ${releaseDir}`,
        `printf '%s' "$TS_CLOUD_TAG" > ${releaseDir}/.ts-cloud-tag`,
      )
    }
  } else if (commit) {
    // Reproducible deploy of an exact commit: init + fetch just that commit.
    lines.push(
      `git -C ${releaseDir} init -q`,
      `git -C ${releaseDir} remote add origin ${shellQuote(url)}`,
      `git -C ${releaseDir} fetch -q --depth 1 origin ${shellQuote(commit)}`,
      `git -C ${releaseDir} checkout -q FETCH_HEAD`,
    )
  } else {
    lines.push(`git clone -q --depth 1 --branch ${shellQuote(branch)} ${shellQuote(url)} ${releaseDir}`)
  }

  // Record the deployed SHA for traceability / rollback.
  lines.push(`git -C ${releaseDir} rev-parse HEAD > ${releaseDir}/.ts-cloud-sha`)

  return lines
}

/** Single-quote a value for safe embedding in the generated shell. */
function shellQuote(value: string): string {
  const escaped = value.split("'").join("'\\''")
  return `'${escaped}'`
}
