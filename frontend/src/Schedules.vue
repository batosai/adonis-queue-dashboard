<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'reka-ui'
import type { ReaderCapabilities, Result, SafeSchedule, SchedulePage } from '../../src/types'
const props = defineProps<{
  prefix: string
  adapter: string
  capabilities: ReaderCapabilities
  pollIntervalMs: number
  maxPageSize: number
}>()
const status = ref('')
const page = ref<SchedulePage>({ items: [], consistency: 'live' })
const cursors = ref<(string | undefined)[]>([undefined])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const unsupported = ref('')
const updatedAt = ref('')
const now = ref(Date.now())
const lookupId = ref('')
const selected = ref<SafeSchedule | null>(null)
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const nextCursor = computed(() => page.value.nextCursor)
let controller: AbortController | undefined
let detailController: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let countdownTimer: ReturnType<typeof setInterval> | undefined
let stopped = false
let failures = 0
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : '—')
function nextRun(value: string | null) {
  const target = value ? new Date(value).getTime() : Number.NaN
  if (!Number.isFinite(target)) return 'No next run scheduled'
  const difference = target - now.value
  const seconds = difference > 0 ? Math.ceil(difference / 1000) : Math.floor(-difference / 1000)
  if (seconds === 0) return 'Due now'
  const duration = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor((seconds % 86400) / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
    [seconds % 60, 's'],
  ]
    .filter(([amount]) => amount !== 0)
    .map(([amount, unit]) => `${amount}${unit}`)
    .join(' ')
  return difference > 0 ? `In ${duration}` : `Overdue by ${duration}`
}
const timing = (item: SafeSchedule) =>
  item.cronExpression ?? (item.everyMs === null ? '—' : `Every ${item.everyMs / 1000}s`)
async function api<T>(
  endpoint: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `${props.prefix}/api/${endpoint}?${new URLSearchParams({ adapter: props.adapter, ...params })}`,
    {
      credentials: 'same-origin',
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    },
  )
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Access denied. Sign in with an authorized account.'
        : 'Unable to read schedules. Please try again.',
    )
  return response.json()
}
function report(caught: unknown) {
  return caught instanceof Error ? caught.message : 'Unable to read schedules.'
}
function aborted(caught: unknown) {
  return caught instanceof DOMException && caught.name === 'AbortError'
}
async function refresh() {
  if (!props.capabilities.listSchedules) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const cursor = cursors.value.at(-1)
    const result = await api<Result<SchedulePage>>(
      'schedules',
      {
        limit: String(props.maxPageSize),
        ...(status.value ? { status: status.value } : {}),
        ...(cursor ? { cursor } : {}),
      },
      current.signal,
    )
    if (current.signal.aborted) return
    page.value = result.kind === 'available' ? result.value : { items: [], consistency: 'live' }
    unsupported.value = result.kind === 'unsupported' ? result.reason : ''
    loaded.value = true
    updatedAt.value = new Date().toLocaleTimeString()
    error.value = ''
    failures = 0
  } catch (caught) {
    if (!aborted(caught)) {
      error.value = report(caught)
      failures++
    }
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}
async function openSchedule(id: string) {
  if (!props.capabilities.getSchedule || !id) return
  detailController?.abort()
  const current = new AbortController()
  detailController = current
  selected.value = null
  detailError.value = ''
  detailLoading.value = true
  detailOpen.value = true
  try {
    const result = await api<Result<SafeSchedule | null>>('schedule', { id }, current.signal)
    if (current.signal.aborted) return
    if (result.kind === 'unsupported') detailError.value = result.reason
    else if (!result.value)
      detailError.value = 'This schedule is no longer stored, or its ID is unknown.'
    else selected.value = result.value
  } catch (caught) {
    if (!aborted(caught)) detailError.value = report(caught)
  } finally {
    if (!current.signal.aborted) detailLoading.value = false
  }
}
function poll() {
  if (stopped) return
  timer = setTimeout(
    async () => {
      if (!document.hidden && !loading.value) await refresh()
      poll()
    },
    Math.min(60000, props.pollIntervalMs * 2 ** Math.min(failures, 4)),
  )
}
function next() {
  if (nextCursor.value) {
    cursors.value = [...cursors.value, nextCursor.value]
    refresh()
  }
}
function previous() {
  cursors.value = cursors.value.slice(0, -1)
  refresh()
}
watch(status, () => {
  cursors.value = [undefined]
  page.value = { items: [], consistency: 'live' }
  loaded.value = false
  refresh()
})
onMounted(() => {
  now.value = Date.now()
  countdownTimer = setInterval(() => {
    if (!document.hidden) now.value = Date.now()
  }, 1000)
  refresh()
  poll()
})
onUnmounted(() => {
  stopped = true
  clearTimeout(timer)
  clearInterval(countdownTimer)
  controller?.abort()
  detailController?.abort()
})
</script>

<template>
  <div class="qd-title-row">
    <div>
      <p class="qd-eyebrow">Recurring jobs</p>
      <h1>Schedules</h1>
      <p class="qd-subtitle">
        Schedules stored on this adapter. Recorded runs do not indicate successful job execution.
      </p>
    </div>
    <button class="qd-button" :disabled="loading || !capabilities.listSchedules" @click="refresh">
      {{ loading ? 'Refreshing…' : '↻ Refresh' }}
    </button>
  </div>
  <div v-if="error" class="qd-alert" role="alert">{{ error }}</div>
  <div v-if="capabilities.schedulesReason" class="qd-notice">
    {{ capabilities.schedulesReason }}
  </div>
  <section class="qd-jobs" aria-labelledby="schedules-title">
    <div class="qd-jobs-heading">
      <h2 id="schedules-title">Schedules</h2>
      <span class="qd-muted" aria-live="polite">{{
        updatedAt ? `Updated ${updatedAt}` : 'Waiting for data'
      }}</span>
    </div>
    <div class="qd-toolbar">
      <div class="qd-schedule-filter">
        <label class="qd-label" for="schedule-status">Status</label>
        <select
          id="schedule-status"
          v-model="status"
          class="qd-select"
          :disabled="!capabilities.listSchedules"
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </select>
      </div>
      <form class="qd-lookup" @submit.prevent="openSchedule(lookupId)">
        <input
          v-model="lookupId"
          class="qd-input"
          aria-label="Find schedule by ID"
          placeholder="Find schedule by ID"
          maxlength="255"
        /><button class="qd-button" :disabled="!lookupId || !capabilities.getSchedule">Find</button>
      </form>
    </div>
    <div class="qd-table-wrap" :aria-busy="loading">
      <table>
        <thead>
          <tr>
            <th>Job / ID</th>
            <th>Timing</th>
            <th>Timezone</th>
            <th>Status</th>
            <th>Next run</th>
            <th>Runs recorded</th>
            <th><span class="qd-sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in page.items" :key="item.ref.id">
            <td>
              <strong>{{ item.name }}</strong
              ><code>{{ item.ref.id }}</code>
            </td>
            <td>{{ timing(item) }}</td>
            <td>{{ item.timezone }}</td>
            <td>
              <span class="qd-state">{{ item.status }}</span>
            </td>
            <td>
              <span :title="item.nextRunAt ? date(item.nextRunAt) : undefined">{{
                nextRun(item.nextRunAt)
              }}</span>
            </td>
            <td>{{ item.runCount }}{{ item.limit === null ? '' : ` / ${item.limit}` }}</td>
            <td>
              <button
                class="qd-text-button"
                :aria-label="`View schedule ${item.ref.id}`"
                @click="openSchedule(item.ref.id)"
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
            !capabilities.listSchedules || unsupported
              ? 'Listing unavailable'
              : loading && !loaded
                ? 'Loading schedules…'
                : 'No schedules on this page'
          }}
        </h3>
        <p>
          {{
            unsupported ||
            capabilities.schedulesReason ||
            'Live pages can be empty after filtering or when schedules disappear. Continue to the next page when available.'
          }}
        </p>
      </div>
    </div>
    <footer class="qd-pagination">
      <span class="qd-muted">Page {{ cursors.length }} · Live data</span>
      <div>
        <button class="qd-button" :disabled="cursors.length === 1 || loading" @click="previous">
          ← Previous</button
        ><button class="qd-button" :disabled="!nextCursor || loading" @click="next">Next →</button>
      </div>
    </footer>
  </section>
  <DialogRoot v-model:open="detailOpen"
    ><DialogPortal to="#queue-dashboard-portals"
      ><DialogOverlay class="qd-dialog-overlay" /><DialogContent class="qd-dialog">
        <div class="qd-dialog-heading">
          <DialogTitle>Schedule details</DialogTitle
          ><DialogClose class="qd-button" aria-label="Close schedule details">✕</DialogClose>
        </div>
        <DialogDescription class="qd-muted"
          >Current persisted schedule. Runs and last run reflect scheduler activity, not job
          outcomes.</DialogDescription
        >
        <p v-if="detailLoading" role="status">Loading schedule…</p>
        <p v-if="detailError" class="qd-alert" role="alert">{{ detailError }}</p>
        <template v-if="selected"
          ><h3>{{ selected.name }}</h3>
          <dl class="qd-detail-list">
            <dt>ID</dt>
            <dd>
              <code>{{ selected.ref.id }}</code>
            </dd>
            <dt>Adapter</dt>
            <dd>{{ selected.ref.adapter }}</dd>
            <dt>Status</dt>
            <dd>{{ selected.status }}</dd>
            <dt>Timing</dt>
            <dd>{{ timing(selected) }}</dd>
            <dt>Timezone</dt>
            <dd>{{ selected.timezone }}</dd>
            <dt>Runs recorded</dt>
            <dd>{{ selected.runCount }}</dd>
            <dt>Run limit</dt>
            <dd>{{ selected.limit ?? 'Unlimited' }}</dd>
            <dt>Next run</dt>
            <dd>
              <span :title="selected.nextRunAt ? date(selected.nextRunAt) : undefined">{{
                nextRun(selected.nextRunAt)
              }}</span
              ><small v-if="selected.nextRunAt" class="qd-muted">
                · {{ date(selected.nextRunAt) }}</small
              >
            </dd>
            <dt>Last claimed</dt>
            <dd>{{ date(selected.lastRunAt) }}</dd>
            <dt>From</dt>
            <dd>{{ date(selected.from) }}</dd>
            <dt>Until</dt>
            <dd>{{ date(selected.to) }}</dd>
            <dt>Created</dt>
            <dd>{{ date(selected.createdAt) }}</dd>
          </dl>
          <template v-if="selected.payload !== undefined"
            ><h4>Payload</h4>
            <pre>{{ JSON.stringify(selected.payload, null, 2) }}</pre>
          </template>
          <p v-else class="qd-muted">Payload hidden by the host.</p></template
        >
      </DialogContent></DialogPortal
    ></DialogRoot
  >
</template>
