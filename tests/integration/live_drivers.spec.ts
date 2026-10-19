import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import knex from 'knex'
import { Redis } from 'ioredis'
import { RedisAdapter } from '@boringnode/queue/drivers/redis_adapter'
import { KnexAdapter } from '@boringnode/queue/drivers/knex_adapter'
import { QueueSchemaService, jobLease } from '../helpers/queue.js'
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
    await producer.completeJob(jobLease(one!), 'emails', false)
    await other.failJob(jobLease(two!), 'emails', new Error('sensitive'), false)
    const reader = new RedisReader(
      'redis',
      producer,
      { source: { driver: 'redis' }, queues: ['emails'], schedules: { enabled: true } },
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
    await producer.retryJob(jobLease(active!), 'emails')
    const retried = await reader.job('emails', active!.id)
    if (retried.kind === 'available') assert.equal(retried.value!.attemptsRecorded, 1)
    assert.notInclude(JSON.stringify(retried), '"hidden"')
    for (const id of ['schedule-a', 'schedule-b', 'schedule-c'])
      await producer.upsertSchedule({
        id,
        name: 'Digest',
        payload: { token: 'hidden' },
        everyMs: 60000,
        timezone: 'UTC',
      })
    await producer.updateSchedule('schedule-b', { status: 'paused' })
    const ids = new Set<string>()
    let scheduleCursor: string | undefined
    do {
      const schedules = await reader.schedules({ limit: 1, cursor: scheduleCursor })
      if (schedules.kind !== 'available') return assert.fail('Expected Redis schedules')
      assert.isAtMost(schedules.value.items.length, 1)
      schedules.value.items.forEach((item) => ids.add(item.ref.id))
      assert.notInclude(JSON.stringify(schedules), 'payload')
      scheduleCursor = schedules.value.nextCursor
    } while (scheduleCursor)
    assert.deepEqual([...ids].sort(), ['schedule-a', 'schedule-b', 'schedule-c'])
    const paused = await reader.schedule('schedule-b')
    if (paused.kind === 'available') assert.equal(paused.value!.status, 'paused')
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
  const schedulesTable = `${table}_schedules`
  try {
    await new QueueSchemaService(connection).createJobsTable(table)
    await new QueueSchemaService(connection).createSchedulesTable(schedulesTable)
    const one = new KnexAdapter({
      connection,
      tableName: table,
      schedulesTableName: schedulesTable,
    })
    const two = new KnexAdapter({
      connection,
      tableName: table,
      schedulesTableName: schedulesTable,
    })
    one.setWorkerId('one')
    two.setWorkerId('two')
    for (const id of ['a', 'b', 'c'])
      await one.pushOn('emails', { id, name: 'Job', attempts: 0, payload: null })
    const [first, second] = await Promise.all([one.popFrom('emails'), two.popFrom('emails')])
    assert.notEqual(first!.id, second!.id)
    await one.completeJob(jobLease(first!), 'emails', false)
    await two.failJob(jobLease(second!), 'emails', new Error('hidden'), false)
    const reader = new DatabaseReader(
      'sql',
      one,
      {
        source: { driver: 'database', tableName: table, schedulesTableName: schedulesTable },
        schedules: { enabled: true },
      },
      connection,
    )
    await reader.checkFormat()
    const counts = await reader.counts('emails')
    if (counts.kind === 'available')
      assert.deepEqual(counts.value, { pending: 1, delayed: 0, active: 0, completed: 1, failed: 1 })
    const page = await reader.jobs({ queue: 'emails', state: 'failed', limit: 10 })
    if (page.kind === 'available') assert.lengthOf(page.value.items, 1)
    for (const id of ['schedule-a', 'schedule-b'])
      await one.upsertSchedule({
        id,
        name: 'Digest',
        payload: null,
        everyMs: 60000,
        timezone: 'UTC',
      })
    await one.updateSchedule('schedule-b', { status: 'paused' })
    await reader.checkSchedulesFormat()
    const schedules = await reader.schedules({ limit: 1 })
    if (schedules.kind !== 'available') return assert.fail('Expected PostgreSQL schedules')
    assert.deepEqual(
      schedules.value.items.map((item) => item.ref.id),
      ['schedule-a'],
    )
    const next = await reader.schedules({ limit: 1, cursor: schedules.value.nextCursor })
    if (next.kind === 'available') {
      assert.deepEqual(
        next.value.items.map((item) => item.ref.id),
        ['schedule-b'],
      )
      assert.equal(next.value.items[0]!.status, 'paused')
    }
    const filtered = await reader.schedules({ status: 'paused', limit: 10 })
    if (filtered.kind === 'available')
      assert.deepEqual(
        filtered.value.items.map((item) => item.ref.id),
        ['schedule-b'],
      )
  } finally {
    await connection.schema.dropTableIfExists(schedulesTable)
    await connection.schema.dropTableIfExists(table)
    await connection.destroy()
  }
})
  .skip(!databaseUrl)
  .timeout(30000)
