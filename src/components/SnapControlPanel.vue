<script setup>
import { ArrowDown, ArrowUp, InfoFilled } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'

defineProps({
  datasets: { type: Array, required: true },
  datasetDisplayName: { type: String, required: true },
  selectedName: { type: String, required: true },
  paramK: { type: Number, required: true },
  paramEpoch: { type: Number, required: true },
  stats: { type: Object, required: true },
  statusText: { type: String, required: true },
  statusType: { type: String, required: true },
  isLoaded: { type: Boolean, required: true },
  paramsDisabled: { type: Boolean, required: true },
  datasetDisabled: { type: Boolean, required: true },
  resetDisabled: { type: Boolean, required: true },
  actionLabel: { type: String, required: true },
  actionDisabled: { type: Boolean, required: true },
})

const emit = defineEmits([
  'update:selectedName',
  'update:paramK',
  'update:paramEpoch',
  'apply-custom',
  'action',
  'reset',
])

const graphText = ref('')
const attrText = ref('')
const pmdsText = ref('')
const graphFileLabel = ref('')
const attrFileLabel = ref('')
const pmdsFileLabel = ref('')

const graphInputRef = ref(null)
const attrInputRef = ref(null)
const pmdsInputRef = ref(null)

const canApplyCustom = computed(() => Boolean(graphText.value.trim()))

const customPanelOpen = ref(false)
const formatHelpVisible = ref(false)

function toggleCustomPanel() {
  customPanelOpen.value = !customPanelOpen.value
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'UTF-8')
  })
}

async function onGraphFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  graphText.value = await readFileAsText(file)
  graphFileLabel.value = file.name
  clearOptionalFiles()
}

async function onAttrFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  attrText.value = await readFileAsText(file)
  attrFileLabel.value = file.name
}

async function onPmdsFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  pmdsText.value = await readFileAsText(file)
  pmdsFileLabel.value = file.name
}

function clearOptionalFiles() {
  attrText.value = ''
  attrFileLabel.value = ''
  pmdsText.value = ''
  pmdsFileLabel.value = ''
}

function applyCustom() {
  if (!canApplyCustom.value) return
  const base = graphFileLabel.value.replace(/\.[^.]+$/, '') || 'custom'
  const edgeFormat = graphFileLabel.value.toLowerCase().endsWith('.mtx') ? 'mtx' : 'snap'
  emit('apply-custom', {
    edgeText: graphText.value,
    edgeFormat,
    attrText: attrText.value,
    pmdsText: pmdsText.value,
    label: base,
  })
}
</script>

<template>
  <aside class="control-panel">
    <el-card class="panel-card" shadow="never">
      <template #header>
        <div class="panel-head-row">
          <div class="panel-head">Dataset</div>
          <button
            type="button"
            class="panel-info-btn"
            aria-label="Dataset file formats"
            @click="formatHelpVisible = true"
          >
            <el-icon :size="17"><InfoFilled /></el-icon>
          </button>
        </div>
      </template>

      <div class="dataset-source">
        <button
          type="button"
          class="custom-dataset-toggle"
          :class="{ 'is-open': customPanelOpen }"
          :disabled="datasetDisabled"
          :aria-expanded="customPanelOpen"
          @click="toggleCustomPanel"
        >
          <span class="custom-dataset-toggle-label">Upload Dataset</span>
          <el-icon class="custom-dataset-toggle-icon" :size="16">
            <ArrowUp v-if="customPanelOpen" />
            <ArrowDown v-else />
          </el-icon>
        </button>

        <div v-show="!customPanelOpen" class="dataset-select-row">
          <span class="dataset-select-label">Select Dataset</span>
          <el-select
            :model-value="selectedName"
            class="dataset-select"
            placeholder="Select dataset"
            :disabled="datasetDisabled"
            @update:model-value="(value) => emit('update:selectedName', value)"
          >
            <el-option v-for="item in datasets" :key="item.name" :label="item.label" :value="item.name" />
          </el-select>
        </div>

        <div v-show="customPanelOpen" class="dataset-custom-panel">
          <div class="custom-file-lines">
            <div class="custom-file-line">
              <span class="custom-file-key">Graph</span>
              <input
                ref="graphInputRef"
                type="file"
                class="visually-hidden"
                accept=".txt,.mtx,text/plain"
                :disabled="datasetDisabled"
                @change="onGraphFile"
              />
              <button type="button" class="custom-file-pick" :disabled="datasetDisabled" @click="graphInputRef?.click()">
                Browse
              </button>
              <span class="custom-file-name" :title="graphFileLabel">{{ graphFileLabel || '.txt or .mtx' }}</span>
            </div>
            <div class="custom-file-line">
              <span class="custom-file-key">Labels</span>
              <input
                ref="attrInputRef"
                type="file"
                class="visually-hidden"
                accept=".attr,.txt,text/plain"
                :disabled="datasetDisabled"
                @change="onAttrFile"
              />
              <button type="button" class="custom-file-pick" :disabled="datasetDisabled" @click="attrInputRef?.click()">
                Browse
              </button>
              <span class="custom-file-name" :title="attrFileLabel">{{ attrFileLabel || 'Optional .attr' }}</span>
            </div>
            <div class="custom-file-line">
              <span class="custom-file-key">Layout</span>
              <input
                ref="pmdsInputRef"
                type="file"
                class="visually-hidden"
                accept=".txt,text/plain"
                :disabled="datasetDisabled"
                @change="onPmdsFile"
              />
              <button type="button" class="custom-file-pick" :disabled="datasetDisabled" @click="pmdsInputRef?.click()">
                Browse
              </button>
              <span class="custom-file-name" :title="pmdsFileLabel">{{ pmdsFileLabel || 'Optional .txt' }}</span>
            </div>
          </div>
          <div class="custom-panel-actions">
            <button
              v-if="attrFileLabel || pmdsFileLabel"
              type="button"
              class="custom-text-btn"
              :disabled="datasetDisabled"
              @click="clearOptionalFiles"
            >
              Clear optional files
            </button>
            <button
              type="button"
              class="custom-apply-btn"
              :disabled="datasetDisabled || !canApplyCustom"
              @click="applyCustom"
            >
              Load
            </button>
          </div>
        </div>
      </div>

      <div class="meta-card">
        <div class="meta-row"><span>Dataset</span><strong>{{ datasetDisplayName }}</strong></div>
        <div class="meta-row"><span>Nodes</span><strong>{{ stats.nodes }}</strong></div>
        <div class="meta-row"><span>Edges</span><strong>{{ stats.edges }}</strong></div>
        <div class="meta-row meta-status"><span>Status</span><el-tag :type="statusType" effect="plain">{{ statusText }}</el-tag></div>
      </div>
    </el-card>

    <el-card class="panel-card" shadow="never">
      <template #header><div class="panel-head">Parameters</div></template>
      <div class="field-row">
        <span>k</span>
        <el-input-number :model-value="paramK" :min="1" :step="1" :disabled="paramsDisabled" @update:model-value="(value) => emit('update:paramK', value)" />
      </div>
      <div class="field-row">
        <span>n_epoch</span>
        <el-input-number :model-value="paramEpoch" :min="1" :step="10" :disabled="paramsDisabled" @update:model-value="(value) => emit('update:paramEpoch', value)" />
      </div>
      <div class="action-stack">
        <el-button type="primary" size="large" :disabled="actionDisabled" @click="emit('action')">{{ actionLabel }}</el-button>
        <el-button size="large" :disabled="resetDisabled" @click="emit('reset')">Reset</el-button>
      </div>
    </el-card>

    <el-dialog
      v-model="formatHelpVisible"
      class="dataset-format-dialog"
      title="Dataset file formats"
      width="440px"
      append-to-body
    >
      <div class="dataset-format-help">
        <section class="dataset-format-section">
          <h4>Graph — SNAP text (.txt)</h4>
          <p>
            Line 1: <code>n m</code> — number of nodes and undirected edges. <br />
            Each following line: <code>u v</code> (0-based endpoints). Extra columns on an edge line are ignored.
          </p>
        </section>
        <section class="dataset-format-section">
          <h4>Graph — Matrix Market (.mtx)</h4>
          <p>
            Custom upload only. Banner line <code>%%MatrixMarket matrix coordinate …</code>; supported fields:
            <code>pattern</code>, <code>real</code>, or <code>integer</code>; <code>symmetric</code> or
            <code>general</code>. Next non-comment line: <code>M N L</code> with <code>M = N</code> (square adjacency).
            Following <code>L</code> lines: <code>i j</code> (pattern) or <code>i j value</code> (real/integer). Indices in
            the file are <strong>1-based</strong>; self-loops skipped; duplicate undirected edges merged.
          </p>
        </section>
        <section class="dataset-format-section">
          <h4>Labels (.attr, optional)</h4>
          <p>
            One integer class label per line for nodes <code>0 … n−1</code>. 
          </p>
        </section>
        <section class="dataset-format-section">
          <h4>Initial layout / PMDS (.txt, optional)</h4>
          <p>
            One line per node: <code>x y</code> coordinates. <br/> If you omit this file, positions use the spiral initializer.
          </p>
        </section>
      </div>
    </el-dialog>
  </aside>
</template>
