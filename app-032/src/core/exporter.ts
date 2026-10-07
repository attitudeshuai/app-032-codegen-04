/** 导出：构件清单 / 裁片清单 / 备料单（CSV，本地生成，无外部请求） */
import type { FrameMember, Lantern, Panel } from './types'
import type { BatchMaterials, SingleLightMaterials } from './materials'
import type { LashPlan } from './lashing'
import { coveringSpec } from './craft'

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: (string | number)[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function membersCsv(l: Lantern, members: FrameMember[]): string {
  const rows: (string | number)[][] = [
    [`花灯构件清单 · ${l.name}`],
    [`最大直径 ${l.maxDiameterMm}mm / 总高 ${l.totalHeightMm}mm / 绑扎余量 每端 ${l.lashAllowanceMm}mm / 生成 ${new Date().toLocaleString()}`],
    [],
    ['构件名称', '类别', '分组', '净长(mm)', '截取长度(mm,含余量)', '余量处数', '数量', '总截取长度(mm)', '弯曲半径(mm)', '折角(°)', '备注']
  ]
  for (const m of members) {
    rows.push([
      m.label,
      kindName(m.kind),
      m.group,
      m.rawLengthMm.toFixed(1),
      m.lengthMm.toFixed(1),
      m.lashJoints,
      m.qty,
      (m.lengthMm * m.qty).toFixed(1),
      m.bendRadiusMm ? m.bendRadiusMm.toFixed(1) : '—',
      m.bendAngleDeg ? m.bendAngleDeg.toFixed(1) : '—',
      m.note || ''
    ])
  }
  const stock = members.reduce((s, m) => s + m.lengthMm * m.qty, 0)
  const raw = members.reduce((s, m) => s + m.rawLengthMm * m.qty, 0)
  rows.push([])
  rows.push(['合计', '', '', raw.toFixed(1), '', '', members.reduce((s, m) => s + m.qty, 0), stock.toFixed(1), '', '', `备料 ${(stock / 1000).toFixed(3)}m`])
  return toCsv(rows)
}

export function panelsCsv(l: Lantern, panels: Panel[]): string {
  const rows: (string | number)[][] = [
    [`蒙面裁片清单 · ${l.name}`],
    [`蒙面 ${coveringSpec(l.covering).name} / 缝份 每边 ${l.seamAllowanceMm}mm（已含在裁片尺寸内）/ 生成 ${new Date().toLocaleString()}`],
    [],
    ['裁片编号', '名称', '形状', '净上宽(mm)', '净下宽(mm)', '净高(mm)', '裁切上宽(mm)', '裁切下宽(mm)', '裁切高(mm)', '半径/对边(mm)', '数量', '对位标记数']
  ]
  for (const p of panels) {
    rows.push([
      p.id,
      p.label,
      shapeName(p.shape),
      p.rawWidthTopMm.toFixed(1),
      p.rawWidthBottomMm.toFixed(1),
      p.rawHeightMm.toFixed(1),
      p.widthTopMm.toFixed(1),
      p.widthBottomMm.toFixed(1),
      p.heightMm.toFixed(1),
      p.radiusMm ? p.radiusMm.toFixed(1) : '—',
      p.qty,
      p.marksMm.length
    ])
  }
  return toCsv(rows)
}

export function materialsCsv(
  l: Lantern,
  single: SingleLightMaterials,
  batch: BatchMaterials
): string {
  const cov = coveringSpec(l.covering)
  const rows: (string | number)[][] = [
    [`备料单 · ${l.name}`],
    [`生成 ${new Date().toLocaleString()} / 单位 mm·m²·m·g`],
    [],
    ['项目', '单灯用量', '单位', `批量 ${batch.count} 个（含 ${(batch.wasteRatio * 100).toFixed(0)}% 损耗）`],
    ['竹篾/铁丝（含绑扎余量）', single.frameM.toFixed(3), 'm', batch.frameM.toFixed(3)],
    ['竹篾构件净长', single.frameRawM.toFixed(3), 'm', batch.frameRawM.toFixed(3)],
    [`蒙面（${cov.name}，含缝份）`, single.coveringM2.toFixed(3), 'm²', batch.coveringM2.toFixed(3)],
    ['蒙面净面积（不含缝份）', single.coveringNetM2.toFixed(3), 'm²', batch.coveringNetM2.toFixed(3)],
    ['扎线（绑扎节点图扎道合计，三处同源）', single.lashM.toFixed(3), 'm', batch.lashM.toFixed(3)],
    ['胶', single.glueG.toFixed(1), 'g', batch.glueG.toFixed(1)],
    ['LED 灯珠建议', single.ledCount, '颗', batch.ledCount],
    [],
    ['灯体体积', single.volumeL.toFixed(3), 'L', batch.volumeL.toFixed(3)],
    ['灯体表面积', single.surfaceM2.toFixed(3), 'm²', batch.surfaceM2.toFixed(3)]
  ]
  return toCsv(rows)
}

export function kindName(k: FrameMember['kind']): string {
  const map: Record<FrameMember['kind'], string> = {
    vertical: '竖篾',
    ring: '横篾',
    mouth_ring: '收口圈',
    base_ring: '底盘圈',
    rib: '母线篾',
    spoke: '辐条/中轴'
  }
  return map[k]
}

export function shapeName(s: Panel['shape']): string {
  const map: Record<Panel['shape'], string> = {
    trapezoid: '梯形',
    rectangle: '矩形',
    sector: '扇形',
    circle: '圆形/正多边形',
    triangle: '三角形'
  }
  return map[s]
}

// ---------------------------------------------------------------------------
// 绑扎节点图 / 工步清单导出（与预览、构件表同源的同一份 LashPlan）
// ---------------------------------------------------------------------------

const f1csv = (v: number) => v.toFixed(1)

/** 工步清单 CSV：新人照单绑扎的主清单 */
export function lashStepsCsv(l: Lantern, p: LashPlan): string {
  const rows: (string | number)[][] = [
    [`绑扎工步清单 · ${l.name}`],
    [
      `合并方式：${p.mode === 'space' ? '按空间位置合并' : '按交会篾组合合并'} · 棱数 ${l.sides} · 层数 ${l.layers.length} · 缠裹宽度 ${p.wrapWidthMm}mm · 位置取整 0.1mm（去重边界 ±0.05mm）· 生成 ${new Date().toLocaleString()}`
    ],
    [p.rules.stepText],
    [p.rules.roundText],
    [p.rules.boundaryText],
    [p.rules.wireText],
    [],
    ['工步', '所属层', '工步内容', '节点编号', '节点类别', '位置X(mm)', '高度Y(mm)', '位置Z(mm)', '扎道数', '本步用线(mm)', '交会篾数', '参与构件', '说明']
  ]
  for (const st of p.steps) {
    st.nodes.forEach((n, k) => {
      rows.push([
        k === 0 ? st.no : '',
        k === 0 ? `第 ${st.layer + 1} 层` : '',
        k === 0 ? st.title : '',
        n.id,
        n.category === 'cross' ? '交会' : n.category === 'joint' ? '接头余量' : '交会+接头',
        f1csv(n.pos.x),
        f1csv(n.pos.y),
        f1csv(n.pos.z),
        n.tieCount,
        k === 0 ? f1csv(st.wireMm) : '',
        n.strips.length,
        n.memberIds.join(' '),
        n.note + (n.suspicious ? `（⚠ ${n.suspiciousReason}）` : '')
      ])
    })
  }
  rows.push([])
  rows.push(['合计', '', '', `${p.nodeCount} 处节点`, '', '', '', '', p.tieCount, f1csv(p.wireMm), '', '', `扎线总量 ${(p.wireMm / 1000).toFixed(3)}m = ${p.tieCount} 道 × 0.5m/道`])
  if (!p.schedulable) {
    rows.push([])
    for (const d of p.deadlocks) {
      rows.push(['未排开', '', d.reason])
      rows.push(['路A', '', d.routeA.title, '', '', '', '', '', d.routeA.extraTies, f1csv(d.routeA.extraWireMm), '', '', d.routeA.detail])
      rows.push(['路B', '', d.routeB.title, '', '', '', '', '', d.routeB.extraTies, f1csv(d.routeB.extraWireMm), '', '', d.routeB.detail])
    }
  }
  return toCsv(rows)
}

/** 逐节点明细 CSV（含余量动作数，供复核扎道数怎么来的） */
export function lashNodesCsv(l: Lantern, p: LashPlan): string {
  const rows: (string | number)[][] = [
    [`绑扎节点明细 · ${l.name}`],
    [`合并方式 ${p.mode === 'space' ? '按空间位置' : '按交会篾组合'} · 余量处数合计 ${p.jointTotal}（取自构件表）· 生成 ${new Date().toLocaleString()}`],
    [],
    ['节点', '所属层', '类别', '位置X', '高度Y', '位置Z', '交会动作数', '余量动作数', '扎道数', '用线(mm)', '工步号', '涉及篾实例', '可疑并点']
  ]
  for (const n of p.nodes) {
    rows.push([
      n.id,
      n.layer + 1,
      n.category,
      f1csv(n.pos.x),
      f1csv(n.pos.y),
      f1csv(n.pos.z),
      n.crossCount,
      n.jointCount,
      n.tieCount,
      f1csv(n.wireMm),
      n.stepNo ?? '卡住',
      n.strips.join(' '),
      n.suspicious ? n.suspiciousReason || '是' : ''
    ])
  }
  rows.push([])
  rows.push(['合计', '', '', '', '', '', p.nodes.reduce((s, n) => s + n.crossCount, 0), p.nodes.reduce((s, n) => s + n.jointCount, 0), p.tieCount, f1csv(p.wireMm), '', '', ''])
  return toCsv(rows)
}

/** 构件绑扎用量 CSV：骨架构件表每一行参与几处节点、用掉几道扎线（同源） */
export function lashMembersCsv(l: Lantern, p: LashPlan): string {
  const rows: (string | number)[][] = [
    [`构件绑扎用量 · ${l.name}`],
    [`节点合并方式：${p.mode === 'space' ? '按空间位置合并' : '按交会篾组合合并'} · 共节点的扎道按参与篾根数分摊，合计守恒 · 生成 ${new Date().toLocaleString()}`],
    [],
    ['构件行', '名称', '数量', '单根参与节点数', '单根扎道(分摊)', '单根用线(mm)', '该型号节点参与总次', '扎道合计', '用线合计(mm)']
  ]
  for (const m of p.members) {
    rows.push([m.memberId, m.label, m.qty, m.nodesPer, m.tiesPer, f1csv(m.wireMmPer), m.nodeParticipations, f1csv(m.tiesTotal), f1csv(m.wireMmTotal)])
  }
  rows.push([])
  rows.push(['合计', '', p.members.reduce((s, m) => s + m.qty, 0), '', '', '', p.members.reduce((s, m) => s + m.nodeParticipations, 0), f1csv(p.members.reduce((s, m) => s + m.tiesTotal, 0)), f1csv(p.members.reduce((s, m) => s + m.wireMmTotal, 0))])
  return toCsv(rows)
}
