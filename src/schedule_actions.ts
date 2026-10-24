import { Schedule } from '@adonisjs/queue'
import { supportsQueueScheduleActions } from './compatibility.js'
import type { PublicAdapter, ScheduleAccess } from './types.js'

export function queueScheduleAccess(
  version: string,
  adapter: PublicAdapter,
): ScheduleAccess | undefined {
  if (!supportsQueueScheduleActions(version)) return undefined
  // Queue 0.6.2 exposes a one-argument find(). Only the supported 0.9 storage
  // family is paired with Queue's adapter-aware API. Keep its type local so
  // consumers using the older, read-only API can still compile the package.
  const schedules = Schedule as unknown as {
    find(id: string, options: { adapter: () => PublicAdapter }): ReturnType<ScheduleAccess>
  }
  return (id) => schedules.find(id, { adapter: () => adapter })
}
