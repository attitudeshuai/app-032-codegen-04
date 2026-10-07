// SSR 冒烟：渲染 7 个预设灯样的绑扎节点图核心路径（纯逻辑，不依赖 DOM）
import { createFromPreset } from '../src/core/store'
import { computeAll } from '../src/core/checks'
import { DEFAULT_LOFT_OPTIONS } from '../src/core/paginate'
import type { Lantern } from '../src/core/types'

const ids = ['hex-palace', 'oct-palace', 'round-lantern', 'lotus', 'tetra-zodiac', 'octa-zodiac', 'box-revolving']
let fail = 0
for (const id of ids) {
  const l: Lantern = createFromPreset(id)
  const full = computeAll(l, DEFAULT_LOFT_OPTIONS)
  const failChk = full.checks.filter((c) => !c.pass).map((c) => c.id)
  const ok = failChk.length === 0
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: checks=${full.checks.filter((c) => c.pass).length}/${full.checks.length}${ok ? '' : ' 失败=' + failChk.join(',')}  lash=${full.lash.nodeCount}节点/${full.lash.tieCount}道/${full.lash.steps.length}步  lashM=${full.materials.lashM}m  elapsed=${full.elapsedMs.toFixed(2)}ms`)
  // 三处同源断言：备料单扎线（m）与节点用线（mm）
  const mm = Math.round(full.materials.lashM * 1000)
  if (Math.abs(mm - full.lash.wireMm) > 1) {
    console.log(`  FAIL 同源: materials ${mm}mm vs lash ${full.lash.wireMm}mm`)
    fail++
  }
}
process.exit(fail ? 1 : 0)
