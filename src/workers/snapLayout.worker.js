const SLOT_EMPTY = 0
const SLOT_FULL = 1
const SLOT_STOP = 2
const CMD_RUN = 0
const CMD_PAUSE = 1
const CMD_STOP = 2
const SAMPLE_UPDATE_STRIDE = 1

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
let shared = null
let useSharedControl = false
let messageCommand = CMD_RUN

self.onmessage = (event) => {
  const { type, payload } = event.data

  if (type === 'start') {
    const { posXBuffer, posYBuffer, sources, targets, k, nEpoch, seed, nodeCount, controlBuffer, useSharedControl: useShared } = payload
    const rng = createRng(seed ?? 42)
    const edgeOrder = new Uint32Array(sources.length)
    for (let i = 0; i < edgeOrder.length; i += 1) edgeOrder[i] = i
    for (let i = edgeOrder.length - 1; i > 0; i -= 1) {
      const j = (rng() * (i + 1)) | 0
      const tmp = edgeOrder[i]
      edgeOrder[i] = edgeOrder[j]
      edgeOrder[j] = tmp
    }

    useSharedControl = Boolean(useShared && controlBuffer)
    shared = useSharedControl ? new Int32Array(controlBuffer) : null
    messageCommand = CMD_RUN
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
    if (shared) {
      Atomics.store(shared, 0, SLOT_EMPTY)
      Atomics.store(shared, 1, CMD_RUN)
    }
    loop()
    return
  }

  if (type === 'command') {
    const command = payload?.command
    if (command === 'pause') messageCommand = CMD_PAUSE
    if (command === 'resume') messageCommand = CMD_RUN
    if (command === 'stop') messageCommand = CMD_STOP
    if (messageCommand === CMD_RUN && layout) setTimeout(loop, 0)
    return
  }

  if (type === 'stop') {
    messageCommand = CMD_STOP
    layout = null
    shared = null
    useSharedControl = false
  }
}

function waitWhilePausedOrStopped() {
  while (true) {
    const command = Atomics.load(shared, 1)
    if (command === CMD_RUN) return true
    if (command === CMD_STOP) return false
    Atomics.wait(shared, 1, CMD_PAUSE)
  }
}

function loop() {
  if (!layout) return

  while (layout.epoch < layout.nEpoch) {
    if (useSharedControl) {
      if (!shared || !waitWhilePausedOrStopped()) return
    } else {
      if (messageCommand === CMD_STOP) return
      if (messageCommand === CMD_PAUSE) return
    }

    runEpoch(layout)
    layout.epoch += 1
    layout.step += (layout.stepMin - layout.step) * layout.stepSize

    if (layout.epoch % SAMPLE_UPDATE_STRIDE === 0 || layout.epoch >= layout.nEpoch) {
      if (useSharedControl) {
        while (true) {
          const slot = Atomics.load(shared, 0)
          const command = Atomics.load(shared, 1)
          if (command === CMD_STOP) return
          if (slot === SLOT_EMPTY) break
          Atomics.wait(shared, 0, SLOT_FULL)
        }

        Atomics.store(shared, 0, SLOT_FULL)
      } else {
        if (messageCommand === CMD_STOP) return
      }

      self.postMessage({
        type: layout.epoch >= layout.nEpoch ? 'done' : 'progress',
        payload: {
          epoch: layout.epoch,
          nEpoch: layout.nEpoch,
        },
      })

      if (!useSharedControl) {
        setTimeout(loop, 0)
        return
      }
    }
  }
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
