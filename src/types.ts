export const states = ['pending', 'delayed', 'active', 'completed', 'failed'] as const
export type JobState = (typeof states)[number]
export type JobRef = { adapter: string; queue: string; id: string }
export type Counts = Record<JobState, number>
export type Result<T> =
  { kind: 'available'; value: T; observedAt: string } | { kind: 'unsupported'; reason: string }
export interface ReaderCapabilities {
  discoverQueues: boolean
  listJobs: boolean
  countsByState: boolean
  getJob: boolean
  reason?: string
}
export interface SafeJob {
  ref: JobRef
  name: string
  state: JobState
  attemptsRecorded: number
  dispatchedAt?: string
  finishedAt?: string
  errorMessage?: string
  payload?: unknown
}
export interface JobPage {
  items: SafeJob[]
  nextCursor?: string
  consistency: 'live'
}
export interface QueueCatalog {
  names: string[]
  origin: 'configured' | 'discovered'
  exhaustive: boolean
}
export interface QueueReader {
  capabilities(): ReaderCapabilities
  queues(): Promise<QueueCatalog>
  pendingCount(queue: string): Promise<Result<number>>
  counts(queue: string): Promise<Result<Counts>>
  job(queue: string, id: string): Promise<Result<SafeJob | null>>
  jobs(input: {
    queue: string
    state: JobState
    limit: number
    cursor?: string
  }): Promise<Result<JobPage>>
}
/** A structural public adapter contract; no dependency on Boring's private modules. */
export interface PublicAdapter {
  sizeOf(queue: string): Promise<number>
  getJob(
    id: string,
    queue: string,
  ): Promise<{
    status: JobState
    data: { name: string; attempts: number; payload: unknown; createdAt?: number }
    finishedAt?: number
    error?: string
  } | null>
}
export interface RedactionConfig {
  showPayload?: boolean
  sensitiveKeys?: string[]
  maxDepth?: number
  maxEntries?: number
  maxStringLength?: number
  /** Required when payloads are enabled. Also applied to error messages. */
  redactText?: (text: string) => string
}
export type ReaderSource =
  | { driver: 'redis'; connectionName?: string }
  | { driver: 'database'; connectionName?: string; tableName?: string }
  | { driver: 'sync' }
export interface AdapterConfig {
  source: ReaderSource
  queues?: string[]
  /** Exact queue names; omission allows discovery. An empty array denies all queues. */
  allowedQueues?: string[]
}
export interface DashboardConfig {
  pollIntervalMs?: number
  maxPageSize?: number
  adapters: Record<string, AdapterConfig>
  redaction?: RedactionConfig
}
export interface ResolvedConfig extends DashboardConfig {
  pollIntervalMs: number
  maxPageSize: number
}
export interface SafeTelemetryEvent {
  eventId: string
  processId: string
  sequence: number
  observedAt: string
  adapter?: string
  queue: string
  jobId: string
  attempt?: number
  kind: 'dispatch' | 'execution-start' | 'execution-end' | 'trace-error'
  outcome?: 'completed' | 'failed' | 'retrying'
  durationMs?: number
}
export interface TelemetrySink {
  write(events: readonly SafeTelemetryEvent[]): Promise<void>
  close(): Promise<void>
}
export interface TelemetryCollector {
  start(input: { processId: string; sink: TelemetrySink }): void
  health(): { started: boolean; droppedEvents: number; bufferedEvents: number }
  stop(): Promise<void>
}
