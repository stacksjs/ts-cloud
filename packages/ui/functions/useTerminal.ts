export type Signal<T> = (() => T) & { set: (value: T) => void }

interface HTMLElement {
  scrollTop: number
  scrollHeight: number
}

declare const location: { protocol: string; host: string }
declare function state<T>(_value: T): Signal<T>
declare function derived<T>(_value: () => T): Signal<T>
declare function effect(_callback: () => void): void
declare function useRef<T = HTMLElement>(_name: string): { current: T | null }
declare function useWebSocket(
  _url: string,
  _options?: Record<string, unknown>,
): {
  status: Signal<'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED'>
  send: (data: string) => void
  close: () => void
  connect: () => void
}

export interface TerminalController {
  buf: Signal<string>
  cmd: Signal<string>
  status: Signal<string>
  send: () => void
  reconnect: () => void
  clearOut: () => void
  statusTone: (value: string) => 'ok' | 'bad' | 'warn'
}

/** Terminal transport and viewport behavior, isolated from the stx template. */
export function useTerminal(path: string = '/api/terminal'): TerminalController {
  const buf = state('')
  const cmd = state('')
  const output = useRef<HTMLElement>('terminalOutput')
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${location.host}${path}`
  const socket = useWebSocket(url, {
    reconnect: true,
    maxReconnects: 10,
    reconnectDelay: 1000,
    onMessage(data: unknown) {
      buf.set((buf() + String(data)).slice(-40000))
    },
  })
  const status = derived(
    () =>
      ({ CONNECTING: 'connecting', OPEN: 'connected', CLOSING: 'disconnecting', CLOSED: 'disconnected' })[
        socket.status()
      ] || 'error',
  )

  effect(() => {
    buf()
    const element = output.current
    if (element) element.scrollTop = element.scrollHeight
  })

  function send() {
    const command = cmd()
    if (!command.trim() || socket.status() !== 'OPEN') return
    socket.send(command + '\n')
    cmd.set('')
  }
  function reconnect() {
    socket.close()
    buf.set('')
    socket.connect()
  }
  function clearOut() {
    buf.set('')
  }
  function statusTone(value: string): 'ok' | 'bad' | 'warn' {
    return value === 'connected' ? 'ok' : value === 'disconnected' || value === 'error' ? 'bad' : 'warn'
  }
  return { buf, cmd, status, send, reconnect, clearOut, statusTone }
}
