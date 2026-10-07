import { createFromPreset } from '../src/core/store'
import { buildLashPlan, compareModes, diffPlans } from '../src/core/lashing'
import type { Lantern } from '../src/core/types'

function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

for (const preset of ['hex-palace', 'oct-palace', 'round-lantern', 'lotus', 'tetra-zodiac', 'octa-zodiac', 'box-revolving']) {
  const l: Lantern = createFromPreset(preset)
  const space = buildLashPlan(l, { mode: 'space' })
  const combo = buildLashPlan(l, { mode: 'combo' })
  console.log(`\n=== ${preset} (${l.kind}, n=${l.sides}, layers=${l.layers.length}) ===`)
  console.log(
    `space: nodes=${space.nodeCount} ties=${space.tieCount} wire=${space.wireMm}mm steps=${space.steps.length} joints=${space.jointTotal} deadlocks=${space.deadlocks.length}`
  )
  console.log(
    `combo: nodes=${combo.nodeCount} ties=${combo.tieCount} wire=${combo.wireMm}mm steps=${combo.steps.length} deadlocks=${combo.deadlocks.length}`
  )
  // 余量处数守恒：逐节点 jointCount 之和 = 构件表 qty×lashJoints
  const jointActionsSpace = space.nodes.reduce((s, n) => s + n.jointCount, 0)
  const jointActionsCombo = combo.nodes.reduce((s, n) => s + n.jointCount, 0)
  check(`${preset} space 余量处数守恒`, jointActionsSpace === space.jointTotal, `${jointActionsSpace} vs ${space.jointTotal}`)
  check(`${preset} combo 余量处数守恒`, jointActionsCombo === combo.jointTotal, `${jointActionsCombo} vs ${combo.jointTotal}`)
  // 扎道 = 节点数（每点一道）；用线 = 扎道 × 500mm
  check(`${preset} space 扎道数=节点数`, space.tieCount === space.nodeCount)
  check(`${preset} combo 扎道数=节点数`, combo.tieCount === combo.nodeCount)
  check(`${preset} space 用线=扎道×500`, Math.abs(space.wireMm - space.tieCount * 500) < 0.06, `${space.wireMm}`)
  check(`${preset} combo 用线=扎道×500`, Math.abs(combo.wireMm - combo.tieCount * 500) < 0.06, `${combo.wireMm}`)
  // 无死锁
  check(`${preset} space 默认无死锁`, space.schedulable)
  check(`${preset} combo 默认无死锁`, combo.schedulable)
  // 工步严格按层递增
  let prevLayer = -1
  let okLayer = true
  for (const st of space.steps) {
    if (st.layer < prevLayer) okLayer = false
    prevLayer = st.layer
  }
  check(`${preset} 工步层序单调`, okLayer)
  // 每个节点都排到了
  check(`${preset} 节点全排入工步`, space.steps.reduce((s, st) => s + st.nodes.length, 0) === space.nodes.length)
  // combo 节点/扎 >= space
  check(`${preset} combo 扎道不少于 space`, combo.tieCount >= space.tieCount)
  // 每个工步用线合计
  const stepWire = space.steps.reduce((s, st) => s + st.wireMm, 0)
  check(`${preset} 逐工步用线合计=总量`, Math.abs(stepWire - space.wireMm) < 0.2, `${stepWire} vs ${space.wireMm}`)
}

// 手工核对：六角宫灯 n=6 L=4
const l = createFromPreset('hex-palace')
const p = buildLashPlan(l, { mode: 'space' })
// 交会：5 截面 × 6 顶点 = 30；接头：竖篾 12 + 横篾边 5层×6=30 ⇒ 余量 42
check('六角 余量总处数=42', p.jointTotal === 42, String(p.jointTotal))
// space：每截面每顶点 cross+2竖端/边接头同位 → 节点数 = 30
check('六角 space 节点=30', p.nodeCount === 30, String(p.nodeCount))
check('六角 space 扎线=15000mm', p.wireMm === 15000, String(p.wireMm))
const pc = buildLashPlan(l, { mode: 'combo' })
// combo：30 cross + 12 竖端 + 30 边接头 = 72
check('六角 combo 节点=72', pc.nodeCount === 72, String(pc.nodeCount))
check('六角 combo 扎线=36000mm', pc.wireMm === 36000, String(pc.wireMm))
console.log('\ncompareModes:', JSON.stringify(compareModes(l), null, 1))

// 死锁试算：把某节点向下挪，制造与下层节点在同竖篾上的缠裹冲突 → 挪过层界后层序成环
const plan = buildLashPlan(l, { mode: 'space' })
// 第一层（layer 1）某节点 y 是多少？底高
const layer1Node = plan.nodes.find((n) => n.layer === 1)
const layerH = l.layers[0].heightMm
console.log('layer1 node y =', layer1Node?.pos.y, 'layer0 height =', layerH)
// 向下挪 layerH+6mm，使其 y 落到 layer0 之下…实际位置穿越底层
if (layer1Node) {
  const dead = buildLashPlan(l, {
    mode: 'space',
    overrides: [{ stableKey: layer1Node.stableKey, dyMm: -(layerH + 8) }]
  })
  console.log(`试算下挪后: deadlocks=${dead.deadlocks.length} schedulable=${dead.schedulable} steps=${dead.steps.length}`)
  if (dead.deadlocks.length) {
    const d = dead.deadlocks[0]
    console.log('  reason:', d.reason)
    console.log('  A:', d.routeA.title, `代价 +${d.routeA.extraSteps}步 +${d.routeA.extraTies}道 +${d.routeA.extraWireMm}mm`)
    console.log('  B:', d.routeB.title, `代价 +${d.routeB.extraSteps}步 +${d.routeB.extraTies}道 +${d.routeB.extraWireMm}mm`)
    // 路 A：强制改序（例外施工，补 1 道扎）
    const [na, nb] = d.nodes
    const viaA = buildLashPlan(l, { mode: 'space', forcedOrders: [{ beforeStableKey: na.stableKey, afterStableKey: nb.stableKey }] })
    check('路A 改序后可排', viaA.schedulable, `${viaA.steps.length} 步 / ${viaA.tieCount} 道 / ${viaA.wireMm}mm`)
    check('路A 多 1 道扎 +500mm', viaA.tieCount === p.tieCount + 1 && viaA.wireMm === p.wireMm + 500)
    // 路 B：挪开环中节点一个缠裹宽度
    const viaB1 = buildLashPlan(l, { mode: 'space', overrides: [{ stableKey: d.nodes[0].stableKey, dyMm: l.lashWrapWidthMm }] })
    const viaB2 = buildLashPlan(l, { mode: 'space', overrides: [{ stableKey: d.nodes[1].stableKey, dyMm: l.lashWrapWidthMm }] })
    check('路B 挪位后可排（其一）', viaB1.schedulable || viaB2.schedulable, `B1=${viaB1.schedulable} B2=${viaB2.schedulable}`)
  }
}

// 改棱数/层数对比：六角 6/4 → 八角 8/4 与六角 6/5
{
  const before = buildLashPlan(l, { mode: 'space' })
  const l2: Lantern = JSON.parse(JSON.stringify(l))
  l2.sides = 8
  const after = buildLashPlan(l2, { mode: 'space' })
  const rep = diffPlans(before, after, true, false)
  check('改棱数 检测出变化', rep.changed && rep.totals.before.ties === 30 && rep.totals.after.ties === 40, `ties ${rep.totals.before.ties}→${rep.totals.after.ties}`)
  console.log(`  改棱数: 节点 ${rep.totals.before.nodes}→${rep.totals.after.nodes}, 移动 ${rep.preview.moved.length}, 工步变动 ${rep.steps.length}`)

  const l3: Lantern = JSON.parse(JSON.stringify(l))
  l3.layers = Array.from({ length: 5 }, () => ({ heightMm: 84, diameterMm: 0 }))
  l3.layers[4].heightMm = 420 - 84 * 4
  const after3 = buildLashPlan(l3, { mode: 'space' })
  const rep3 = diffPlans(before, after3, false, true)
  check('改层数 检测出变化', rep3.changed && rep3.totals.after.nodes === 36, `nodes=${rep3.totals.after.nodes}`)
  console.log(`  改层数: 节点 ${rep3.totals.before.nodes}→${rep3.totals.after.nodes}, 工步 ${rep3.totals.before.steps}→${rep3.totals.after.steps}`)
}
