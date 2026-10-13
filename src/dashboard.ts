import { DashboardError } from './errors.js'
import type { QueueReader, ResolvedConfig } from './types.js'

export class Dashboard {
  constructor(
    public config: ResolvedConfig,
    private readers: Map<string, QueueReader>,
  ) {}
  reader(name: string) {
    const reader = this.readers.get(name)
    if (!reader) throw new DashboardError(404, 'ADAPTER_NOT_FOUND', 'Unknown dashboard adapter')
    return reader
  }
  metadata() {
    return {
      pollIntervalMs: this.config.pollIntervalMs,
      maxPageSize: this.config.maxPageSize,
      adapters: [...this.readers].map(([name, reader]) => ({
        name,
        driver: this.config.adapters[name]!.source.driver,
        capabilities: reader.capabilities(),
      })),
    }
  }
}
