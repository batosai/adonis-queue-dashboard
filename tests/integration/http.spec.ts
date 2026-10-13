import { test } from '@japa/runner'
import { HttpContextFactory, RouterFactory } from '@adonisjs/http-server/factories'
import { Dashboard } from '../../src/dashboard.js'
import { defineConfig } from '../../src/define_config.js'
import { PublicQueueReader } from '../../src/readers/public_queue_reader.js'
// Exercise the compiled routes so their asset paths match the published package.
const { registerDashboardRoutes }: typeof import('../../src/http/routes.js') = await import(
  new URL('../../build/src/http/routes.js', import.meta.url).href
)

test.group('Adonis route group and host middleware', () => {
  test('applies host middleware to every endpoint and honors outer route prefixes', async ({
    assert,
  }) => {
    const config = defineConfig({ adapters: { sync: { source: { driver: 'sync' } } } })
    const dashboard = new Dashboard(
      config,
      new Map([
        [
          'sync',
          new PublicQueueReader(
            'sync',
            { sizeOf: async () => 0, getJob: async () => null },
            config.adapters.sync!,
          ),
        ],
      ]),
    )
    const router = new RouterFactory().create()
    let readerResolutions = 0
    router
      .group(() => {
        const group = registerDashboardRoutes(
          router,
          async () => {
            readerResolutions++
            return dashboard
          },
          '/queues',
        )
        group
          .use(async (ctx, next) => {
            if (ctx.request.header('x-access') !== 'allowed')
              return ctx.response.status(403).send({ denied: true })
            return next()
          })
          .use(async (ctx, next) => {
            ctx.response.header('X-Host-Middleware', 'applied')
            return next()
          })
      })
      .prefix('/admin')
    router.commit()
    const routes = router.toJSON().root!
    for (const route of routes) {
      const ctx = new HttpContextFactory().merge({ url: route.pattern }).create()
      await route.execute(route, ctx.containerResolver, ctx, (error) => {
        throw error
      })
      assert.equal(ctx.response.getStatus(), 403, route.pattern)
    }
    assert.equal(readerResolutions, 0, 'Middleware rejects before reader resolution')
    const call = async (pattern: string, query = '', params = {}) => {
      const ctx = new HttpContextFactory().merge({ url: `${pattern}${query}` }).create()
      ctx.request.request.headers['x-access'] = 'allowed'
      ctx.params = params
      const route = routes.find((item) => item.pattern === pattern)!
      await route.execute(route, ctx.containerResolver, ctx, (error) => {
        throw error
      })
      assert.equal(ctx.response.getHeader('X-Host-Middleware'), 'applied')
      assert.equal(ctx.response.getHeader('Cache-Control'), 'no-store')
      return { ctx, body: ctx.response.getBody() }
    }
    const shell = await call('/admin/queues')
    assert.include(shell.body, 'data-prefix="/admin/queues"')
    assert.include(shell.body, '/admin/queues/assets/')
    const invalid = await call(
      '/admin/queues/api/jobs',
      '?adapter=sync&queue=default&state=unknown',
    )
    assert.equal(invalid.ctx.response.getStatus(), 400)
    const wrongAsset = await call('/admin/queues/assets/:file', '', { file: '../package.json' })
    assert.equal(wrongAsset.ctx.response.getStatus(), 404)
    const meta = await call('/admin/queues/api/capabilities')
    assert.equal(meta.body.adapters[0].driver, 'sync')
    assert.isFalse(meta.body.adapters[0].capabilities.getJob)
    assert.isNull(router.match('/admin/queues/api/jobs', 'POST', true))
  })
  test('rejects invalid mount paths synchronously', ({ assert }) => {
    const router = new RouterFactory().create()
    const dashboard = new Dashboard(defineConfig({ adapters: {} }), new Map())
    assert.throws(() => registerDashboardRoutes(router, dashboard, '/queue"><script>'), /prefix/)
  })
})
