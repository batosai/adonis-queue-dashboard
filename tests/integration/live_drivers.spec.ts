import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import knex from 'knex'
import { Redis } from 'ioredis'
import { RedisAdapter } from '@boringnode/queue/drivers/redis_adapter'
import { KnexAdapter } from '@boringnode/queue/drivers/knex_adapter'
import { QueueSchemaService } from '@boringnode/queue'
import { RedisReader } from '../../src/readers/storage/redis_reader.js'
import { DatabaseReader } from '../../src/readers/storage/database_reader.js'

const redisUrl = process.env.QUEUE_DASHBOARD_TEST_REDIS_URL
const databaseUrl = process.env.QUEUE_DASHBOARD_TEST_DATABASE_URL

test('real Redis: custom prefix, retained jobs, hydration overlays and concurrent consumers', async ({
  assert,
}) => {
  const prefix = `queue-dashboard-test:${randomUUID()}::`
  const connection = new Redis(redisUrl!, { keyPrefix: prefix, maxRetriesPerRequest: 1 })
  try {
    const producer = new RedisAdapter(connection)
    const other = new RedisAdapter(connection)
    producer.setWorkerId('one')
    other.setWorkerId('two')
    for (const id of ['a', 'b', 'c'])
      await producer.pushOn('emails', {
        id,
        name: 'Job',
        attempts: 0,
        createdAt: Date.now(),
        payload: { token: 'hidden' },
      })
    await producer.pushLaterOn(
      'emails',
      { id: 'later', name: 'Job', attempts: 0, payload: null },
      60000,
    )
    const [one, two] = await Promise.all([producer.popFrom('emails'), other.popFrom('emails')])
    assert.notEqual(one!.id, two!.id)
    await producer.completeJob(one!.id, 'emails', false)
    await other.failJob(two!.id, 'emails', new Error('sensitive'), false)
    const reader = new RedisReader(
      'redis',
      producer,
      { source: { driver: 'redis' }, queues: ['emails'] },
      connection,
    )
    const counts = await reader.counts('emails')
    if (counts.kind === 'available')
      assert.deepEqual(counts.value, { pending: 1, delayed: 1, active: 0, completed: 1, failed: 1 })
    const listing = await reader.jobs({ queue: 'emails', state: 'completed', limit: 5 })
    if (listing.kind === 'available') {
      assert.lengthOf(listing.value.items, 1)
      assert.isString(listing.value.items[0]!.dispatchedAt)
    }
    const active = await producer.popFrom('emails')
    await producer.retryJob(active!.id, 'emails')
    const retried = await reader.job('emails', active!.id)
    if (retried.kind === 'available') assert.equal(retried.value!.attemptsRecorded, 1)
    assert.notInclude(JSON.stringify(retried), '"hidden"')
  } finally {
    // Only this test's generated namespace; never FLUSHDB or global cleanup.
    let cursor = '0'
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = next
      if (keys.length) await connection.del(...keys.map((key) => key.slice(prefix.length)))
    } while (cursor !== '0')
    await connection.quit()
  }
})
  .skip(!redisUrl)
  .timeout(30000)

test('real PostgreSQL: current states and distinct claims from concurrent consumers', async ({
  assert,
}) => {
  const url = new URL(databaseUrl!)
  if (!url.pathname.endsWith('/queue_dashboard_test'))
    throw new Error('Use a dedicated queue_dashboard_test database')
  const connection = knex({ client: 'pg', connection: databaseUrl, pool: { min: 0, max: 4 } })
  const table = `dashboard_test_${randomUUID().replaceAll('-', '')}`
  try {
    await new QueueSchemaService(connection).createJobsTable(table)
    const one = new KnexAdapter({ connection, tableName: table })
    const two = new KnexAdapter({ connection, tableName: table })
    one.setWorkerId('one')
    two.setWorkerId('two')
    for (const id of ['a', 'b', 'c'])
      await one.pushOn('emails', { id, name: 'Job', attempts: 0, payload: null })
    const [first, second] = await Promise.all([one.popFrom('emails'), two.popFrom('emails')])
    assert.notEqual(first!.id, second!.id)
    await one.completeJob(first!.id, 'emails', false)
    await two.failJob(second!.id, 'emails', new Error('hidden'), false)
    const reader = new DatabaseReader(
      'sql',
      one,
      { source: { driver: 'database', tableName: table } },
      connection,
    )
    await reader.checkFormat()
    const counts = await reader.counts('emails')
    if (counts.kind === 'available')
      assert.deepEqual(counts.value, { pending: 1, delayed: 0, active: 0, completed: 1, failed: 1 })
    const page = await reader.jobs({ queue: 'emails', state: 'failed', limit: 10 })
    if (page.kind === 'available') assert.lengthOf(page.value.items, 1)
  } finally {
    await connection.schema.dropTableIfExists(table)
    await connection.destroy()
  }
})
  .skip(!databaseUrl)
  .timeout(30000)
