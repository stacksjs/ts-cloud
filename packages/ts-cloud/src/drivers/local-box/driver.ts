import type { CloudDriver, ComputeStackOutputs, ComputeTarget, FindComputeTargetsOptions, RemoteDeployResult, RunRemoteDeployOptions, UploadReleaseOptions, UploadReleaseResult } from '@ts-cloud/core'

/**
 * A {@link CloudDriver} that runs every "remote" command on the LOCAL machine.
 *
 * Used when the management dashboard runs ON a provisioned server (box mode):
 * data resolution and operations execute against localhost via `bash` instead of
 * SSH/SSM, so the existing dashboard code path — metrics scripts, service ops,
 * rollbacks — works unchanged on the box itself. The single synthetic target is
 * the box; provisioning/upload methods are inert (the box is already up).
 */
export class LocalBoxDriver implements CloudDriver {
  // Label only — the dashboard uses runRemoteDeploy/findComputeTargets directly
  // and never branches on the provider name for a local box.
  readonly name = 'hetzner' as const
  readonly usesCloudFormation = false

  async getComputeOutputs(): Promise<ComputeStackOutputs> {
    return { appPublicIp: '127.0.0.1', sshUser: 'root' }
  }

  async uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult> {
    // Already local — the deploy script reads the path directly.
    return { artifactRef: options.localPath }
  }

  async findComputeTargets(options: FindComputeTargetsOptions): Promise<ComputeTarget[]> {
    // A local box IS the app box — there is no separate lb/services box on the
    // machine. Answer only app-role queries so role-specific callers (e.g. the
    // rpx fleet-LB gateway reload, which first looks for 'lb' targets) don't
    // mistake localhost for a dedicated load balancer.
    if ((options.role || 'app') !== 'app') return []
    return [{ id: 'localhost', name: 'localhost', publicIp: '127.0.0.1', status: 'running' }]
  }

  async runRemoteDeploy(options: RunRemoteDeployOptions): Promise<RemoteDeployResult> {
    const script = options.commands.join('\n')
    try {
      const proc = Bun.spawn(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe', env: process.env })
      const [output, error, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return {
        success: exitCode === 0,
        instanceCount: 1,
        perInstance: [{ instanceId: 'localhost', status: exitCode === 0 ? 'Success' : 'Failed', output, error }],
      }
    } catch (err: any) {
      return {
        success: false,
        instanceCount: 1,
        perInstance: [{ instanceId: 'localhost', status: 'Failed', error: err?.message ?? String(err) }],
        error: err?.message ?? String(err),
      }
    }
  }
}

/** Truthy-env check shared by the box-mode gate. */
export function isBoxMode(): boolean {
  const v = process.env.TS_CLOUD_DASHBOARD_BOX
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}
