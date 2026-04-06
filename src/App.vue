<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SnapControlPanel from './components/SnapControlPanel.vue'
import SnapScatterView from './components/SnapScatterView.vue'
import { buildGraph, dataAssetUrl, DATASETS, EDGE_RENDER_LIMIT, fetchGzipText } from './utils/snapData'

const CUSTOM_DATASET_KEY = '__custom__'

/** Public GitHub URL for the full reference implementation (e.g. C++ / paper codebase). Set via Vite or edit here. */
const fullImplementationGithubUrl =
  import.meta.env.VITE_FULL_IMPLEMENTATION_GITHUB || 'https://github.com/AnonymousUser202604/SNAP-tFDP'

const SLOT_EMPTY = 0
const SLOT_FULL = 1
const SLOT_STOP = 2
const CMD_RUN = 0
const CMD_PAUSE = 1
const CMD_STOP = 2
const supportsSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'

const selectedName = ref('aircraft')
/** When using uploads: { label, edgeText, attrText, pmdsText } */
const customBundle = ref(null)
const paramK = ref(3)
const paramEpoch = ref(50)
const statusText = ref('Loading PMDS preview...')
const isLoaded = ref(false)
const layoutPhase = ref('idle')
const stats = ref({ nodes: 0, edges: 0 })
const graphState = ref(null)
const renderRequest = ref({ revision: 0, includeEdges: false, reason: 'idle' })
const renderBusy = ref(false)
const renderProgress = ref({ phase: 'idle', completed: 0, total: 0, reason: 'idle' })

const isRunning = computed(() => layoutPhase.value === 'running')
const datasetDisabled = computed(() => renderBusy.value)
const paramsDisabled = computed(() => layoutPhase.value === 'running' || layoutPhase.value === 'paused' || renderBusy.value)
const resetDisabled = computed(() => !isLoaded.value || renderBusy.value)
const statusType = computed(() => {
  if (renderBusy.value) return 'warning'
  if (layoutPhase.value === 'running') return 'warning'
  if (layoutPhase.value === 'paused') return 'info'
  if (isLoaded.value) return 'success'
  return 'info'
})
const actionLabel = computed(() => {
  if (layoutPhase.value === 'running') return 'Pause'
  if (layoutPhase.value === 'paused') return 'Resume'
  if (layoutPhase.value === 'finished') return 'Finished'
  return 'Run'
})
const actionDisabled = computed(() => !isLoaded.value || layoutPhase.value === 'finished' || renderBusy.value)

const datasetsForSelect = computed(() => {
  const list = DATASETS.map((d) => ({ ...d }))
  if (customBundle.value) {
    list.push({
      name: CUSTOM_DATASET_KEY,
      label: `Custom: ${customBundle.value.label}`,
    })
  }
  return list
})

const datasetDisplayName = computed(() => {
  if (selectedName.value === CUSTOM_DATASET_KEY && customBundle.value) return customBundle.value.label
  return selectedName.value
})

let worker = null
let controlState = null
let lastWorkerCommand = CMD_RUN

onMounted(async () => {
  worker = new Worker(new URL('./workers/snapLayout.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = handleWorkerMessage
  await loadDataset(selectedName.value)
})

onBeforeUnmount(() => {
  stopWorker(true)
  if (worker) worker.terminate()
})

watch(selectedName, async (value) => {
  await loadDataset(value)
})

async function loadDataset(name) {
  if (!name) return
  stopWorker(true)
  graphState.value = null
  requestRender(false, 'clear')
  isLoaded.value = false
  layoutPhase.value = 'idle'
  statusText.value = 'Loading'
  renderBusy.value = false
  renderProgress.value = { phase: 'idle', completed: 0, total: 0, reason: 'dataset' }
  stats.value = { nodes: 0, edges: 0 }

  try {
    if (name === CUSTOM_DATASET_KEY) {
      const bundle = customBundle.value
      if (!bundle?.edgeText) {
        statusText.value = 'No custom graph file'
        return
      }
      const graph = buildGraph(bundle.edgeText, bundle.attrText, bundle.pmdsText, bundle.label, {
        edgeFormat: bundle.edgeFormat === 'mtx' ? 'mtx' : 'snap',
      })
      graphState.value = graph
      requestRender(graph.edgeCount < EDGE_RENDER_LIMIT, 'dataset')
      stats.value = { nodes: graph.nodeCount, edges: graph.edgeCount }
      isLoaded.value = true
      statusText.value = 'Ready'
      return
    }

    const [edgeText, attrText, pmdsText] = await Promise.all([
      fetchGzipText(dataAssetUrl(`data/${name}.txt.gz`)),
      fetchGzipText(dataAssetUrl(`data/${name}.attr.gz`)),
      fetchGzipText(dataAssetUrl(`data/PMDS_init/${name}.txt.gz`)),
    ])
    const graph = buildGraph(edgeText, attrText, pmdsText, name)
    graphState.value = graph
    requestRender(graph.edgeCount < EDGE_RENDER_LIMIT, 'dataset')
    stats.value = { nodes: graph.nodeCount, edges: graph.edgeCount }
    isLoaded.value = true
    statusText.value = 'Ready'
  } catch (error) {
    console.error(error)
    graphState.value = null
    stats.value = { nodes: 0, edges: 0 }
    statusText.value = name === CUSTOM_DATASET_KEY ? 'Failed to load custom data' : `Failed to load ${name}`
  }
}

async function applyCustomUpload(payload) {
  customBundle.value = {
    label: payload.label,
    edgeText: payload.edgeText,
    attrText: payload.attrText ?? '',
    pmdsText: payload.pmdsText ?? '',
    edgeFormat: payload.edgeFormat === 'mtx' ? 'mtx' : 'snap',
  }
  if (selectedName.value === CUSTOM_DATASET_KEY) {
    await loadDataset(CUSTOM_DATASET_KEY)
  } else {
    selectedName.value = CUSTOM_DATASET_KEY
  }
}

function handleAction() {
  if (renderBusy.value) return
  if (layoutPhase.value === 'idle') {
    startLayout()
    return
  }
  if (layoutPhase.value === 'running') {
    pauseLayout()
    return
  }
  if (layoutPhase.value === 'paused') {
    resumeLayout()
  }
}

function startLayout() {
  const graph = graphState.value
  if (!graph || !worker || !isLoaded.value || layoutPhase.value !== 'idle' || renderBusy.value) return

  if (supportsSharedArrayBuffer) {
    controlState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2))
    controlState[0] = SLOT_EMPTY
    controlState[1] = CMD_RUN
  } else {
    controlState = { fallback: true }
  }

  lastWorkerCommand = CMD_RUN
  layoutPhase.value = 'running'
  statusText.value = `Running: 0 / ${paramEpoch.value}`
  requestRender(false, 'running')

  worker.postMessage({
    type: 'start',
    payload: {
      posXBuffer: graph.posX.buffer,
      posYBuffer: graph.posY.buffer,
      sources: graph.sources,
      targets: graph.targets,
      k: Math.max(1, Number(paramK.value) || 1),
      nEpoch: Math.max(1, Number(paramEpoch.value) || 1),
      nodeCount: graph.nodeCount,
      seed: 42,
      controlBuffer: supportsSharedArrayBuffer ? controlState.buffer : null,
      useSharedControl: supportsSharedArrayBuffer,
    },
  })
}

function pauseLayout() {
  if (!controlState || layoutPhase.value !== 'running' || renderBusy.value) return
  lastWorkerCommand = CMD_PAUSE
  if (supportsSharedArrayBuffer) {
    Atomics.store(controlState, 1, CMD_PAUSE)
    Atomics.notify(controlState, 1)
  } else {
    worker?.postMessage({ type: 'command', payload: { command: 'pause' } })
  }
  layoutPhase.value = 'paused'
  statusText.value = 'Paused'
  const graph = graphState.value
  requestRender(Boolean(graph && graph.edgeCount < EDGE_RENDER_LIMIT), 'paused')
}

function resumeLayout() {
  if (!controlState || layoutPhase.value !== 'paused' || renderBusy.value) return
  lastWorkerCommand = CMD_RUN
  if (supportsSharedArrayBuffer) {
    Atomics.store(controlState, 1, CMD_RUN)
    Atomics.notify(controlState, 1)
  } else {
    worker?.postMessage({ type: 'command', payload: { command: 'resume' } })
  }
  layoutPhase.value = 'running'
  statusText.value = 'Running layout...'
  requestRender(false, 'running')
}

function resetToPMDS() {
  const graph = graphState.value
  if (!graph || renderBusy.value) return
  stopWorker(true)
  graph.posX.set(graph.initX)
  graph.posY.set(graph.initY)
  requestRender(graph.edgeCount < EDGE_RENDER_LIMIT, 'reset')
  layoutPhase.value = 'idle'
  statusText.value = 'Reset'
}

function stopWorker(resetPhase = false) {
  if (controlState && supportsSharedArrayBuffer) {
    Atomics.store(controlState, 0, SLOT_STOP)
    Atomics.store(controlState, 1, CMD_STOP)
    Atomics.notify(controlState, 0)
    Atomics.notify(controlState, 1)
  }
  controlState = null
  lastWorkerCommand = CMD_STOP
  if (worker) worker.postMessage({ type: 'stop' })
  if (resetPhase) layoutPhase.value = 'idle'
}

function handleWorkerMessage(event) {
  const graph = graphState.value
  if (!graph || !controlState) return
  const { type, payload } = event.data
  if (type !== 'progress' && type !== 'done') return

  if (!supportsSharedArrayBuffer && payload?.posX && payload?.posY) {
    graph.posX.set(payload.posX)
    graph.posY.set(payload.posY)
  }

  if (supportsSharedArrayBuffer) {
    if (Atomics.load(controlState, 0) !== SLOT_FULL) return
    Atomics.store(controlState, 0, SLOT_EMPTY)
    Atomics.notify(controlState, 0)
  } else {
    if (type === 'progress' && lastWorkerCommand !== CMD_RUN) return
  }

  statusText.value = `${type === 'done' ? 'Finished' : 'Running:'} ${payload.epoch} / ${payload.nEpoch}`
  requestRender(type === 'done' || layoutPhase.value === 'paused' ? graph.edgeCount < EDGE_RENDER_LIMIT : false, type === 'done' ? 'finished' : layoutPhase.value)

  if (type === 'done') {
    layoutPhase.value = 'finished'
  }
}

function requestRender(includeEdges, reason) {
  renderRequest.value = {
    revision: renderRequest.value.revision + 1,
    includeEdges,
    reason,
  }
}

function handleRenderState(payload) {
  renderBusy.value = payload.busy
  renderProgress.value = payload
}
</script>

<template>
  <div class="app-shell">
    <header class="hero-bar">
      <h1>SNAP-tFDP: Massively Scalable Graph Layouts via Sparse Negative Sampling</h1>
      <p class="hero-note">
        This online demo is implemented using JavaScript; its performance is limited compared to the native C++ implementation. The <strong>native implementation</strong> from the paper can be found in the <a :href="fullImplementationGithubUrl" target="_blank" rel="noopener noreferrer">GitHub</a> repository.
      </p>
    </header>

    <main class="workspace">
      <SnapControlPanel
        :datasets="datasetsForSelect"
        :dataset-display-name="datasetDisplayName"
        :selected-name="selectedName"
        :param-k="paramK"
        :param-epoch="paramEpoch"
        :stats="stats"
        :status-text="statusText"
        :status-type="statusType"
        :is-loaded="isLoaded"
        :params-disabled="paramsDisabled"
        :dataset-disabled="datasetDisabled"
        :reset-disabled="resetDisabled"
        :action-label="actionLabel"
        :action-disabled="actionDisabled"
        @update:selected-name="selectedName = $event"
        @update:param-k="paramK = Number($event || 1)"
        @update:param-epoch="paramEpoch = Number($event || 1)"
        @apply-custom="applyCustomUpload"
        @action="handleAction"
        @reset="resetToPMDS"
      />

      <SnapScatterView
        :graph-data="graphState"
        :render-request="renderRequest"
        :render-busy="renderBusy"
        :render-progress="renderProgress"
        :is-loaded="isLoaded"
        :is-running="isRunning"
        @render-state="handleRenderState"
      />
    </main>
  </div>
</template>
