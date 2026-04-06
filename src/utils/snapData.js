import { ungzip } from 'pako'

export const DATASETS = ['aircraft', 'APH', 'ACO', 'co_author_8391', 'socfb-UF21', 'socfb-Yale4'].map((name) => ({
  name,
  label: name,
}))

const supportsSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'

function createBuffer(byteLength) {
  return supportsSharedArrayBuffer ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength)
}

/**
 * Build URL for files under `public/` (respects Vite `base`, e.g. GitHub Pages subpath).
 * @param {string} path - e.g. `data/aircraft.txt.gz` (no leading slash)
 */
export function dataAssetUrl(path) {
  const rel = path.replace(/^\/+/, '')
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? `${base}${rel}` : `${base}/${rel}`
}

/** RFC 1952 gzip member magic */
function looksLikeGzip(u8) {
  return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b
}

/**
 * Decode response body: raw gzip bytes, or already-expanded UTF-8 if the host used Content-Encoding: gzip.
 */
function decodeGzipOrPlain(buf, gzUrl) {
  const u8 = new Uint8Array(buf)
  if (!looksLikeGzip(u8)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(u8)
  }
  try {
    const out = ungzip(u8)
    return new TextDecoder('utf-8', { fatal: false }).decode(out)
  } catch (e) {
    throw new Error(`Gzip decompression failed for ${gzUrl}: ${e?.message || e}`)
  }
}

/**
 * Fetch a gzip file from static assets and return UTF-8 text.
 * If the `.gz` request is missing or fails, falls back to the same path without `.gz` (plain text).
 * If the body does not start with gzip magic (e.g. CDN already decompressed), treats it as plain UTF-8.
 */
export async function fetchGzipText(gzUrl) {
  const plainUrl = gzUrl.replace(/\.gz$/i, '')

  async function fetchPlain() {
    const res = await fetch(plainUrl)
    if (!res.ok) {
      throw new Error(`Failed to load ${plainUrl} (${res.status})`)
    }
    return res.text()
  }

  let res = null
  try {
    res = await fetch(gzUrl)
  } catch {
    res = null
  }

  if (!res || !res.ok) {
    return fetchPlain()
  }

  const buf = await res.arrayBuffer()
  return decodeGzipOrPlain(buf, gzUrl)
}

export const LABEL_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#8dd3c7', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f']
export const EDGE_RENDER_LIMIT = 300000

export function colorForLabel(label) {
  if (label === -1) return '#98a2b3'
  return LABEL_PALETTE[Math.abs(label) % LABEL_PALETTE.length]
}

export function colorToNumber(color) {
  return Number.parseInt(color.slice(1), 16)
}

export function parseTxtGraph(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const [nRaw, mRaw] = lines[0].split(/\s+/)
  const nodeCount = parseInt(nRaw, 10)
  const edgeCount = parseInt(mRaw, 10)
  const edges = []
  for (let i = 1; i < lines.length && edges.length < edgeCount; i += 1) {
    const [sRaw, tRaw] = lines[i].split(/\s+/)
    const source = parseInt(sRaw, 10)
    const target = parseInt(tRaw, 10)
    if (Number.isFinite(source) && Number.isFinite(target)) edges.push([source, target])
  }
  return { nodeCount, edges }
}

/**
 * Matrix Market coordinate format (e.g. .mtx). Indices in the file are 1-based.
 * Supports pattern / real / integer; symmetric or general (deduped undirected edges).
 * Only square M×N (M === N) adjacency-style graphs are supported.
 */
export function parseMtxGraph(text) {
  const rawLines = text.split(/\r?\n/)
  let idx = 0
  while (idx < rawLines.length && rawLines[idx].trim() === '') idx += 1
  if (idx >= rawLines.length) throw new Error('MTX: empty file')
  const banner = rawLines[idx].trim()
  if (!/^%%MatrixMarket/i.test(banner)) {
    throw new Error('MTX: first line must start with %%MatrixMarket')
  }
  const tokens = banner.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.includes('coordinate')) {
    throw new Error('MTX: only matrix coordinate format is supported (not array)')
  }
  if (tokens.includes('complex')) {
    throw new Error('MTX: complex field is not supported')
  }
  const isPattern = tokens.includes('pattern')
  const hasValue = tokens.includes('real') || tokens.includes('integer') || tokens.includes('double')

  idx += 1
  while (idx < rawLines.length) {
    const t = rawLines[idx].trim()
    if (t === '' || t.startsWith('%')) {
      idx += 1
      continue
    }
    break
  }
  if (idx >= rawLines.length) throw new Error('MTX: missing dimension line')
  const dimParts = rawLines[idx].trim().split(/\s+/)
  const M = parseInt(dimParts[0], 10)
  const N = parseInt(dimParts[1], 10)
  const L = parseInt(dimParts[2], 10)
  if (!Number.isFinite(M) || !Number.isFinite(N) || !Number.isFinite(L)) {
    throw new Error('MTX: invalid dimension line (expected M N nnz)')
  }
  if (M !== N) {
    throw new Error('MTX: only square matrices (M = N) are supported')
  }
  idx += 1

  const seen = new Set()
  const edges = []
  let parsed = 0
  while (idx < rawLines.length && parsed < L) {
    const line = rawLines[idx].trim()
    idx += 1
    if (line === '' || line.startsWith('%')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) {
      throw new Error(`MTX: bad data line (need row col): ${line}`)
    }
    if (!isPattern && hasValue && parts.length < 3) {
      throw new Error(`MTX: bad data line (need row col value): ${line}`)
    }
    const i1 = parseInt(parts[0], 10)
    const j1 = parseInt(parts[1], 10)
    if (!Number.isFinite(i1) || !Number.isFinite(j1)) {
      throw new Error(`MTX: invalid indices: ${line}`)
    }
    parsed += 1
    const u = i1 - 1
    const v = j1 - 1
    if (u === v) continue
    if (u < 0 || v < 0 || u >= M || v >= M) {
      throw new Error(`MTX: edge (${i1}, ${j1}) out of range for ${M}×${M} matrix`)
    }
    const a = Math.min(u, v)
    const b = Math.max(u, v)
    const key = `${a}\t${b}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push([u, v])
  }

  if (parsed < L) {
    throw new Error(`MTX: expected ${L} data lines, found ${parsed}`)
  }

  return { nodeCount: M, edges }
}

export function parseAttr(text, expectedCount) {
  const labels = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((value) => parseInt(value, 10))
  while (labels.length < expectedCount) labels.push(-1)
  return labels.slice(0, expectedCount).map((value) => (Number.isFinite(value) ? value : -1))
}

export function parsePositions(text, expectedCount) {
  const points = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [xRaw, yRaw] = line.split(/\s+/)
    const x = parseFloat(xRaw)
    const y = parseFloat(yRaw)
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
  })
  while (points.length < expectedCount) points.push({ x: 0, y: 0 })
  return points.slice(0, expectedCount)
}

/**
 * Golden-angle spiral layout; matches Graph::init_spiral in SNAP-tFDP graph.cpp
 * (max_radius 10, radius = sqrt(i)*scale, angle = i * pi * (3 - sqrt(5))).
 */
export function spiralInitPmdsText(nodeCount) {
  if (nodeCount <= 0) return ''
  const maxRadius = 10.0
  const maxSqrtN = Math.sqrt(Math.max(0, nodeCount - 1))
  const scaleFactor = maxSqrtN > 0 ? maxRadius / maxSqrtN : 0
  const lines = new Array(nodeCount)
  for (let i = 0; i < nodeCount; i += 1) {
    const radius = Math.sqrt(i) * scaleFactor
    const angle = i * Math.PI * (3.0 - Math.sqrt(5.0))
    const x = radius * Math.cos(angle)
    const y = radius * Math.sin(angle)
    lines[i] = `${x.toFixed(17)} ${y.toFixed(17)}`
  }
  return lines.join('\n')
}

/**
 * @param {object} [options]
 * @param {'snap'|'mtx'} [options.edgeFormat] — custom uploads: use 'mtx' for Matrix Market .mtx graphs
 */
export function buildGraph(edgeText, attrText, pmdsText, name, options = {}) {
  const edgeFormat = options.edgeFormat === 'mtx' ? 'mtx' : 'snap'
  const { nodeCount, edges } = edgeFormat === 'mtx' ? parseMtxGraph(edgeText) : parseTxtGraph(edgeText)
  const labels = parseAttr(attrText ?? '', nodeCount)
  const pmdsSource = pmdsText && String(pmdsText).trim() ? pmdsText : spiralInitPmdsText(nodeCount)
  const points = parsePositions(pmdsSource, nodeCount)
  const posX = new Float32Array(createBuffer(Float32Array.BYTES_PER_ELEMENT * nodeCount))
  const posY = new Float32Array(createBuffer(Float32Array.BYTES_PER_ELEMENT * nodeCount))
  const initX = new Float32Array(nodeCount)
  const initY = new Float32Array(nodeCount)
  const renderColors = new Uint32Array(createBuffer(Uint32Array.BYTES_PER_ELEMENT * nodeCount))
  let labeledCount = 0

  for (let i = 0; i < nodeCount; i += 1) {
    const point = points[i]
    posX[i] = point.x
    posY[i] = point.y
    initX[i] = point.x
    initY[i] = point.y
    renderColors[i] = colorToNumber(colorForLabel(labels[i]))
    if (labels[i] !== -1) labeledCount += 1
  }

  const sources = new Uint32Array(createBuffer(Uint32Array.BYTES_PER_ELEMENT * edges.length * 2))
  const targets = new Uint32Array(createBuffer(Uint32Array.BYTES_PER_ELEMENT * edges.length * 2))
  let ptr = 0
  for (let i = 0; i < edges.length; i += 1) {
    const [u, v] = edges[i]
    if (u === v) continue
    sources[ptr] = u
    targets[ptr] = v
    ptr += 1
    sources[ptr] = v
    targets[ptr] = u
    ptr += 1
  }

  return {
    name,
    nodeCount,
    edgeCount: edges.length,
    labeledCount,
    labels,
    posX,
    posY,
    initX,
    initY,
    renderColors,
    sources: sources.subarray(0, ptr),
    targets: targets.subarray(0, ptr),
  }
}
