import type { ApplicationService } from '@adonisjs/core/types'
import type { Knex } from 'knex'
import type { Redis } from 'ioredis'
import type { RouteGroup } from '@adonisjs/core/http'
import { defineConfig } from '../src/define_config.js'
import { Dashboard } from '../src/dashboard.js'
import { queueStorageVersion } from '../src/compatibility.js'
import { PublicQueueReader } from '../src/readers/public_queue_reader.js'
import { RedisReader } from '../src/readers/storage/redis_reader.js'
import { DatabaseReader } from '../src/readers/storage/database_reader.js'
import { registerDashboardRoutes } from '../src/http/routes.js'
import type { PublicAdapter, QueueReader } from '../src/types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'queue.dashboard': Dashboard
  }
}

declare module '@adonisjs/core/http' {
  interface Router {
    queueDashboard: (pattern?: string) => RouteGroup
  }
}

export default class DashboardProvider {
  constructor(protected app: ApplicationService) {}
  register() {
    this.app.container.singleton('queue.dashboard', async () => {
      const config = defineConfig(this.app.config.get('queue_dashboard', { adapters: {} }))
      const manager = (await this.app.container.make('queue.manager' as never)) as unknown as {
        use(name: string): PublicAdapter
      }
      const version = await queueStorageVersion(this.app.makePath('package.json'))
      const readers = new Map<string, QueueReader>()
      for (const [name, options] of Object.entries(config.adapters)) {
        const adapter = manager.use(name)
        let reader: QueueReader = new PublicQueueReader(
          name,
          adapter,
          options,
          config.redaction,
          options.source.driver === 'sync'
            ? 'Sync has no persistent jobs'
            : `Unsupported Boring Queue version ${version}; supported: 0.6.0`,
        )
        if (version === '0.6.0' && options.source.driver === 'redis') {
          const redis = (await this.app.container.make('redis' as never)) as unknown as {
            connection(name?: string): { ioConnection: Redis }
          }
          reader = new RedisReader(
            name,
            adapter,
            options,
            redis.connection(options.source.connectionName).ioConnection,
            config.redaction,
          )
        }
        if (version === '0.6.0' && options.source.driver === 'database') {
          const db = (await this.app.container.make('lucid.db' as never)) as unknown as {
            connection(name?: string): { getWriteClient(): Knex }
          }
          const sqlReader = new DatabaseReader(
            name,
            adapter,
            options,
            db.connection(options.source.connectionName).getWriteClient(),
            config.redaction,
          )
          try {
            await sqlReader.checkFormat()
            reader = sqlReader
          } catch (error) {
            const code = (error as { code?: string }).code
            if (
              ![
                '42703',
                '42P01',
                'SQLITE_ERROR',
                'ER_BAD_FIELD_ERROR',
                'ER_NO_SUCH_TABLE',
              ].includes(code ?? '')
            )
              throw error
            reader = new PublicQueueReader(
              name,
              adapter,
              options,
              config.redaction,
              'SQL queue table is missing or incompatible',
            )
          }
        }
        readers.set(name, reader)
      }
      return new Dashboard(config, readers)
    })
  }
  async boot() {
    const router = await this.app.container.make('router')
    router.queueDashboard = (pattern = '/queue') =>
      registerDashboardRoutes(router, () => this.app.container.make('queue.dashboard'), pattern)
  }
}
