import { Application } from '@adonisjs/core/app'
import { defineConfig as httpConfig } from '@adonisjs/core/http'
import { defineConfig as loggerConfig } from '@adonisjs/core/logger'
import {
  defineConfig as encryptionConfig,
  drivers as encryptionDrivers,
} from '@adonisjs/core/encryption'
import { defineConfig as queueConfig, drivers, QueueSchemaService } from '@adonisjs/queue'
import { defineConfig } from '@jrmc/adonis-queue-dashboard'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

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
    const manager = await app.container.make('queue.manager')
    if (seed) {
      const adapter = manager.use('database')
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
        if (index < 4) await adapter.completeJob(job.id, 'emails', false)
        else await adapter.failJob(job.id, 'emails', new Error('Demo delivery error'), false)
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
