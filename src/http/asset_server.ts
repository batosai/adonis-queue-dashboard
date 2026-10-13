import { readFile } from 'node:fs/promises'
import { DashboardError } from '../errors.js'

type Entry = { file: string; css?: string[]; isEntry?: boolean }
export class AssetServer {
  #entry?: Entry
  #allowed = new Set<string>()
  constructor(private root = new URL('../../resources/dashboard/', import.meta.url)) {}
  async init() {
    const manifest = JSON.parse(
      await readFile(new URL('.vite/manifest.json', this.root), 'utf8'),
    ) as Record<string, Entry>
    const entry = Object.values(manifest).find((item) => item.isEntry)
    if (!entry) throw new Error('Dashboard frontend manifest has no entry')
    this.#entry = entry
    for (const item of Object.values(manifest)) {
      for (const file of [item.file, ...(item.css ?? [])]) {
        if (!/^assets\/[\w.-]+\.(js|css)$/.test(file))
          throw new Error('Unexpected dashboard asset path')
        this.#allowed.add(file.slice('assets/'.length))
      }
    }
  }
  html(prefix: string) {
    const entry = this.#entry!
    prefix = prefix.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    )
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Queue Dashboard</title>${(entry.css ?? []).map((file) => `<link rel="stylesheet" href="${prefix}/${file}">`).join('')}</head><body class="qd-page"><div id="queue-dashboard" data-prefix="${prefix}"></div><script type="module" src="${prefix}/${entry.file}"></script></body></html>`
  }
  async read(name: string) {
    if (!this.#allowed.has(name))
      throw new DashboardError(404, 'ASSET_NOT_FOUND', 'Unknown dashboard asset')
    return {
      body: await readFile(new URL(`assets/${name}`, this.root)),
      type: name.endsWith('.css') ? 'text/css' : 'text/javascript',
    }
  }
}
