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

/**
 * Build the shell commands that clone + checkout the repository into the
 * release directory. Assumes `git` is installed (the bootstrap installs it).
 */
export function buildGitCheckoutScript(options: GitCheckoutOptions): string[] {
  const { repository, releaseDir, commit } = options
  const branch = repository.branch || DEFAULT_DEPLOY_BRANCH
  const url = repository.url

  const lines: string[] = [
    `rm -rf ${releaseDir}`,
    `mkdir -p ${releaseDir}`,
  ]

  if (commit) {
    // Reproducible deploy of an exact commit: init + fetch just that commit.
    lines.push(
      `git -C ${releaseDir} init -q`,
      `git -C ${releaseDir} remote add origin ${url}`,
      `git -C ${releaseDir} fetch -q --depth 1 origin ${commit}`,
      `git -C ${releaseDir} checkout -q FETCH_HEAD`,
    )
  }
  else {
    lines.push(
      `git clone -q --depth 1 --branch ${branch} ${url} ${releaseDir}`,
    )
  }

  // Record the deployed SHA for traceability / rollback.
  lines.push(
    `git -C ${releaseDir} rev-parse HEAD > ${releaseDir}/.ts-cloud-sha`,
  )

  return lines
}
