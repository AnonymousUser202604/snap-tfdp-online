<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SnapControlPanel from './components/SnapControlPanel.vue'
import SnapScatterView from './components/SnapScatterView.vue'
import { buildGraph, dataAssetUrl, DATASETS, EDGE_RENDER_LIMIT, fetchGzipText } from './utils/snapData'

const CUSTOM_DATASET_KEY = '__custom__'

/** Public GitHub URL for the full reference implementation (e.g. C++ / paper codebase). Set via Vite or edit here. */
const fullImplementationGithubUrl =
  import.meta.env.VITE_FULL_IMPLEMENTATION_GITHUB || 'https://github.com/AnonymousUser202604/SNAP-tFDP'

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
let waitingForRenderCommit = false

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

  controlState = { active: true }
  waitingForRenderCommit = false
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
    },
  })
}

function pauseLayout() {
  if (!controlState || layoutPhase.value !== 'running' || renderBusy.value) return
  worker?.postMessage({ type: 'command', payload: { command: 'pause' } })
  waitingForRenderCommit = false
  layoutPhase.value = 'paused'
  statusText.value = 'Paused'
  const graph = graphState.value
  requestRender(Boolean(graph && graph.edgeCount < EDGE_RENDER_LIMIT), 'paused')
}

function resumeLayout() {
  if (!controlState || layoutPhase.value !== 'paused' || renderBusy.value) return
  waitingForRenderCommit = false
  layoutPhase.value = 'running'
  statusText.value = 'Running layout...'
  worker?.postMessage({ type: 'command', payload: { command: 'step' } })
}

function resetToPMDS() {
  const graph = graphState.value
  if (!graph || renderBusy.value) return
  stopWorker(true)
  graph.posX.set(graph.initX)
  graph.posY.set(graph.initY)
  graphState.value = { ...graph }
  requestRender(graph.edgeCount < EDGE_RENDER_LIMIT, 'reset')
  layoutPhase.value = 'idle'
  statusText.value = 'Reset'
}

function stopWorker(resetPhase = false) {
  waitingForRenderCommit = false
  controlState = null
  if (worker) worker.postMessage({ type: 'stop' })
  if (resetPhase) layoutPhase.value = 'idle'
}

function handleWorkerMessage(event) {
  const graph = graphState.value
  if (!graph || !controlState) return
  const { type, payload } = event.data
  if (type !== 'progress' && type !== 'done') return

  if (payload?.posX && payload?.posY) {
    graph.posX.set(payload.posX)
    graph.posY.set(payload.posY)
    graphState.value = { ...graph }
  }

  statusText.value = `${type === 'done' ? 'Finished' : 'Running:'} ${payload.epoch} / ${payload.nEpoch}`
  waitingForRenderCommit = type !== 'done'
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

  if (!payload.busy && waitingForRenderCommit && layoutPhase.value === 'running') {
    waitingForRenderCommit = false
    worker?.postMessage({ type: 'command', payload: { command: 'step' } })
  }
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
