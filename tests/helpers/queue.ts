import * as queue from '@boringnode/queue'
import * as knexDriver from '@boringnode/queue/drivers/knex_adapter'
import type { Knex } from 'knex'

type SchemaService = new (connection: Knex) => {
  createJobsTable(table?: string): Promise<void>
  createSchedulesTable(table?: string): Promise<void>
}

export const QueueSchemaService =
  (knexDriver as unknown as { KnexQueueSchemaService?: SchemaService }).KnexQueueSchemaService ??
  (queue as unknown as { QueueSchemaService: SchemaService }).QueueSchemaService

/** Boring 0.9 requires the acquired lease; 0.6 accepts the job ID. */
export function jobLease(job: { id: string; leaseToken?: string }) {
  return (job.leaseToken ? job : job.id) as Parameters<knexDriver.KnexAdapter['completeJob']>[0]
}
