/** 导出：构件清单 / 裁片清单 / 备料单 / 绑扎工步（CSV，本地生成，无外部请求） */
import type { FrameMember, Lantern, Panel } from './types'
import type { BatchMaterials, SingleLightMaterials } from './materials'
import type { LashPlan } from './lashing'
import { CRAFT, coveringSpec } from './craft'

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

export function membersCsv(l: Lantern, members: FrameMember[], plan?: LashPlan): string {
  const rowStat = plan ? new Map(plan.rows.map((r) => [r.rowKey, r])) : null
  const rows: (string | number)[][] = [
    [`花灯构件清单 · ${l.name}`],
    [`最大直径 ${l.maxDiameterMm}mm / 总高 ${l.totalHeightMm}mm / 绑扎余量 每端 ${l.lashAllowanceMm}mm / 节点合并 ${plan ? (plan.mode === 'position' ? '按空间位置' : '按交会篾组合') : '—'} / 版本 ${plan?.signature ?? '—'} / 生成 ${new Date().toLocaleString()}`],
    [],
    ['构件名称', '类别', '分组', '净长(mm)', '截取长度(mm,含余量)', '余量处数', '数量', '总截取长度(mm)', '参与节点(处)', '扎道(道)', '扎线(m)', '弯曲半径(mm)', '折角(°)', '备注']
  ]
  for (const m of members) {
    const st = rowStat?.get(m.id)
    rows.push([
      m.label,
      kindName(m.kind),
      m.group,
      m.rawLengthMm.toFixed(1),
      m.lengthMm.toFixed(1),
      m.lashJoints,
      m.qty,
      (m.lengthMm * m.qty).toFixed(1),
      st ? st.nodes : '—',
      st ? st.ties : '—',
      st ? st.wireM.toFixed(3) : '—',
      m.bendRadiusMm ? m.bendRadiusMm.toFixed(1) : '—',
      m.bendAngleDeg ? m.bendAngleDeg.toFixed(1) : '—',
      m.note || ''
    ])
  }
  const stock = members.reduce((s, m) => s + m.lengthMm * m.qty, 0)
  const raw = members.reduce((s, m) => s + m.rawLengthMm * m.qty, 0)
  const tiesAll = plan?.rows.reduce((s, r) => s + r.ties, 0)
  rows.push([])
  rows.push([
    '合计',
    '',
    '',
    raw.toFixed(1),
    '',
    members.reduce((s, m) => s + m.qty * m.lashJoints, 0),
    members.reduce((s, m) => s + m.qty, 0),
    stock.toFixed(1),
    plan?.nodeCount ?? '',
    tiesAll ?? '',
    plan?.totalWireM.toFixed(3) ?? '',
    '',
    '',
    plan ? `备料 ${(stock / 1000).toFixed(3)}m；扎道逐行合计 ${tiesAll} 道 = 节点图 ${plan.totalTies} 道（同源）` : `备料 ${(stock / 1000).toFixed(3)}m`
  ])
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
    [`生成 ${new Date().toLocaleString()} / 单位 mm·m²·m·g / 扎道 ${single.lashJoints} 道、扎线 ${single.lashM.toFixed(3)}m 取自绑扎节点图（同源）`],
    [],
    ['项目', '单灯用量', '单位', `批量 ${batch.count} 个（含 ${(batch.wasteRatio * 100).toFixed(0)}% 损耗）`],
    ['竹篾/铁丝（含绑扎余量）', single.frameM.toFixed(3), 'm', batch.frameM.toFixed(3)],
    ['竹篾构件净长', single.frameRawM.toFixed(3), 'm', batch.frameRawM.toFixed(3)],
    [`蒙面（${cov.name}，含缝份）`, single.coveringM2.toFixed(3), 'm²', batch.coveringM2.toFixed(3)],
    ['蒙面净面积（不含缝份）', single.coveringNetM2.toFixed(3), 'm²', batch.coveringNetM2.toFixed(3)],
    ['扎线（道，每道 0.5m，取自节点图）', single.lashM.toFixed(3), 'm', batch.lashM.toFixed(3)],
    ['胶', single.glueG.toFixed(1), 'g', batch.glueG.toFixed(1)],
    ['LED 灯珠建议', single.ledCount, '颗', batch.ledCount],
    [],
    ['灯体体积', single.volumeL.toFixed(3), 'L', batch.volumeL.toFixed(3)],
    ['灯体表面积', single.surfaceM2.toFixed(3), 'm²', batch.surfaceM2.toFixed(3)]
  ]
  return toCsv(rows)
}

/** 绑扎工步清单（与预览、构件表同一份 LashPlan 出图出表） */
export function lashingCsv(l: Lantern, plan: LashPlan): string {
  const rows: (string | number)[][] = []
  const modeText = plan.mode === 'position' ? '按空间位置合并' : '按交会篾组合合并'
  rows.push([`绑扎工步清单 · ${l.name}`])
  rows.push([
    `合并方式 ${modeText} · 版本 ${plan.signature} · 位置精度 mm(0.1)，去重按 1mm 落格 · 每道扎线 ${CRAFT.lashPerJointM}m · 生成 ${new Date().toLocaleString()}`
  ])
  rows.push([])
  rows.push(['汇总', `节点 ${plan.nodeCount} 处`, `扎道 ${plan.totalTies} 道`, `扎线 ${plan.totalWireM.toFixed(3)}m（${(plan.totalWireM * 100).toFixed(1)}cm）`, `工步 ${plan.stepCount} 步`])
  rows.push([])

  rows.push(['== 一、工步清单（按序照做；同一步内节点互不压绕线，可同时上）=='])
  rows.push(['工步', '层带', '波次', '内容', '节点编号', '节点数', '扎道(道)', '扎线(m)'])
  for (const st of plan.steps) {
    rows.push([st.ordinal, st.bandName, st.wave, st.title, st.nodeCodes.join(' '), st.nodeCodes.length, st.ties, st.wireM.toFixed(3)])
  }
  rows.push([])

  rows.push(['== 二、节点明细（坐标 mm，与灯体预览同一取数）=='])
  rows.push(['节点', '层带', '棱号', '种类', 'X(mm)', 'Y(mm)', 'Z(mm)', '取整格(mm)', '扎道(道)', '扎线(m)', '交会篾', '备注'])
  for (const nd of plan.nodes) {
    rows.push([
      nd.code,
      nd.bandName,
      nd.corner >= 0 ? nd.corner + 1 : '轴',
      nd.label,
      nd.xMm.toFixed(1),
      nd.yMm.toFixed(1),
      nd.zMm.toFixed(1),
      `(${nd.gx},${nd.gy},${nd.gz})`,
      nd.ties,
      nd.wireM.toFixed(3),
      nd.memberLabels.join(' / '),
      [nd.crossBand ? '跨层并错（卡死）' : '', nd.boundary ? '贴整毫米边界' : '', nd.shifted ? `已${nd.shifted.along}挪 ${nd.shifted.dMm}mm` : '']
        .filter(Boolean)
        .join('；')
    ])
  }
  rows.push([])

  rows.push(['== 三、逐行扎线记账（与骨架构件表逐行一致）=='])
  rows.push(['构件行', '数量', '参与节点(处)', '扎道(道)', '扎线(m)'])
  for (const r of plan.rows) rows.push([r.label, r.qty, r.nodes, r.ties, r.wireM.toFixed(3)])
  rows.push([])

  if (plan.deadlocks.length) {
    rows.push(['== 四、卡死节点与两条解法（改完作废本清单重来）=='])
    for (const d of plan.deadlocks) {
      rows.push([d.code, d.posText, `${d.placeA} ⇄ ${d.placeB} 互相卡住`])
    }
    if (plan.fixes) {
      rows.push([])
      rows.push(['路线一（改绑扎次序）', plan.fixes.reorder.title, `节点 +${plan.fixes.reorder.addedNodes}`, `扎道 +${plan.fixes.reorder.addedTies}`, `工步 +${plan.fixes.reorder.addedSteps}`, `扎线 +${plan.fixes.reorder.addedWireM.toFixed(3)}m`])
      rows.push(['路线二（挪节点）', plan.fixes.shift.title, `扎道 +${plan.fixes.shift.addedTies}`, `引弯 ${plan.fixes.shift.addedBendMm}mm`, `工步 +${plan.fixes.shift.addedSteps}`, `扎线 +${plan.fixes.shift.addedWireM.toFixed(3)}m`])
    }
  }

  // 守恒行（逐节点扎线加总必须与总量一致，差 1cm 可见）
  const sumWire = plan.nodes.reduce((s, nd) => s + nd.wireM, 0)
  const sumTies = plan.nodes.reduce((s, nd) => s + nd.ties, 0)
  rows.push([])
  rows.push(['守恒', `逐节点扎道 ${sumTies} 道`, `逐节点扎线 ${sumWire.toFixed(3)}m`, `= 总量 ${plan.totalTies} 道 / ${plan.totalWireM.toFixed(3)}m`, Math.abs(sumWire - plan.totalWireM) <= 0.001 ? '一致（Δ≤1cm）' : '不一致！'])
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
