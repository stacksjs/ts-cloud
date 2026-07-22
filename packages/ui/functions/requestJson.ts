export class DashboardRequestError extends Error {
  constructor(message: string, public status: number, public payload?: unknown) {
    super(message)
    this.name = 'DashboardRequestError'
  }
}

/** Parse JSON when available while retaining useful text from proxy/HTML errors. */
export async function requestJson<T extends Record<string, unknown> = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text) {
    try { payload = JSON.parse(text) as Record<string, unknown> }
    catch { payload = { error: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) } }
  }
  if (!response.ok || payload.ok === false) {
    const message = typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : `Request failed with HTTP ${response.status}.`
    throw new DashboardRequestError(message, response.status, payload)
  }
  return payload as T
}
