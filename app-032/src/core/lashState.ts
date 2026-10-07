/**
 * 绑扎节点图的现场状态（与灯样分开存，断网可用）：
 *  - mode：节点合并二选一的当前选择（写回灯样 l.lashingMerge）
 *  - 已「出图照做」的版本基线（approved）：改棱数/层数/合并方式后签名变化 → 旧版作废
 *  - 已绑层带（boundBands）：旧版作废后，凡已绑层带都要点名「拆开重绑」
 */
import { reactive, watch } from 'vue'
import type { LashMergeMode } from './types'
import type { LashSnapshot } from './lashing'

const KEY = 'lantern-lashing-state.v1'

interface LanternLashState {
  mode: LashMergeMode
  /** 已批准出图的版本签名；为空表示还没出过图 */
  approvedSignature: string
  /** 批准时的快照（用于列三处变化） */
  snapshot: LashSnapshot | null
  /** 批准时的总量（作废时写清旧版扎线用量） */
  totals: { nodes: number; ties: number; wireM: number; steps: number }
  approvedAt: string
  /** 已绑层带名（旧版作废后这些层要拆开重绑） */
  boundBands: string[]
  /** 已导出文件标记（作废时提示） */
  exportedNames: string[]
}

interface StateMap {
  [lanternId: string]: LanternLashState
}

const state = reactive<StateMap>(load())

function load(): StateMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as StateMap
  } catch {
    // 损坏则从空开始
  }
  return {}
}

let suspend = false
watch(
  state,
  () => {
    if (suspend) return
    suspend = true
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } finally {
      suspend = false
    }
  },
  { deep: true }
)

function ensure(id: string, mode: LashMergeMode): LanternLashState {
  if (!state[id]) {
    state[id] = {
      mode,
      approvedSignature: '',
      snapshot: null,
      totals: { nodes: 0, ties: 0, wireM: 0, steps: 0 },
      approvedAt: '',
      boundBands: [],
      exportedNames: []
    }
  }
  return state[id]
}

export function useLashState() {
  return {
    state,
    ensure,
    approve(id: string, mode: LashMergeMode, snapshot: LashSnapshot, totals: LanternLashState['totals']) {
      const s = ensure(id, mode)
      s.mode = mode
      s.approvedSignature = snapshot.signature
      s.snapshot = snapshot
      s.totals = { ...totals }
      s.approvedAt = new Date().toLocaleString()
    },
    markExported(id: string, mode: LashMergeMode, name: string) {
      const s = ensure(id, mode)
      if (!s.exportedNames.includes(name)) s.exportedNames.push(name)
    },
    toggleBound(id: string, mode: LashMergeMode, band: string) {
      const s = ensure(id, mode)
      const i = s.boundBands.indexOf(band)
      if (i >= 0) s.boundBands.splice(i, 1)
      else s.boundBands.push(band)
    },
    /** 版本是否已作废（已批准过且签名变化） */
    isStale(id: string, signature: string): boolean {
      const s = state[id]
      return !!s && !!s.approvedSignature && s.approvedSignature !== signature
    },
    reset(id: string) {
      delete state[id]
    }
  }
}
