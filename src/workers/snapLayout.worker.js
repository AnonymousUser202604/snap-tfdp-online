function createRng(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | t)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

let layout = null
let messageCommand = 'idle'

self.onmessage = (event) => {
  const { type, payload } = event.data

  if (type === 'start') {
    const { posXBuffer, posYBuffer, sources, targets, k, nEpoch, seed, nodeCount } = payload
    const rng = createRng(seed ?? 42)
    const edgeOrder = new Uint32Array(sources.length)
    for (let i = 0; i < edgeOrder.length; i += 1) edgeOrder[i] = i
    for (let i = edgeOrder.length - 1; i > 0; i -= 1) {
      const j = (rng() * (i + 1)) | 0
      const tmp = edgeOrder[i]
      edgeOrder[i] = edgeOrder[j]
      edgeOrder[j] = tmp
    }

    layout = {
      posX: new Float32Array(posXBuffer),
      posY: new Float32Array(posYBuffer),
      sources: new Uint32Array(sources),
      targets: new Uint32Array(targets),
      edgeOrder,
      nodeCount,
      k,
      nEpoch,
      epoch: 0,
      step: 1,
      stepMin: 0.01,
      stepSize: 1 - Math.pow(0.02, 1 / Math.max(nEpoch, 1)),
      alpha: 0.1,
      beta: 8,
      rng,
    }
    messageCommand = 'step'
    runSingleEpoch()
    return
  }

  if (type === 'command') {
    const command = payload?.command
    if (command === 'pause') {
      messageCommand = 'pause'
      return
    }
    if (command === 'stop') {
      messageCommand = 'stop'
      layout = null
      return
    }
    if (command === 'resume' || command === 'step') {
      messageCommand = 'step'
      runSingleEpoch()
    }
    return
  }

  if (type === 'stop') {
    messageCommand = 'stop'
    layout = null
  }
}

function runSingleEpoch() {
  if (!layout || messageCommand === 'stop' || messageCommand === 'pause') return
  if (layout.epoch >= layout.nEpoch) return

  runEpoch(layout)
  layout.epoch += 1
  layout.step += (layout.stepMin - layout.step) * layout.stepSize
  messageCommand = 'idle'

  const isDone = layout.epoch >= layout.nEpoch
  self.postMessage({
    type: isDone ? 'done' : 'progress',
    payload: {
      epoch: layout.epoch,
      nEpoch: layout.nEpoch,
      posX: layout.posX,
      posY: layout.posY,
    },
  })
}

function runEpoch(state) {
  const { posX, posY, sources, targets, edgeOrder, step, alpha, beta, k, nodeCount, rng } = state

  for (let i = 0; i < edgeOrder.length; i += 1) {
    const edgeIndex = edgeOrder[i]
    const u = sources[edgeIndex]
    const v = targets[edgeIndex]

    let dx = posX[v] - posX[u]
    let dy = posY[v] - posY[u]
    let dis2 = dx * dx + dy * dy
    let force = alpha * (1 + beta / (1 + dis2))
    let mvx = step * force * dx
    let mvy = step * force * dy
    posX[u] += mvx
    posY[u] += mvy
    posX[v] -= mvx
    posY[v] -= mvy

    for (let j = 0; j < k; j += 1) {
      let other = (rng() * nodeCount) | 0
      while (other === u) other = (rng() * nodeCount) | 0
      dx = posX[other] - posX[u]
      dy = posY[other] - posY[u]
      dis2 = dx * dx + dy * dy
      force = -1 / ((1 + dis2) * (1 + dis2))
      mvx = step * force * dx
      mvy = step * force * dy
      posX[u] += mvx
      posY[u] += mvy
      posX[other] -= mvx
      posY[other] -= mvy
    }
  }
}
