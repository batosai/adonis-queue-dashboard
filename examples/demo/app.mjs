import { Application } from '@adonisjs/core/app'
import { defineConfig as httpConfig } from '@adonisjs/core/http'
import { defineConfig as loggerConfig } from '@adonisjs/core/logger'
import {
  defineConfig as encryptionConfig,
  drivers as encryptionDrivers,
} from '@adonisjs/core/encryption'
import { defineConfig as queueConfig, drivers } from '@adonisjs/queue'
import * as queue from '@adonisjs/queue'
import * as knexDriver from '@boringnode/queue/drivers/knex_adapter'
import { defineConfig } from '@jrmc/adonis-queue-dashboard'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const QueueSchemaService = knexDriver.KnexQueueSchemaService ?? queue.QueueSchemaService

/** Real Adonis app with Lucid + Queue providers, no Vue/Vite dependency in the host. */
export async function createDemo({
  root = new URL('../../', import.meta.url),
  password,
  seed = true,
  mount = true,
  environment = 'web',
} = {}) {
  if (!password) throw new Error('Set DASHBOARD_PASSWORD before starting the demo')
  const hash = (value) => createHash('sha256').update(value).digest()
  const app = new Application(root, { environment, importer: (path) => import(path) })
  app.rcContents({
    providers: [
      () => import('@adonisjs/core/providers/app_provider'),
      () => import('@adonisjs/lucid/database_provider'),
      () => import('@adonisjs/queue/queue_provider'),
      () => import('@jrmc/adonis-queue-dashboard/dashboard_provider'),
    ],
  })
  app.useConfig({
    app: { http: httpConfig({ useAsyncLocalStorage: true }) },
    logger: loggerConfig({
      default: 'app',
      loggers: { app: { name: 'queue-dashboard-demo', enabled: false } },
    }),
    encryption: encryptionConfig({
      default: 'gcm',
      list: {
        gcm: encryptionDrivers.aes256gcm({ keys: [randomBytes(32).toString('hex')], id: 'gcm' }),
      },
    }),
    database: {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          pool: { min: 1, max: 1 },
        },
      },
    },
    queue: queueConfig({
      default: 'database',
      adapters: { database: drivers.database({ connectionName: 'primary' }) },
      locations: [],
      worker: { concurrency: 2 },
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    }),
    queue_dashboard: defineConfig({
      maxPageSize: 10,
      adapters: {
        database: {
          source: { driver: 'database', connectionName: 'primary' },
          schedules: { enabled: true },
          queues: ['default', 'emails'],
          allowedQueues: ['default', 'emails'],
        },
      },
    }),
  })
  app.starting(async () => {
    if (!mount) return
    const router = await app.container.make('router')
    router
      .group(() => {
        router.queueDashboard('/queues').use(async (ctx, next) => {
          const header = ctx.request.header('authorization') ?? ''
          const credentials = header.startsWith('Basic ')
            ? Buffer.from(header.slice(6), 'base64').toString()
            : ''
          if (timingSafeEqual(hash(credentials), hash(`operator:${password}`))) return next()
          ctx.response.header('WWW-Authenticate', 'Basic realm="Queue dashboard"')
          return ctx.response.status(401).send({ error: { message: 'Unauthorized' } })
        })
      })
      .prefix('/admin')
  })
  try {
    await app.init()
    await app.boot()
    const db = await app.container.make('lucid.db')
    const connection = db.connection('primary').getWriteClient()
    // The demo owns an isolated in-memory DB. The dashboard itself never creates tables.
    await new QueueSchemaService(connection).createJobsTable()
    await new QueueSchemaService(connection).createSchedulesTable()
    const manager = await app.container.make('queue.manager')
    if (seed) {
      const adapter = manager.use('database')
      await adapter.upsertSchedule({
        id: 'daily-digest',
        name: 'SendDigest',
        payload: { token: 'demo-sensitive-value' },
        cronExpression: '0 8 * * *',
        timezone: 'Europe/Paris',
        limit: 30,
      })
      await adapter.upsertSchedule({
        id: 'paused-metrics',
        name: 'CollectMetrics',
        payload: null,
        everyMs: 60000,
        timezone: 'UTC',
      })
      for (let index = 0; index < 10; index++)
        await adapter.upsertSchedule({
          id: `metrics-${index}`,
          name: 'CollectMetrics',
          payload: null,
          everyMs: (index + 1) * 60000,
          timezone: 'UTC',
        })
      await adapter.updateSchedule('paused-metrics', {
        status: 'paused',
        lastRunAt: new Date(),
        runCount: 3,
      })
      for (let index = 0; index < 24; index++) {
        await adapter.pushOn('emails', {
          id: `demo-${String(index).padStart(3, '0')}`,
          name: 'SendEmail',
          attempts: 0,
          createdAt: Date.now(),
          payload: { token: 'demo-sensitive-value' },
        })
      }
      for (let index = 0; index < 6; index++) {
        const job = await adapter.popFrom('emails')
        if (index < 4) await adapter.completeJob(job.leaseToken ? job : job.id, 'emails', false)
        else
          await adapter.failJob(
            job.leaseToken ? job : job.id,
            'emails',
            new Error('Demo delivery error'),
            false,
          )
      }
      await adapter.popFrom('emails')
      await adapter.pushLaterOn(
        'emails',
        {
          id: 'scheduled-demo',
          name: 'SendDigest',
          attempts: 0,
          payload: null,
          createdAt: Date.now(),
        },
        60000,
      )
    }
    await app.warmUp()
    const server = await app.container.make('server')
    await server.boot()
    return { app, server }
  } catch (error) {
    await app.terminate()
    throw error
  }
}
