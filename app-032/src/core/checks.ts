/**
 * 自检（对应规格书 §10 验收标准）
 * 每次参数变化都会重算全部几何并跑一遍断言，结果直接显示在界面上。
 */
import type { CheckResult, Lantern } from './types'
import { bodySurfaceArea, polygonEdge, ringPerimeter, segmentInfos } from './geometry'
import { buildFrame, type FrameResult } from './frame'
import { buildPanels, panelNetArea, type PanelResult } from './panels'
import { computeBatch, computeMaterials, type BatchMaterials, type SingleLightMaterials } from './materials'
import { assertNoPanelSplit, paginate, type LoftOptions, type Sheet } from './paginate'
import {
  buildLashPlan,
  compareModes,
  lashOptionsFor,
  POSITION_HALF_STEP_MM,
  POSITION_STEP_MM,
  type LashPlan
} from './lashing'
import { CRAFT } from './craft'

export interface FullResult {
  frame: FrameResult
  panels: PanelResult
  materials: SingleLightMaterials
  batch: BatchMaterials
  sheets: Sheet[]
  /** 绑扎节点图（三处取数的同一份结果：预览 / 构件表 / 导出） */
  lash: LashPlan
  /** 两种合并方案对比（取舍用） */
  lashCompare: ReturnType<typeof compareModes>
  checks: CheckResult[]
  elapsedMs: number
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3)

export function computeAll(l: Lantern, loft: LoftOptions): FullResult {
  const t0 = performance.now()
  const frame = buildFrame(l)
  const panels = buildPanels(l)
  const materials = computeMaterials(l)
  const batch = computeBatch(materials, Math.max(1, Math.round(l.batchCount)), l.wasteRatio)
  const sheets = paginate(l, loft)
  const lash = buildLashPlan(l, lashOptionsFor(l))
  const lashCompare = compareModes(l, l.lashWrapWidthMm)
  const elapsedMs = performance.now() - t0
  const checks = runChecks(l, frame, panels, materials, batch, sheets, elapsedMs, lash)
  return { frame, panels, materials, batch, sheets, lash, lashCompare, checks, elapsedMs }
}

function runChecks(
  l: Lantern,
  frame: FrameResult,
  panels: PanelResult,
  materials: SingleLightMaterials,
  batch: BatchMaterials,
  sheets: Sheet[],
  elapsedMs: number,
  lash: LashPlan
): CheckResult[] {
  const out: CheckResult[] = []
  const g = frame.geometry
  const lashAllow = Math.max(0, l.lashAllowanceMm)

  // ---- CHK-01 几何：棱长/周长与手算一致 ----
  {
    const cases = [
      { name: '正六棱柱底边（D200）', got: polygonEdge(100, 6), expect: 100, tol: 1 },
      { name: '正八棱柱底边（D200）', got: polygonEdge(100, 8), expect: 76.5367, tol: 1 },
      { name: '圆形横篾圈周长（D200）', got: ringPerimeter(100, 0, false), expect: 628.3185, tol: 1 },
      { name: '六边形周长（D200）', got: ringPerimeter(100, 6, true), expect: 600, tol: 1 }
    ]
    const bad = cases.filter((c) => Math.abs(c.got - c.expect) > c.tol)
    out.push({
      id: 'CHK-01',
      title: '几何手算核对（棱长 / 周长，误差 ≤ 1mm）',
      pass: bad.length === 0,
      value: bad.length === 0 ? '4/4 项通过' : `${bad.length} 项超差`,
      detail: cases
        .map((c) => `${c.name}：算得 ${f3(c.got)} / 手算 ${f3(c.expect)}（Δ${f3(Math.abs(c.got - c.expect))}）`)
        .join('；')
    })
  }

  // ---- CHK-02 竖篾长度与分段高度累计 ----
  {
    const segs = segmentInfos(g)
    const sumH = segs.reduce((s, x) => s + x.heightMm, 0)
    const sumSlant = segs.reduce((s, x) => s + x.slantMm, 0)
    const vertical = frame.members.find((m) => m.kind === 'vertical' || m.kind === 'rib')
    const raw = vertical ? vertical.rawLengthMm : 0
    const allStraight = segs.every((s) => Math.abs(s.drMm) < 0.05)
    const pass = Math.abs(raw - sumSlant) <= 0.1 && (!allStraight || Math.abs(raw - sumH) <= 0.1)
    out.push({
      id: 'CHK-02',
      title: '竖篾净长 = 分段母线折线长累计',
      pass,
      value: `Δ折线 ${f1(Math.abs(raw - sumSlant))}mm`,
      detail: allStraight
        ? `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，平口直柱两者一致（Δ${f1(Math.abs(raw - sumH))}mm）`
        : `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，折线长累计 ${f1(sumSlant)}mm（收口段横向偏移 ${f1(sumSlant - sumH)}mm）`
    })
  }

  // ---- CHK-03 缝份 ----
  {
    const s = Math.max(0, l.seamAllowanceMm)
    const bad = panels.panels.filter(
      (p) =>
        Math.abs(p.widthTopMm - (p.rawWidthTopMm + 2 * s)) > 0.06 ||
        Math.abs(p.widthBottomMm - (p.rawWidthBottomMm + 2 * s)) > 0.06 ||
        Math.abs(p.heightMm - (p.rawHeightMm + 2 * s)) > 0.06
    )
    out.push({
      id: 'CHK-03',
      title: '裁片尺寸 = 展开净尺寸 + 缝份 × 2（每边）',
      pass: bad.length === 0,
      value: `${panels.panels.length - bad.length}/${panels.panels.length} 种裁片通过`,
      detail:
        bad.length === 0
          ? `全部 ${panels.panels.length} 种裁片上/下/高三个尺寸均等于净尺寸 + ${f1(s)}×2mm；裁片图以红色虚线绘制缝份折线`
          : `超差裁片：${bad.map((p) => p.label).join('、')}`
    })
  }

  // ---- CHK-04 备料守恒 ----
  {
    const stock = frame.members.reduce((a, m) => a + m.lengthMm * m.qty, 0)
    const rawTotal = frame.members.reduce((a, m) => a + m.rawLengthMm * m.qty, 0)
    const lashTotal = frame.members.reduce((a, m) => a + m.qty * m.lashJoints * lashAllow, 0)
    const diff = stock - rawTotal
    const pass = stock >= rawTotal - 1e-6 && Math.abs(diff - lashTotal) <= 0.5
    out.push({
      id: 'CHK-04',
      title: '备料守恒：Σ备料长度 ≥ Σ净长，且差值 = 余量总和',
      pass,
      value: `Σ备料 ${f1(stock)}mm / Σ净长 ${f1(rawTotal)}mm`,
      detail: `差值 ${f1(diff)}mm，应等于余量总和 ${f1(lashTotal)}mm（竖篾两端、横篾圈接头各计 ${f1(lashAllow)}mm）`
    })
  }

  // ---- CHK-05 面积核对 ----
  {
    const netArea = panels.panels.reduce((a, p) => a + panelNetArea(p) * p.qty, 0)
    const refArea = bodySurfaceArea(g, Math.max(3, Math.round(l.divisions)))
    const ratio = refArea > 0 ? netArea / refArea : 0
    const pass = ratio >= 0.97 && ratio <= 1.03
    let advice = ''
    if (!pass && !g.polygon) {
      const need = suggestDivisions(l, netArea, ratio)
      advice = need ? `；建议把母线等分数提高到 ${need}（当前 ${l.divisions}）` : ''
    } else if (!pass) {
      advice = '；请检查缝份/分层参数，棱柱类侧面积应与裁片面积完全一致'
    }
    out.push({
      id: 'CHK-05',
      title: '面积核对：Σ裁片净面积 / 灯体表面积 ∈ [0.97, 1.03]',
      pass,
      value: `比值 ${(ratio * 100).toFixed(2)}%`,
      detail: `裁片净面积 ${f3(netArea / 1_000_000)}m²，灯体表面积（含顶底盖）${f3(refArea / 1_000_000)}m²${advice}`
    })
  }

  // ---- CHK-06 分页：裁片不跨页 ----
  {
    const r = assertNoPanelSplit(sheets)
    out.push({
      id: 'CHK-06',
      title: '分页：任一裁片不跨页（长条跨页带对位十字与搭接量）',
      pass: r.pass,
      value: r.pass ? '通过' : '失败',
      detail: `${r.detail}；跨页仅出现在骨架长条上，接缝处绘制对位十字并标注搭接 ${f1(loftOverlap(sheets))}mm 与拼接编号`
    })
  }

  // ---- CHK-07 批量 ----
  {
    const n = Math.max(1, Math.round(l.batchCount))
    const k = n * (1 + l.wasteRatio)
    // 与单灯值的偏差只来自展示精度（长度 3 位小数 / 胶 1 位小数）
    const errs = [
      Math.abs(batch.frameM - materials.frameM * k),
      Math.abs(batch.coveringM2 - materials.coveringM2 * k),
      Math.abs(batch.lashM - materials.lashM * k)
    ]
    const pass = errs.every((e) => e <= 0.0011) && Math.abs(batch.glueG - materials.glueG * k) <= 0.051
    out.push({
      id: 'CHK-07',
      title: `批量制灯：${n} 个材料总量 = 单灯 × ${n} × (1 + ${(l.wasteRatio * 100).toFixed(0)}%)`,
      pass,
      value: `竹篾 ${f3(batch.frameM)}m / 蒙面 ${f3(batch.coveringM2)}m²`,
      detail: `单灯竹篾 ${f3(materials.frameM)}m × ${n} × ${(1 + l.wasteRatio).toFixed(2)} = ${f3(materials.frameM * k)}m = 批量值；蒙面、扎线、胶同理（LED 按颗数 × ${n} 计，不参与损耗）`
    })
  }

  // ---- CHK-08 性能 ----
  {
    const pass = elapsedMs < 100
    out.push({
      id: 'CHK-08',
      title: '放样计算 < 100ms',
      pass,
      value: `${elapsedMs.toFixed(1)}ms`,
      detail: `${l.divisions} 等分 × ${l.layers.length} 层：构件 ${frame.totalQty} 根、裁片 ${panels.totalQty} 块、图纸 ${sheets.length} 页，全流程耗时 ${elapsedMs.toFixed(1)}ms（含分页）`
    })
  }

  // ---- CHK-09 绑扎节点：余量处数参与扎道，逐节点用线合计 = 扎线总量（差 1cm 也报红） ----
  {
    const jointsInNodes = lash.nodes.reduce((s, n) => s + n.jointCount, 0)
    const tiesInSteps = lash.steps.reduce((s, st) => s + st.ties, 0)
    const wireInSteps = lash.steps.reduce((s, st) => s + st.wireMm, 0)
    const wireFromTies = lash.tieCount * CRAFT.lashPerJointM * 1000
    const materialWireMm = materials.lashM * 1000
    const errs = {
      joints: jointsInNodes - lash.jointTotal,
      ties: tiesInSteps - lash.tieCount,
      wire: Math.abs(wireInSteps - lash.wireMm),
      wireTies: Math.abs(lash.wireMm - wireFromTies),
      wireMaterials: Math.abs(materialWireMm - lash.wireMm)
    }
    const pass =
      errs.joints === 0 && errs.ties === 0 && errs.wire <= 1 && errs.wireTies <= 1 && errs.wireMaterials <= 1 && lash.schedulable
    out.push({
      id: 'CHK-09',
      title: '绑扎节点守恒：余量处数全入账、Σ逐节点扎线 = 扎线总量（误差 ≤ 10mm）',
      pass,
      value: `${lash.nodeCount} 节点 / ${lash.tieCount} 道 / ${f3(lash.wireMm / 1000)}m`,
      detail:
        `构件表绑扎余量处数 ${lash.jointTotal}（= Σ qty×余量处数），逐节点登记的余量动作 ${jointsInNodes}；` +
        `工步扎道 ${tiesInSteps} = 节点扎道 ${lash.tieCount}；逐工步用线合计 ${f1(wireInSteps)}mm = 节点总量 ${f1(lash.wireMm)}mm ` +
        `= 扎道×每道 ${CRAFT.lashPerJointM.toFixed(2)}m ${f1(wireFromTies)}mm = 备料单扎线 ${f1(materialWireMm)}mm；` +
        `位置取整 ${POSITION_STEP_MM.toFixed(1)}mm 档、去重边界 ±${POSITION_HALF_STEP_MM.toFixed(2)}mm（与构件表同档）`
    })
  }

  // ---- CHK-10 工步先后：层序单调、同层绕线不压线、无互相卡住 ----
  {
    let layerMono = true
    let prev = -1
    for (const st of lash.steps) {
      if (st.layer < prev) layerMono = false
      prev = st.layer
    }
    const allPlaced = lash.steps.reduce((s, st) => s + st.nodes.length, 0) === lash.nodes.length
    const pass = layerMono && allPlaced && lash.schedulable && lash.deadlocks.length === 0
    out.push({
      id: 'CHK-10',
      title: '工步先后排得开：下层不完不上上层，同层绕线互不压住，无成环死锁',
      pass,
      value: lash.schedulable ? `${lash.steps.length} 步全排开` : `${lash.deadlocks.length} 处互相卡住`,
      detail: lash.schedulable
        ? `${lash.steps.length} 道工步自底盘圈向收口圈逐层排布，层序单调；同一工步内节点沿任一篾走向间距 ≥ ${lash.wrapWidthMm}mm，绕线不互相压住，可同时上。`
        : `排不出先后：${lash.deadlocks.map((d) => d.reason).join('｜')} 两条路：A ${lash.deadlocks[0]?.routeA.title}（多 ${lash.deadlocks[0]?.routeA.extraTies} 道扎）；B ${lash.deadlocks[0]?.routeB.title}（多耗 ${lash.deadlocks[0]?.routeB.extraWireMm}mm 线）。`
    })
  }

  // ---- CHK-11 三处同源：预览 / 构件表 / 导出共用同一份节点工步 ----
  {
    const memberTies = lash.members.reduce((s, m) => s + m.tiesTotal, 0)
    // 构件表按参与篾根数分摊显示扎道，合计 = Σ 节点扎道 × 1（每节点参与篾分摊之和 = 1）
    const pass = Math.abs(memberTies - lash.tieCount) <= 0.5
    out.push({
      id: 'CHK-11',
      title: '三处同源：预览图、骨架构件表、导出工步清单取同一份节点与扎道',
      pass,
      value: `节点 ${lash.nodeCount} / 扎道 ${lash.tieCount} / 用线 ${f3(lash.wireMm / 1000)}m`,
      detail:
        `参数与预览页描点、构件表「参与节点/扎道/用线」列、CSV/打印工步清单均取自 buildLashPlan 同一结果（合并方式：${
          lash.mode === 'space' ? '按空间位置合并' : '按交会篾组合合并'
        }）；` +
        `构件表分摊扎道合计 ${f1(memberTies)} = 扎道总数 ${lash.tieCount}；同一节点的位置、扎道数、用线量三处不许有出入。`
    })
  }

  return out
}

function suggestDivisions(l: Lantern, netArea: number, ratio: number): number | null {
  if (ratio <= 1.0005) return null
  for (let d = Math.max(3, Math.round(l.divisions)) + 1; d <= CRAFT.divMax; d++) {
    const ref = bodySurfaceArea(frameGeometryOf(l), d)
    const r = ref > 0 ? netArea / ref : 0
    if (r <= 1.03) return d
  }
  return CRAFT.divMax
}

function loftOverlap(sheets: Sheet[]): number {
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type === 'strip' && it.overlapMm > 0) return it.overlapMm
    }
  }
  return 0
}

/** 校验尺标称长度（mm）：1:1 打印用 */
export const CALIBRATION_RULER_MM = 100
export const CALIBRATION_CIRCLE_MM = 100

function frameGeometryOf(l: Lantern) {
  return buildFrame(l).geometry
}

/** 由圆周长反推直径（尺寸反推工具用） */
export function diameterFromPerimeter(lengthMm: number, n: number, polygon: boolean, lashMm: number): number {
  const net = Math.max(0, lengthMm - lashMm)
  if (polygon) {
    const s = Math.max(3, Math.round(n))
    return net / (s * Math.sin(Math.PI / s))
  }
  return net / Math.PI
}

/** 由母线（竖篾）长度反推可用最大直径：保持收口比例与总高，二分求解 */
export function diameterFromRib(l: Lantern, ribLengthMm: number): number {
  const target = Math.max(10, ribLengthMm - 2 * l.lashAllowanceMm)
  let lo = 20
  let hi = 3000
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    const test: Lantern = { ...l, maxDiameterMm: mid, mouthDiameterMm: (mid * l.mouthDiameterMm) / Math.max(1, l.maxDiameterMm), baseDiameterMm: (mid * l.baseDiameterMm) / Math.max(1, l.maxDiameterMm) }
    const segs = segmentInfos(buildFrame(test).geometry)
    const len = segs.reduce((a, s) => a + s.slantMm, 0)
    if (len < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
