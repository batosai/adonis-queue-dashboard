import type { DashboardConfig, ResolvedConfig } from './types.js'
import { hasControlCharacters } from './validation.js'

export function defineConfig(config: DashboardConfig): ResolvedConfig {
  const maxPageSize = config.maxPageSize ?? 50
  const pollIntervalMs = config.pollIntervalMs ?? 5000
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 100) {
    throw new Error('maxPageSize must be between 1 and 100')
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) {
    throw new Error('pollIntervalMs must be between 1000 and 60000')
  }
  if (config.redaction?.showPayload && !config.redaction.redactText) {
    throw new Error('Enabling payloads requires a redactText callback for sensitive values')
  }
  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (
      !name ||
      name.length > 255 ||
      !['redis', 'database', 'sync'].includes(adapter.source.driver)
    ) {
      throw new Error('Invalid dashboard adapter configuration')
    }
    for (const queue of [...(adapter.queues ?? []), ...(adapter.allowedQueues ?? [])]) {
      if (!queue || queue.length > 255 || hasControlCharacters(queue)) {
        throw new Error('Invalid configured queue name')
      }
    }
  }
  return { ...config, maxPageSize, pollIntervalMs }
}
