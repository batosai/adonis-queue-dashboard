import { DashboardError } from './errors.js'
import type { QueueReader, ResolvedConfig, ScheduleAccess, ScheduleAction } from './types.js'

export class Dashboard {
  constructor(
    public config: ResolvedConfig,
    private readers: Map<string, QueueReader>,
    private controls = new Map<string, ScheduleAccess>(),
  ) {}
  reader(name: string) {
    const reader = this.readers.get(name)
    if (!reader) throw new DashboardError(404, 'ADAPTER_NOT_FOUND', 'Unknown dashboard adapter')
    return reader
  }
  async scheduleAction(adapter: string, id: string, action: ScheduleAction) {
    const reader = this.reader(adapter)
    if (this.config.readOnly) throw new DashboardError(403, 'READ_ONLY', 'Dashboard is read-only')
    if (!['pause', 'resume', 'trigger', 'delete'].includes(action))
      throw new DashboardError(400, 'INVALID_ACTION', 'Invalid schedule action')
    if (!reader.capabilities().getSchedule || !this.controls.has(adapter))
      throw new DashboardError(403, 'ACTIONS_UNAVAILABLE', 'Schedule actions are unavailable')
    // Use the reader validation and access policy before resolving native controls.
    const result = await reader.schedule(id)
    if (result.kind !== 'available')
      throw new DashboardError(403, 'ACTIONS_UNAVAILABLE', 'Schedule actions are unavailable')
    if (!result.value)
      throw new DashboardError(404, 'SCHEDULE_NOT_FOUND', 'Schedule no longer exists')
    if (
      action === 'trigger' &&
      result.value.limit !== null &&
      result.value.runCount >= result.value.limit
    )
      throw new DashboardError(409, 'SCHEDULE_LIMIT_REACHED', 'Schedule run limit has been reached')
    const schedule = await this.controls.get(adapter)!(id)
    if (!schedule) throw new DashboardError(404, 'SCHEDULE_NOT_FOUND', 'Schedule no longer exists')
    await schedule[action]()
    return { ok: true }
  }
  metadata() {
    return {
      readOnly: this.config.readOnly,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPageSize: this.config.maxPageSize,
      adapters: [...this.readers].map(([name, reader]) => ({
        name,
        driver: this.config.adapters[name]!.source.driver,
        capabilities: {
          ...reader.capabilities(),
          scheduleActions:
            !this.config.readOnly && reader.capabilities().getSchedule && this.controls.has(name),
        },
      })),
    }
  }
}
