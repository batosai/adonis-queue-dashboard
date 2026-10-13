import type { RedactionConfig } from '../types.js'

const sensitiveKeys = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credentials',
]

export class Redactor {
  readonly showPayload: boolean
  #config: RedactionConfig
  #keys: string[]
  constructor(config: RedactionConfig = {}) {
    this.#config = config
    this.showPayload = config.showPayload ?? false
    this.#keys = [...sensitiveKeys, ...(config.sensitiveKeys ?? [])].map((key) =>
      key.toLowerCase().replace(/[^a-z0-9]/g, ''),
    )
  }
  text(value: string): string {
    // The default hides error text entirely: arbitrary messages can contain bare secrets.
    if (!this.#config.redactText) return '[Hidden: configure redactText to display error messages]'
    return this.#config.redactText(value).slice(0, this.#config.maxStringLength ?? 2000)
  }
  payload(value: unknown): unknown {
    let entries = 0
    const seen = new WeakSet<object>()
    const walk = (input: unknown, depth: number): unknown => {
      if (++entries > (this.#config.maxEntries ?? 200)) return '[Truncated]'
      if (depth > (this.#config.maxDepth ?? 5)) return '[Truncated]'
      if (typeof input === 'string') return this.text(input)
      if (input === null || typeof input === 'number' || typeof input === 'boolean') return input
      if (typeof input !== 'object') return null
      if (seen.has(input)) return '[Circular]'
      seen.add(input)
      if (Array.isArray(input))
        return input.slice(0, this.#config.maxEntries ?? 200).map((entry) => walk(entry, depth + 1))
      const out: Record<string, unknown> = Object.create(null)
      for (const [key, entry] of Object.entries(input)) {
        if (entries >= (this.#config.maxEntries ?? 200)) break
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
        out[key] = this.#keys.some((sensitive) => normalized.includes(sensitive))
          ? '[Redacted]'
          : walk(entry, depth + 1)
      }
      return out
    }
    return walk(value, 0)
  }
}
