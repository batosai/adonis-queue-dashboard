import type { Router, RouteGroup, HttpContext } from '@adonisjs/core/http'
import { type Dashboard } from '../dashboard.js'
import { DashboardError } from '../errors.js'
import { states, type JobState } from '../types.js'
import { AssetServer } from './asset_server.js'
import { hasControlCharacters } from '../validation.js'

function parameter(value: unknown, name: string, max = 255): string {
  if (typeof value !== 'string' || !value || value.length > max || hasControlCharacters(value)) {
    throw new DashboardError(400, 'INVALID_INPUT', `Invalid ${name}`)
  }
  return value
}
export function registerDashboardRoutes(
  router: Router,
  resolveDashboard: Dashboard | (() => Promise<Dashboard>),
  prefix = '/queue',
): RouteGroup {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(prefix) || prefix.endsWith('/')) {
    throw new Error('Dashboard route prefix must be a non-root path without a trailing slash')
  }
  const resolve = () =>
    typeof resolveDashboard === 'function' ? resolveDashboard() : Promise.resolve(resolveDashboard)
  const assets = new AssetServer()
  let assetsReady: Promise<void> | undefined
  const ready = () => (assetsReady ??= assets.init())
  const handler =
    (run: (ctx: HttpContext, dashboard: Dashboard) => Promise<unknown> | unknown) =>
    async (ctx: HttpContext) => {
      ctx.response
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'same-origin')
      try {
        return await run(ctx, await resolve())
      } catch (error) {
        if (error instanceof DashboardError)
          return ctx.response
            .status(error.status)
            .send({ error: { code: error.code, message: error.message } })
        return ctx.response
          .status(503)
          .send({ error: { code: 'READ_FAILED', message: 'Unable to read queue storage' } })
      }
    }
  return router
    .group(() => {
      router.get(
        '/',
        handler(async (ctx) => {
          await ready()
          ctx.response
            .type('html')
            .header(
              'Content-Security-Policy',
              "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
            )
          return assets.html(ctx.request.url().replace(/\/$/, ''))
        }),
      )
      router.get(
        '/assets/:file',
        handler(async (ctx) => {
          await ready()
          const asset = await assets.read(parameter(ctx.params.file, 'asset'))
          ctx.response.header('Content-Type', `${asset.type}; charset=utf-8`)
          return asset.body
        }),
      )
      router.get(
        '/api/capabilities',
        handler((_ctx, dashboard) => dashboard.metadata()),
      )
      router.get(
        '/api/queues',
        handler(async (ctx, dashboard) => {
          const adapter = parameter(ctx.request.input('adapter'), 'adapter')
          return dashboard.reader(adapter).queues()
        }),
      )
      router.get(
        '/api/counts',
        handler(async (ctx, dashboard) => {
          const reader = dashboard.reader(parameter(ctx.request.input('adapter'), 'adapter'))
          const queue = parameter(ctx.request.input('queue'), 'queue')
          return { counts: await reader.counts(queue), pending: await reader.pendingCount(queue) }
        }),
      )
      router.get(
        '/api/job',
        handler(async (ctx, dashboard) => {
          const reader = dashboard.reader(parameter(ctx.request.input('adapter'), 'adapter'))
          return reader.job(
            parameter(ctx.request.input('queue'), 'queue'),
            parameter(ctx.request.input('id'), 'id'),
          )
        }),
      )
      router.post(
        '/api/schedule/action',
        handler(async (ctx, dashboard) => {
          // A custom header makes cross-origin form submissions impossible. No CORS is enabled.
          if (
            ctx.request.header('x-queue-dashboard') !== '1' ||
            ctx.request.header('sec-fetch-site') === 'cross-site'
          )
            throw new DashboardError(
              403,
              'INVALID_ACTION_REQUEST',
              'Invalid dashboard action request',
            )
          try {
            return await dashboard.scheduleAction(
              parameter(ctx.request.input('adapter'), 'adapter'),
              parameter(ctx.request.input('id'), 'id'),
              parameter(
                ctx.request.input('action'),
                'action',
              ) as import('../types.js').ScheduleAction,
            )
          } catch (error) {
            if (error instanceof DashboardError) throw error
            throw new DashboardError(
              503,
              'ACTION_FAILED',
              'Unable to apply schedule action; refresh before trying again',
            )
          }
        }),
      )
      router.get(
        '/api/schedule',
        handler(async (ctx, dashboard) => {
          const reader = dashboard.reader(parameter(ctx.request.input('adapter'), 'adapter'))
          return reader.schedule(parameter(ctx.request.input('id'), 'id'))
        }),
      )
      router.get(
        '/api/schedules',
        handler(async (ctx, dashboard) => {
          const reader = dashboard.reader(parameter(ctx.request.input('adapter'), 'adapter'))
          const status = ctx.request.input('status')
          if (status !== undefined && status !== 'active' && status !== 'paused')
            throw new DashboardError(400, 'INVALID_STATUS', 'Invalid schedule status')
          const limit = Number(ctx.request.input('limit', dashboard.config.maxPageSize))
          if (!Number.isInteger(limit) || limit < 1 || limit > dashboard.config.maxPageSize)
            throw new DashboardError(400, 'INVALID_LIMIT', 'Invalid page size')
          const cursorInput = ctx.request.input('cursor')
          return reader.schedules({
            status,
            limit,
            cursor: cursorInput === undefined ? undefined : parameter(cursorInput, 'cursor', 4096),
          })
        }),
      )
      router.get(
        '/api/jobs',
        handler(async (ctx, dashboard) => {
          const reader = dashboard.reader(parameter(ctx.request.input('adapter'), 'adapter'))
          const state = parameter(ctx.request.input('state'), 'state')
          if (!states.includes(state as JobState))
            throw new DashboardError(400, 'INVALID_STATE', 'Invalid job state')
          const limit = Number(ctx.request.input('limit', dashboard.config.maxPageSize))
          if (!Number.isInteger(limit) || limit < 1 || limit > dashboard.config.maxPageSize)
            throw new DashboardError(400, 'INVALID_LIMIT', 'Invalid page size')
          const cursorInput = ctx.request.input('cursor')
          const cursor =
            cursorInput === undefined ? undefined : parameter(cursorInput, 'cursor', 4096)
          return reader.jobs({
            queue: parameter(ctx.request.input('queue'), 'queue'),
            state: state as JobState,
            limit,
            cursor,
          })
        }),
      )
    })
    .prefix(prefix)
}
