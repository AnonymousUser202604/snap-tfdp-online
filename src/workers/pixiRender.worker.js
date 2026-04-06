import { EDGE_RENDER_LIMIT } from '../utils/snapData'

const BASE_POINT_SIZE = 64
const PAD = 16
const FALLBACK_POINT_COLOR = 0x98a2b3
const POINT_BATCH_SIZE = 10000
const EDGE_BATCH_SIZE = 1000
const BACKGROUND_COLOR = '#f8fafc'
const pointTextureCanvas = new OffscreenCanvas(BASE_POINT_SIZE, BASE_POINT_SIZE)
const pointTextureContext = pointTextureCanvas.getContext('2d')
pointTextureContext.fillStyle = '#ffffff'
pointTextureContext.beginPath()
pointTextureContext.arc(BASE_POINT_SIZE / 2, BASE_POINT_SIZE / 2, BASE_POINT_SIZE / 2, 0, Math.PI * 2)
pointTextureContext.fill()

let edgeCanvas = null
let pointCanvas = null
let edgeContext = null
let pointContext = null
let width = 1
let height = 1
let graph = null
let renderToken = 0
let activeJob = null
const tintCache = new Map()

self.onmessage = (event) => {
  const { type, payload } = event.data

  if (type === 'init') {
    edgeCanvas = payload.edgeCanvas
    pointCanvas = payload.pointCanvas
    edgeContext = edgeCanvas.getContext('2d', { alpha: false, desynchronized: true })
    pointContext = pointCanvas.getContext('2d', { alpha: true, desynchronized: true })
    width = payload.width
    height = payload.height
    resizeCanvases()
    drawEmpty()
  }

  if (type === 'resize') {
    width = Math.max(payload.width, 1)
    height = Math.max(payload.height, 1)
    resizeCanvases()
    if (activeJob) startRender(activeJob.includeEdges, activeJob.reason)
  }

  if (type === 'clear') {
    renderToken += 1
    graph = null
    activeJob = null
    drawEmpty()
    postState(false, 'idle', 0, 0, 'clear')
  }

  if (type === 'graph') {
    renderToken += 1
    graph = {
      datasetKey: payload.datasetKey,
      nodeCount: payload.nodeCount,
      edgeCount: payload.edgeCount,
      posX: new Float32Array(payload.posXBuffer),
      posY: new Float32Array(payload.posYBuffer),
      renderColors: new Uint32Array(payload.renderColorsBuffer),
      sources: new Uint32Array(payload.sourcesBuffer, payload.sourceOffset, payload.sourceLength),
      targets: new Uint32Array(payload.targetsBuffer, payload.targetOffset, payload.targetLength),
    }
    activeJob = null
    clearEdgeSurface()
    clearPointSurface()
    postState(false, 'idle', 0, 0, 'graph')
    startRender(payload.includeEdges, payload.reason)
  }

  if (type === 'render') {
    if (payload.datasetKey && graph && payload.datasetKey !== graph.datasetKey) return
    startRender(payload.includeEdges, payload.reason)
  }
}

function startRender(includeEdges, reason) {
  renderToken += 1
  const token = renderToken
  const allowEdges = includeEdges && graph && graph.edgeCount < EDGE_RENDER_LIMIT
  activeJob = { includeEdges: allowEdges, reason, token }

  if (!edgeContext || !pointContext || !graph) {
    drawEmpty()
    postState(false, 'idle', 0, 0, reason)
    return
  }

  const metrics = buildMetrics(graph.nodeCount)
  const bounds = getBounds(graph.posX, graph.posY)
  clearEdgeSurface()
  clearPointSurface()

  const edgeTotal = allowEdges ? Math.floor(graph.sources.length / 2) : 0
  const total = graph.nodeCount + edgeTotal

  postState(true, 'points', 0, total, reason)
  queueMicrotask(() => renderPointsBatch(token, 0, bounds, metrics, reason, total, 0, allowEdges))
}

function renderEdgesBatch(token, startEdgeIndex, bounds, metrics, reason, total, completedBase = 0) {
  if (token !== renderToken || !graph || !edgeContext) return

  const edgePairs = Math.floor(graph.sources.length / 2)
  const endEdgeIndex = Math.min(startEdgeIndex + EDGE_BATCH_SIZE, edgePairs)
  edgeContext.strokeStyle = 'rgba(128,128,128,0.1)'
  edgeContext.lineWidth = metrics.edgeWidth
  edgeContext.beginPath()

  for (let edgeIdx = startEdgeIndex; edgeIdx < endEdgeIndex; edgeIdx += 1) {
    const i = edgeIdx * 2
    const source = graph.sources[i]
    const target = graph.targets[i]
    const x1 = metrics.offsetX + ((graph.posX[source] - bounds.minX) / bounds.span) * metrics.plotSize
    const y1 = metrics.offsetY + ((graph.posY[source] - bounds.minY) / bounds.span) * metrics.plotSize
    const x2 = metrics.offsetX + ((graph.posX[target] - bounds.minX) / bounds.span) * metrics.plotSize
    const y2 = metrics.offsetY + ((graph.posY[target] - bounds.minY) / bounds.span) * metrics.plotSize
    edgeContext.moveTo(x1, y1)
    edgeContext.lineTo(x2, y2)
  }
  edgeContext.stroke()

  postState(true, 'edges', completedBase + endEdgeIndex, total, reason)

  if (endEdgeIndex < edgePairs) {
    setTimeout(() => renderEdgesBatch(token, endEdgeIndex, bounds, metrics, reason, total, completedBase), 0)
    return
  }

  postState(false, 'done', total, total, reason)
}

function renderPointsBatch(token, startIndex, bounds, metrics, reason, total, completedBase = 0, includeEdges = false) {
  if (token !== renderToken || !graph || !pointContext) return

  const endIndex = Math.min(startIndex + POINT_BATCH_SIZE, graph.nodeCount)
  pointContext.globalAlpha = 0.92
  for (let i = startIndex; i < endIndex; i += 1) {
    const x = metrics.offsetX + ((graph.posX[i] - bounds.minX) / bounds.span) * metrics.plotSize - metrics.pointRadius
    const y = metrics.offsetY + ((graph.posY[i] - bounds.minY) / bounds.span) * metrics.plotSize - metrics.pointRadius
    const tinted = getTintedPoint(graph.renderColors[i] ?? FALLBACK_POINT_COLOR)
    pointContext.drawImage(tinted, x, y, metrics.diameter, metrics.diameter)
  }
  pointContext.globalAlpha = 1

  postState(true, 'points', completedBase + endIndex, total, reason)

  if (endIndex < graph.nodeCount) {
    setTimeout(() => renderPointsBatch(token, endIndex, bounds, metrics, reason, total, completedBase, includeEdges), 0)
    return
  }

  if (!includeEdges) {
    postState(false, 'done', total, total, reason)
    return
  }

  postState(true, 'edges', graph.nodeCount, total, reason)
  setTimeout(() => renderEdgesBatch(token, 0, bounds, metrics, reason, total, graph.nodeCount), 0)
}

function buildMetrics(pointCount) {
  const plotSize = Math.max(Math.min(width, height) - PAD * 2, 1)
  const offsetX = (width - plotSize) / 2
  const offsetY = (height - plotSize) / 2
  const pointRadius = pointCount > 15000 ? 1.8 : pointCount > 8000 ? 2.1 : pointCount > 3000 ? 2.6 : 3.2
  return {
    plotSize,
    offsetX,
    offsetY,
    pointRadius,
    diameter: pointRadius * 2,
    edgeWidth: Math.max(pointRadius * 0.45, 1),
  }
}

function getBounds(posX, posY) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (let i = 0; i < posX.length; i += 1) {
    const x = posX[i]
    const y = posY[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  return {
    minX,
    minY,
    span: Math.max(maxX - minX, maxY - minY, 1e-6),
  }
}

function resizeCanvases() {
  if (edgeCanvas) {
    edgeCanvas.width = width
    edgeCanvas.height = height
  }
  if (pointCanvas) {
    pointCanvas.width = width
    pointCanvas.height = height
  }
}

function clearEdgeSurface() {
  if (!edgeContext) return
  edgeContext.setTransform(1, 0, 0, 1, 0, 0)
  edgeContext.clearRect(0, 0, width, height)
  edgeContext.fillStyle = BACKGROUND_COLOR
  edgeContext.fillRect(0, 0, width, height)
}

function clearPointSurface() {
  if (!pointContext) return
  pointContext.setTransform(1, 0, 0, 1, 0, 0)
  pointContext.clearRect(0, 0, width, height)
}

function drawEmpty() {
  clearEdgeSurface()
  clearPointSurface()
}

function postState(busy, phase, completed, total, reason) {
  self.postMessage({
    type: 'state',
    payload: { busy, phase, completed, total, reason },
  })
}

function getTintedPoint(colorValue) {
  const cached = tintCache.get(colorValue)
  if (cached) return cached

  const tinted = new OffscreenCanvas(BASE_POINT_SIZE, BASE_POINT_SIZE)
  const tintedContext = tinted.getContext('2d')
  tintedContext.drawImage(pointTextureCanvas, 0, 0)
  tintedContext.globalCompositeOperation = 'source-atop'
  tintedContext.fillStyle = colorValueToCss(colorValue)
  tintedContext.fillRect(0, 0, BASE_POINT_SIZE, BASE_POINT_SIZE)
  tintedContext.globalCompositeOperation = 'source-over'
  tintCache.set(colorValue, tinted)
  return tinted
}

function colorValueToCss(colorValue) {
  const r = (colorValue >> 16) & 255
  const g = (colorValue >> 8) & 255
  const b = colorValue & 255
  return `rgb(${r}, ${g}, ${b})`
}
