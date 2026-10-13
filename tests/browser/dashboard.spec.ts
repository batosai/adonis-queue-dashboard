/// <reference lib="dom" />

import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

test.group('Dashboard browser', (group) => {
  const password = randomBytes(24).toString('hex')
  let http: Server
  let url: string
  let app: { terminate(): Promise<void> }

  group.setup(async () => {
    const demoUrl = new URL('../../examples/demo/app.mjs', import.meta.url)
    const { createDemo } = await import(demoUrl.href)
    const demo = await createDemo({ password })
    app = demo.app
    http = createServer(demo.server.handle.bind(demo.server))
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(0, '127.0.0.1', resolve)
      })
      const address = http.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
      url = `http://127.0.0.1:${address.port}`
    } catch (error) {
      await app.terminate()
      throw error
    }
    return async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      await app.terminate()
    }
  })

  test('refresh, pagination, filters, details and mobile layout', async ({
    browserContext,
    assert,
  }) => {
    await browserContext.setHTTPCredentials({ username: 'operator', password })
    const page = await browserContext.newPage()
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${url}/admin/queues`)
    await page.getByText(/^Updated /).waitFor()
    // The default queue is empty. Once loaded, background polls must keep its
    // empty state stable instead of replacing it with the initial loading text.
    await page.getByRole('heading', { name: 'No pending jobs on this page', exact: true }).waitFor()
    await page.evaluate(() => {
      const emptyState = document.querySelector('.qd-empty')!
      const state = {
        flashed: false,
        observer: new MutationObserver(() => {
          if (emptyState.textContent?.includes('Loading jobs')) state.flashed = true
        }),
      }
      state.observer.observe(emptyState, { subtree: true, childList: true, characterData: true })
      Object.assign(window, { dashboardEmptyState: state })
    })
    // Delay the refresh to observe the pending phase.
    await page.route('**/api/jobs?**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await route.continue()
    })
    const emptyRefresh = page.waitForResponse((response) => response.url().includes('/api/jobs?'))
    await page.getByRole('button', { name: '↻ Refresh', exact: true }).click()
    await emptyRefresh
    assert.isFalse(
      await page.evaluate(() => {
        const { dashboardEmptyState: state } = window as typeof window & {
          dashboardEmptyState: { flashed: boolean; observer: MutationObserver }
        }
        state.observer.disconnect()
        return state.flashed
      }),
    )
    await page.unroute('**/api/jobs?**')
    await page.getByRole('button', { name: 'emails', exact: false }).click()
    await page
      .getByRole('button', { name: /View SendEmail/ })
      .first()
      .waitFor()
    assert.equal(await page.locator('tbody tr').count(), 10)
    await page.getByRole('button', { name: 'Next →', exact: true }).click()
    await page.getByText('Page 2 · Live data').waitFor()
    await page.getByRole('tab', { name: 'failed', exact: true }).click()
    await page.getByText('Page 1 · Live data').waitFor()
    await page
      .getByRole('button', { name: /View SendEmail/ })
      .first()
      .click()
    await page.getByRole('dialog').waitFor()
    await page.getByText('Payload hidden by the host.').waitFor()
    assert.equal(
      await page.getByRole('dialog').locator('pre').textContent(),
      '[Hidden: configure redactText to display error messages]',
    )
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true })
    const mobileLayout = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowingElements: Array.from(document.querySelectorAll('#queue-dashboard *'))
        .filter((element) => {
          // Table cells may scroll horizontally, but hidden labels must stay contained.
          if (element.closest('.qd-table-wrap') && !element.matches('.qd-sr-only')) return false
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && (rect.right > innerWidth || rect.left < 0)
        })
        .map((element) => ({ tag: element.tagName, className: element.className }))
        .slice(0, 20),
    }))
    assert.isTrue(
      mobileLayout.documentWidth <= mobileLayout.viewportWidth,
      `Dashboard overflows the mobile viewport: ${JSON.stringify(mobileLayout)}`,
    )
    assert.deepEqual(errors, [])
  })
})
