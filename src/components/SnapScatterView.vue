<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'

const props = defineProps({
  graphData: { type: Object, default: null },
  renderRequest: { type: Object, required: true },
  renderBusy: { type: Boolean, required: true },
  renderProgress: { type: Object, required: true },
  isLoaded: { type: Boolean, required: true },
  isRunning: { type: Boolean, required: true },
})

const emit = defineEmits(['render-state'])

const chartEl = ref(null)

let renderWorker = null
let resizeObserver = null
let edgeCanvas = null
let pointCanvas = null
let lastGraphKey = ''

onMounted(async () => {
  await nextTick()

  edgeCanvas = document.createElement('canvas')
  edgeCanvas.className = 'edge-layer'
  edgeCanvas.style.width = '100%'
  edgeCanvas.style.height = '100%'
  edgeCanvas.style.display = 'block'

  pointCanvas = document.createElement('canvas')
  pointCanvas.className = 'point-layer'
  pointCanvas.style.width = '100%'
  pointCanvas.style.height = '100%'
  pointCanvas.style.display = 'block'

  chartEl.value.appendChild(edgeCanvas)
  chartEl.value.appendChild(pointCanvas)

  const edgeOffscreen = edgeCanvas.transferControlToOffscreen()
  const pointOffscreen = pointCanvas.transferControlToOffscreen()

  renderWorker = new Worker(new URL('../workers/pixiRender.worker.js', import.meta.url), { type: 'module' })
  renderWorker.onmessage = (event) => {
    if (event.data?.type === 'state') emit('render-state', event.data.payload)
  }
  renderWorker.postMessage({
    type: 'init',
    payload: {
      edgeCanvas: edgeOffscreen,
      pointCanvas: pointOffscreen,
      width: Math.max(chartEl.value.clientWidth, 1),
      height: Math.max(chartEl.value.clientHeight, 1),
    },
  }, [edgeOffscreen, pointOffscreen])

  resizeObserver = new ResizeObserver(() => {
    renderWorker?.postMessage({
      type: 'resize',
      payload: {
        width: Math.max(chartEl.value.clientWidth, 1),
        height: Math.max(chartEl.value.clientHeight, 1),
      },
    })
  })
  resizeObserver.observe(chartEl.value)
  pushGraphData()
  pushRenderRequest()
})

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect()
  if (renderWorker) renderWorker.terminate()
})

watch(() => props.graphData, pushGraphData)
watch(() => props.renderRequest.revision, pushRenderRequest)

function pushGraphData() {
  if (!renderWorker) return
  if (!props.graphData) {
    lastGraphKey = ''
    renderWorker.postMessage({ type: 'clear' })
    return
  }

  const raw = toRaw(props.graphData)
  lastGraphKey = raw.name
  renderWorker.postMessage({
    type: 'graph',
    payload: {
      datasetKey: raw.name,
      nodeCount: raw.nodeCount,
      edgeCount: raw.edgeCount,
      posXBuffer: raw.posX.buffer,
      posYBuffer: raw.posY.buffer,
      renderColorsBuffer: raw.renderColors.buffer,
      sourcesBuffer: raw.sources.buffer,
      targetsBuffer: raw.targets.buffer,
      sourceOffset: raw.sources.byteOffset,
      targetOffset: raw.targets.byteOffset,
      sourceLength: raw.sources.length,
      targetLength: raw.targets.length,
      includeEdges: props.renderRequest.includeEdges,
      reason: props.renderRequest.reason,
    },
  })
}

function pushRenderRequest() {
  if (!renderWorker) return
  renderWorker.postMessage({
    type: 'render',
    payload: {
      revision: props.renderRequest.revision,
      includeEdges: props.renderRequest.includeEdges,
      reason: props.renderRequest.reason,
      datasetKey: lastGraphKey,
    },
  })
}
</script>

<template>
  <section class="stage-panel">
    <el-card class="chart-card canvas-card" shadow="never">
      <div ref="chartEl" class="chart-surface chart-stack"></div>
    </el-card>
  </section>
</template>

<style scoped>
.chart-stack {
  position: relative;
  overflow: hidden;
}

:deep(.edge-layer),
:deep(.point-layer) {
  position: absolute;
  inset: 0;
}

:deep(.edge-layer) {
  z-index: 1;
}

:deep(.point-layer) {
  z-index: 2;
}
</style>
