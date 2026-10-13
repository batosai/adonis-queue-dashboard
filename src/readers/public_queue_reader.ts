import { DashboardError } from '../errors.js'
import { Redactor } from '../security/redactor.js'
import { hasControlCharacters } from '../validation.js'
import { states } from '../types.js'
import type {
  AdapterConfig,
  Counts,
  JobPage,
  JobState,
  PublicAdapter,
  QueueReader,
  QueueCatalog,
  ReaderCapabilities,
  RedactionConfig,
  Result,
  SafeJob,
} from '../types.js'

export function available<T>(value: T): Result<T> {
  return { kind: 'available', value, observedAt: new Date().toISOString() }
}
export class PublicQueueReader implements QueueReader {
  protected reason?: string
  protected redactor: Redactor
  constructor(
    protected name: string,
    protected adapter: PublicAdapter,
    protected config: AdapterConfig,
    redaction?: RedactionConfig,
    reason = 'Storage format is not supported; public API only',
  ) {
    this.reason = reason
    this.redactor = new Redactor(redaction)
  }
  capabilities(): ReaderCapabilities {
    return {
      discoverQueues: false,
      listJobs: false,
      countsByState: false,
      getJob: this.config.source.driver !== 'sync',
      reason: this.reason,
    }
  }
  assertQueue(queue: string) {
    if (!queue || queue.length > 255 || hasControlCharacters(queue))
      throw new DashboardError(400, 'INVALID_QUEUE', 'Invalid queue name')
    if (this.config.allowedQueues && !this.config.allowedQueues.includes(queue)) {
      throw new DashboardError(403, 'QUEUE_FORBIDDEN', 'Queue is not allowed')
    }
  }
  protected allowed(queue: string) {
    return !this.config.allowedQueues || this.config.allowedQueues.includes(queue)
  }
  protected assertPage(input: { queue: string; state: JobState; limit: number }) {
    this.assertQueue(input.queue)
    if (
      !states.includes(input.state) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new DashboardError(400, 'INVALID_PAGE', 'Invalid state or page size')
    }
  }
  async queues(): Promise<QueueCatalog> {
    return {
      names: [...new Set(this.config.queues ?? ['default'])].filter((queue) => this.allowed(queue)),
      origin: 'configured' as const,
      exhaustive: false,
    }
  }
  async pendingCount(queue: string) {
    this.assertQueue(queue)
    return available(await this.adapter.sizeOf(queue))
  }
  async counts(queue: string): Promise<Result<Counts>> {
    this.assertQueue(queue)
    return { kind: 'unsupported', reason: this.reason! }
  }
  async job(queue: string, id: string): Promise<Result<SafeJob | null>> {
    this.assertQueue(queue)
    if (!id || id.length > 255 || hasControlCharacters(id)) {
      throw new DashboardError(400, 'INVALID_ID', 'Invalid job ID')
    }
    if (this.config.source.driver === 'sync')
      return { kind: 'unsupported', reason: 'Sync has no persistent jobs' }
    const record = await this.adapter.getJob(id, queue)
    if (!record) return available(null)
    const date = (value?: number) =>
      value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8640000000000000
        ? new Date(value).toISOString()
        : undefined
    return available({
      ref: { adapter: this.name, queue, id },
      name: record.data.name,
      state: record.status,
      attemptsRecorded: record.data.attempts,
      dispatchedAt: date(record.data.createdAt),
      finishedAt: date(record.finishedAt),
      errorMessage: record.error ? this.redactor.text(record.error) : undefined,
      ...(this.redactor.showPayload ? { payload: this.redactor.payload(record.data.payload) } : {}),
    })
  }
  async jobs(input: {
    queue: string
    state: JobState
    limit: number
    cursor?: string
  }): Promise<Result<JobPage>> {
    this.assertPage(input)
    return { kind: 'unsupported', reason: this.reason! }
  }
  protected async hydrate(queue: string, state: JobState, ids: string[]) {
    const items: SafeJob[] = []
    // Bound concurrent detail reads to five; disappeared/moved jobs are normal.
    for (let start = 0; start < ids.length; start += 5) {
      const records = await Promise.all(
        ids.slice(start, start + 5).map((id) => this.job(queue, id)),
      )
      for (const result of records) {
        if (result.kind === 'available' && result.value?.state === state) items.push(result.value)
      }
    }
    return items
  }
}
