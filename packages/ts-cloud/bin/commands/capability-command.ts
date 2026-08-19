import * as cli from '../../src/utils/cli'

export interface UnsupportedCommandResult {
  ok: false
  code: 'unsupported_capability'
  exitCode: 2
  command: string
  provider?: string
  target?: string
  retryable: false
  nextAction: string
  message: string
}
export function unsupportedCommand(
  command: string,
  input: {
    provider?: string
    target?: string
    nextAction?: string
    message?: string
    setProcessExitCode?: boolean
  } = {},
): UnsupportedCommandResult {
  const result: UnsupportedCommandResult = {
    ok: false,
    code: 'unsupported_capability',
    exitCode: 2,
    command,
    provider: input.provider,
    target: input.target,
    retryable: false,
    nextAction: input.nextAction ?? 'Run `cloud capabilities` and choose a supported driver operation.',
    message: input.message ?? `${command} is not supported by the selected provider driver.`,
  }
  cli.error(`${result.message} ${result.nextAction}`)
  if (input.setProcessExitCode !== false) process.exitCode = result.exitCode
  return result
}
