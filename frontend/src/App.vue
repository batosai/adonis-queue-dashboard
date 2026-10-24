<script setup lang="ts">
import Schedules from './Schedules.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  TabsRoot,
  TabsList,
  TabsTrigger,
} from 'reka-ui'
import type {
  Counts,
  JobPage,
  JobState,
  QueueCatalog,
  ReaderCapabilities,
  Result,
  SafeJob,
} from '../../src/types'

const props = defineProps<{ prefix: string }>()
type Meta = {
  readOnly: boolean
  pollIntervalMs: number
  maxPageSize: number
  adapters: { name: string; driver: string; capabilities: ReaderCapabilities }[]
}
const metadata = ref<Meta>()
const adapter = ref('')
const view = ref('jobs')
const queue = ref('')
const catalog = ref<QueueCatalog>({ names: [], origin: 'configured', exhaustive: false })
const state = ref<JobState>('pending')
const counts = ref<Partial<Counts>>({})
const page = ref<JobPage>({ items: [], consistency: 'live' })
const cursors = ref<(string | undefined)[]>([undefined])
const error = ref('')
const unsupported = ref('')
const loading = ref(false)
const hasSnapshot = ref(false)
const initialLoading = computed(() => loading.value && !hasSnapshot.value)
const updatedAt = ref('')
const lookupId = ref('')
const selected = ref<SafeJob | null>(null)
const detailOpen = ref(false)
const detailError = ref('')
const detailLoading = ref(false)
const capability = computed(() =>
  metadata.value?.adapters.find((item) => item.name === adapter.value),
)
const statuses: JobState[] = ['pending', 'delayed', 'active', 'completed', 'failed']
let refreshController: AbortController | undefined
let catalogController: AbortController | undefined
let detailController: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let failures = 0

async function api<T>(
  endpoint: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams(params)
  const response = await fetch(`${props.prefix}/api/${endpoint}?${query}`, {
    credentials: 'same-origin',
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (response.status === 401 || response.status === 403)
    throw new Error('Access denied. Sign in with an authorized account.')
  if (!response.ok)
    throw new Error(
      response.status === 400
        ? 'Invalid request. Refresh the page and try again.'
        : 'Queue storage is unavailable. Please try again.',
    )
  return response.json()
}
function isAbort(caught: unknown) {
  return caught instanceof DOMException && caught.name === 'AbortError'
}
function message(caught: unknown) {
  return caught instanceof Error ? caught.message : 'Unable to load the dashboard.'
}
function schedule() {
  clearTimeout(timer)
  if (!stopped)
    timer = setTimeout(
      async () => {
        if (!document.hidden && !loading.value) await refresh()
        schedule()
      },
      Math.min(60000, (metadata.value?.pollIntervalMs ?? 5000) * 2 ** Math.min(failures, 4)),
    )
}
async function refresh() {
  if (view.value !== 'jobs' || !adapter.value || !queue.value) return
  refreshController?.abort()
  const controller = new AbortController()
  refreshController = controller
  loading.value = true
  try {
    const params = { adapter: adapter.value, queue: queue.value }
    const cursor = cursors.value.at(-1)
    const [summary, listing] = await Promise.all([
      api<{ counts: Result<Counts>; pending: Result<number> }>('counts', params, controller.signal),
      api<Result<JobPage>>(
        'jobs',
        {
          ...params,
          state: state.value,
          limit: String(metadata.value!.maxPageSize),
          ...(cursor ? { cursor } : {}),
        },
        controller.signal,
      ),
    ])
    if (controller.signal.aborted) return
    counts.value =
      summary.counts.kind === 'available'
        ? summary.counts.value
        : summary.pending.kind === 'available'
          ? { pending: summary.pending.value }
          : {}
    page.value = listing.kind === 'available' ? listing.value : { items: [], consistency: 'live' }
    hasSnapshot.value = true
    unsupported.value = listing.kind === 'unsupported' ? listing.reason : ''
    updatedAt.value = new Date().toLocaleTimeString()
    error.value = ''
    failures = 0
  } catch (caught) {
    if (!isAbort(caught)) {
      error.value = message(caught)
      failures++
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}
async function loadQueues() {
  refreshController?.abort()
  catalogController?.abort()
  detailController?.abort()
  detailOpen.value = false
  const controller = new AbortController()
  catalogController = controller
  queue.value = ''
  catalog.value = { names: [], origin: 'configured', exhaustive: false }
  counts.value = {}
  page.value = { items: [], consistency: 'live' }
  hasSnapshot.value = false
  loading.value = true
  try {
    const result = await api<QueueCatalog>('queues', { adapter: adapter.value }, controller.signal)
    if (controller.signal.aborted) return
    catalog.value = result
    queue.value = catalog.value.names[0] ?? ''
    error.value = ''
  } catch (caught) {
    if (!isAbort(caught)) error.value = message(caught)
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}
async function openJob(id: string) {
  if (!id || !queue.value) return
  detailController?.abort()
  const controller = new AbortController()
  detailController = controller
  selected.value = null
  detailError.value = ''
  detailLoading.value = true
  detailOpen.value = true
  try {
    const result = await api<Result<SafeJob | null>>(
      'job',
      { adapter: adapter.value, queue: queue.value, id },
      controller.signal,
    )
    if (controller.signal.aborted) return
    if (result.kind === 'unsupported') detailError.value = result.reason
    else if (!result.value)
      detailError.value = 'This job is no longer stored, or its ID is unknown.'
    else selected.value = result.value
  } catch (caught) {
    if (!isAbort(caught)) detailError.value = message(caught)
  } finally {
    if (!controller.signal.aborted) detailLoading.value = false
  }
}
function selectQueue(name: string) {
  queue.value = name
  view.value = 'jobs'
}
function nextPage() {
  if (page.value.nextCursor) {
    cursors.value = [...cursors.value, page.value.nextCursor]
    refresh()
  }
}
function previousPage() {
  cursors.value = cursors.value.slice(0, -1)
  refresh()
}
watch(view, () => {
  refreshController?.abort()
  detailController?.abort()
  detailOpen.value = false
  loading.value = false
  if (view.value === 'jobs') refresh()
})
watch(adapter, loadQueues)
watch([queue, state], () => {
  detailController?.abort()
  detailOpen.value = false
  cursors.value = [undefined]
  page.value = { items: [], consistency: 'live' }
  hasSnapshot.value = false
  unsupported.value = ''
  refresh()
})
async function initialize() {
  loading.value = true
  try {
    metadata.value = await api<Meta>('capabilities')
    adapter.value = metadata.value.adapters[0]?.name ?? ''
    schedule()
  } catch (caught) {
    error.value = message(caught)
  } finally {
    loading.value = false
  }
}
onMounted(initialize)
onUnmounted(() => {
  stopped = true
  clearTimeout(timer)
  refreshController?.abort()
  catalogController?.abort()
  detailController?.abort()
})
</script>

<template>
  <div class="qd-layout">
    <aside class="qd-sidebar">
      <a :href="prefix" class="qd-brand"
        ><span class="qd-mark">Q</span><span>Queue <b>Dashboard</b></span></a
      >
      <div class="qd-sidebar-body">
        <label class="qd-label" for="adapter">Adapter</label>
        <select id="adapter" v-model="adapter" class="qd-select">
          <option v-for="item in metadata?.adapters" :key="item.name" :value="item.name">
            {{ item.name }} · {{ item.driver }}
          </option>
        </select>
        <div class="qd-section-label">
          Queues <span>{{ catalog.names.length }}</span>
        </div>
        <nav aria-label="Queues" class="qd-queues">
          <button
            v-for="name in catalog.names"
            :key="name"
            :class="['qd-queue', { 'is-active': view === 'jobs' && queue === name }]"
            :aria-current="view === 'jobs' && queue === name ? 'page' : undefined"
            @click="selectQueue(name)"
          >
            <span class="qd-dot" />{{ name
            }}<span v-if="view === 'jobs' && queue === name" class="qd-arrow">→</span>
          </button>
        </nav>
        <p v-if="metadata && !metadata.adapters.length" class="qd-muted">No adapters configured.</p>
        <p v-else-if="!loading && !catalog.names.length" class="qd-muted">No visible queues.</p>
        <p v-if="!catalog.exhaustive" class="qd-catalog-note">
          {{
            catalog.origin === 'configured'
              ? 'Configured queues only.'
              : 'Discovery is incomplete. Reload queues to continue.'
          }}
        </p>
        <button class="qd-text-button" :disabled="!adapter || loading" @click="loadQueues">
          Reload queues
        </button>
      </div>
      <div class="qd-sidebar-footer">
        <span class="qd-dot" />
        {{ metadata?.readOnly ? 'Read-only monitoring' : 'Queue management' }}
      </div>
    </aside>
    <main class="qd-main">
      <header class="qd-header">
        <span>MONITORING / {{ adapter || 'QUEUE' }}</span
        ><span v-if="metadata?.readOnly" class="qd-badge">Read only</span>
      </header>
      <div class="qd-content">
        <TabsRoot v-model="view"
          ><TabsList class="qd-tabs qd-view-tabs" aria-label="Monitoring view">
            <TabsTrigger value="jobs" class="qd-tab">Jobs</TabsTrigger>
            <TabsTrigger value="schedules" class="qd-tab">Schedules</TabsTrigger>
          </TabsList></TabsRoot
        >
        <Schedules
          v-if="view === 'schedules' && metadata && capability"
          :key="adapter"
          :prefix="prefix"
          :adapter="adapter"
          :capabilities="capability.capabilities"
          :poll-interval-ms="metadata.pollIntervalMs"
          :max-page-size="metadata.maxPageSize"
        />
        <template v-if="view === 'jobs'">
          <div class="qd-title-row">
            <div>
              <p class="qd-eyebrow">Queue overview</p>
              <h1>{{ queue || 'Your queues' }}</h1>
              <p class="qd-subtitle">
                Current storage state. Completed and failed counts include retained jobs only.
              </p>
            </div>
            <button
              class="qd-button"
              :disabled="loading || (!queue && !!metadata)"
              @click="metadata ? refresh() : initialize()"
            >
              {{ loading ? 'Refreshing…' : '↻ Refresh' }}
            </button>
          </div>
          <div v-if="error" class="qd-alert" role="alert">{{ error }}</div>
          <div v-if="capability?.capabilities.reason" class="qd-notice">
            {{ capability.capabilities.reason }}
          </div>
          <section class="qd-cards" aria-label="Job counts">
            <button
              v-for="status in statuses"
              :key="status"
              :class="['qd-card', `qd-${status}`, { 'is-selected': state === status }]"
              @click="state = status"
            >
              <span class="qd-card-label"><span class="qd-dot" />{{ status }}</span
              ><strong>{{ counts[status]?.toLocaleString() ?? '—' }}</strong
              ><span class="qd-card-caption">{{
                status === 'completed' || status === 'failed' ? 'Retained jobs' : 'Current jobs'
              }}</span>
            </button>
          </section>
          <section class="qd-jobs" aria-labelledby="jobs-title">
            <div class="qd-jobs-heading">
              <h2 id="jobs-title">Jobs</h2>
              <span class="qd-muted" aria-live="polite">{{
                updatedAt ? `Updated ${updatedAt}` : 'Waiting for data'
              }}</span>
            </div>
            <div class="qd-toolbar">
              <TabsRoot v-model="state"
                ><TabsList class="qd-tabs" aria-label="Filter by job state"
                  ><TabsTrigger
                    v-for="status in statuses"
                    :key="status"
                    :value="status"
                    class="qd-tab"
                    >{{ status }}</TabsTrigger
                  ></TabsList
                ></TabsRoot
              >
              <form class="qd-lookup" @submit.prevent="openJob(lookupId)">
                <input
                  v-model="lookupId"
                  class="qd-input"
                  aria-label="Find job by ID"
                  placeholder="Find job by ID"
                  maxlength="255"
                /><button class="qd-button" :disabled="!lookupId || !queue">Find</button>
              </form>
            </div>
            <div class="qd-table-wrap" :aria-busy="loading">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>State</th>
                    <th>Retries recorded</th>
                    <th>Dispatched</th>
                    <th><span class="qd-sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="job in page.items" :key="job.ref.id">
                    <td>
                      <strong>{{ job.name }}</strong
                      ><code>{{ job.ref.id }}</code>
                    </td>
                    <td>
                      <span :class="['qd-state', `qd-${job.state}`]">{{ job.state }}</span>
                    </td>
                    <td>{{ job.attemptsRecorded }}</td>
                    <td class="qd-muted">
                      {{ job.dispatchedAt ? new Date(job.dispatchedAt).toLocaleString() : '—' }}
                    </td>
                    <td>
                      <button
                        class="qd-text-button"
                        :aria-label="`View ${job.name} ${job.ref.id}`"
                        @click="openJob(job.ref.id)"
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!page.items.length" class="qd-empty">
                <span class="qd-empty-icon">≡</span>
                <h3>
                  {{
                    unsupported
                      ? 'Listing unavailable'
                      : initialLoading
                        ? 'Loading jobs…'
                        : `No ${state} jobs on this page`
                  }}
                </h3>
                <p>
                  {{
                    unsupported ||
                    'Only jobs still stored in this queue are visible. Completed and failed jobs require a retention policy.'
                  }}
                </p>
              </div>
            </div>
            <footer class="qd-pagination">
              <span class="qd-muted">Page {{ cursors.length }} · Live data</span>
              <div>
                <button
                  class="qd-button"
                  :disabled="cursors.length === 1 || loading"
                  @click="previousPage"
                >
                  ← Previous</button
                ><button
                  class="qd-button"
                  :disabled="!page.nextCursor || loading"
                  @click="nextPage"
                >
                  Next →
                </button>
              </div>
            </footer>
          </section>
        </template>
        <p class="qd-footnote">
          Polling every {{ (metadata?.pollIntervalMs ?? 5000) / 1000 }}s while this page is visible.
          No historical storage is required.
        </p>
      </div>
    </main>
  </div>
  <div id="queue-dashboard-portals" />
  <DialogRoot v-model:open="detailOpen"
    ><DialogPortal to="#queue-dashboard-portals"
      ><DialogOverlay class="qd-dialog-overlay" /><DialogContent class="qd-dialog">
        <div class="qd-dialog-heading">
          <DialogTitle>Job details</DialogTitle
          ><DialogClose class="qd-button" aria-label="Close job details">✕</DialogClose>
        </div>
        <DialogDescription class="qd-muted"
          >Current retained record. Sensitive content is hidden according to the host
          policy.</DialogDescription
        >
        <p v-if="detailLoading" role="status">Loading job…</p>
        <p v-if="detailError" role="alert" class="qd-alert">{{ detailError }}</p>
        <template v-if="selected"
          ><h3>{{ selected.name }}</h3>
          <dl class="qd-detail-list">
            <dt>ID</dt>
            <dd>
              <code>{{ selected.ref.id }}</code>
            </dd>
            <dt>Queue</dt>
            <dd>{{ selected.ref.queue }}</dd>
            <dt>State</dt>
            <dd>{{ selected.state }}</dd>
            <dt>Retries recorded</dt>
            <dd>{{ selected.attemptsRecorded }}</dd>
            <dt>Finished</dt>
            <dd>
              {{ selected.finishedAt ? new Date(selected.finishedAt).toLocaleString() : '—' }}
            </dd>
          </dl>
          <template v-if="selected.errorMessage"
            ><h4>Error</h4>
            <pre>{{ selected.errorMessage }}</pre></template
          ><template v-if="selected.payload !== undefined"
            ><h4>Payload</h4>
            <pre>{{ JSON.stringify(selected.payload, null, 2) }}</pre>
          </template>
          <p v-else class="qd-muted">Payload hidden by the host.</p></template
        >
      </DialogContent></DialogPortal
    ></DialogRoot
  >
</template>
