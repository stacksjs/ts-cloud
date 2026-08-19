export interface OperationConfirmation {
  operation: string
  confirm: string
  verb: string
  to?: string | null
  apiConfirm?: string
  danger?: boolean
  label?: string
  [key: string]: unknown
}

export interface OperationResult {
  output: string
  ok?: boolean
}

export type Signal<T> = (() => T) & { set: (value: T) => void }

interface HTMLElement {
  focus: () => void
  scrollIntoView: (options?: { behavior?: string; block?: string }) => void
}

type HTMLInputElement = HTMLElement

export interface OperationConfirmationController {
  opOutput: Signal<string>
  opShown: Signal<boolean>
  pending: Signal<OperationConfirmation | null>
  typed: Signal<string>
  busy: Signal<boolean>
  confirmTok: Signal<string>
  confirmVerb: Signal<string>
  confirmDanger: Signal<boolean>
  confirmLabel: Signal<string>
  canRun: Signal<boolean>
  askOp: (
    operation: string,
    confirm: string,
    verb: string,
    to?: string | null,
    apiConfirm?: string,
    options?: Partial<OperationConfirmation>,
  ) => void
  cancelOp: () => void
  runOp: () => Promise<void>
}

declare function state<T>(_value: T): Signal<T>
declare function derived<T>(_value: () => T): Signal<T>
declare function useRef<T = HTMLElement>(_name: string): { current: T | null }

const DANGEROUS_OPERATION = /(?:^|:)(?:delete|disable|destroy|purge|remove|restore|rollback|stop)(?::|$)/i

export function operationIsDangerous(operation: Pick<OperationConfirmation, 'operation' | 'danger'>): boolean {
  return operation.danger ?? DANGEROUS_OPERATION.test(operation.operation)
}

/**
 * One confirmation lifecycle for dashboard operations. The caller owns only
 * the API request; this composable owns staging, exact-token validation,
 * in-flight locking, focus, output, cancellation, and error presentation.
 */
export function useOpConfirm(
  execute: (operation: OperationConfirmation) => Promise<string | OperationResult>,
): OperationConfirmationController {
  const opOutput = state('')
  const opShown = state(false)
  const pending = state<OperationConfirmation | null>(null)
  const typed = state('')
  const busy = state(false)
  const confirmInput = useRef<HTMLInputElement>('opConfirmInput')
  const confirmTok = derived(() => pending()?.confirm ?? '')
  const confirmVerb = derived(() => pending()?.verb ?? '')
  const confirmDanger = derived(() => (pending() ? operationIsDangerous(pending()!) : false))
  const confirmLabel = derived(() => pending()?.label ?? (confirmDanger() ? 'Confirm operation' : 'Run operation'))
  const canRun = derived(() => !!pending() && !busy() && typed() === pending()!.confirm)

  function askOp(
    operation: string,
    confirm: string,
    verb: string,
    to?: string | null,
    apiConfirm?: string,
    options: Partial<OperationConfirmation> = {},
  ) {
    pending.set({ ...options, operation, confirm, verb, to: to ?? null, apiConfirm: apiConfirm || confirm })
    typed.set('')
    confirmInput.current?.focus()
    confirmInput.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function cancelOp() {
    if (busy()) return
    pending.set(null)
    typed.set('')
  }

  async function runOp() {
    const operation = pending()
    if (!operation || busy() || typed() !== operation.confirm) return
    busy.set(true)
    opShown.set(true)
    opOutput.set(`Running ${operation.operation}...`)
    try {
      const result = await execute(operation)
      opOutput.set(typeof result === 'string' ? result : result.output)
      pending.set(null)
      typed.set('')
    } catch (error) {
      opOutput.set(`FAILED ${operation.operation}\n\n${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy.set(false)
    }
  }

  return {
    opOutput,
    opShown,
    pending,
    typed,
    busy,
    confirmTok,
    confirmVerb,
    confirmDanger,
    confirmLabel,
    canRun,
    askOp,
    cancelOp,
    runOp,
  }
}
