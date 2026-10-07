/**
 * 材料统计与备料单（规格书 §4.6 / §5）
 * 备料按含余量长度；批量 = 单灯 × N × (1 + 损耗率)。
 */
import type { FrameMember, Lantern } from './types'
import { bodySurfaceArea, bodyVolume, r1, r3 } from './geometry'
import { buildFrame } from './frame'
import { buildPanels } from './panels'
import { buildLashPlan, lashOptionsFor } from './lashing'
import { CRAFT, coveringSpec } from './craft'

export interface SingleLightMaterials {
  /** 竹篾/铁丝备料总长（含绑扎余量，m） */
  frameM: number
  /** 全部构件净长（m） */
  frameRawM: number
  /** 蒙面面积（含缝份，m²） */
  coveringM2: number
  /** 蒙面净面积（不含缝份，m²） */
  coveringNetM2: number
  /** 扎线（m）——取自绑扎节点图同一份工步：Σ 逐节点扎道 × 每道用量 */
  lashM: number
  /** 胶（g） */
  glueG: number
  /** 绑扎余量处数（取自构件表 qty×lashJoints，参与扎道数计算） */
  lashJoints: number
  /** 绑扎节点图：节点数 */
  lashNodes: number
  /** 绑扎节点图：扎道数（= 逐节点扎道之和） */
  lashTies: number
  /** 灯体体积（L） */
  volumeL: number
  /** LED 建议颗数（不做电气设计，仅数量建议） */
  ledCount: number
  /** 灯体表面积（m²） */
  surfaceM2: number
}

export interface BatchMaterials extends SingleLightMaterials {
  count: number
  wasteRatio: number
}

export function computeMaterials(l: Lantern): SingleLightMaterials {
  const frame = buildFrame(l)
  const panelRes = buildPanels(l)
  const cov = coveringSpec(l.covering)
  const divisions = Math.max(3, Math.round(l.divisions))

  const frameMm = frame.members.reduce((s, m: FrameMember) => s + m.lengthMm * m.qty, 0)
  const frameRawMm = frame.members.reduce((s, m: FrameMember) => s + m.rawLengthMm * m.qty, 0)
  const joints = frame.members.reduce((s, m: FrameMember) => s + m.qty * m.lashJoints, 0)
  // 扎线与绑扎节点图同源：逐节点扎道 × 每道用量（节点合并方式取自灯样参数）
  const lash = buildLashPlan(l, lashOptionsFor(l))
  const cutArea = panelRes.cutAreaMm2
  const volumeL = bodyVolume(frame.geometry) / 1_000_000
  const led = Math.max(CRAFT.led.min, Math.ceil(volumeL * CRAFT.led.perLiter))

  return {
    frameM: r3(frameMm / 1000),
    frameRawM: r3(frameRawMm / 1000),
    coveringM2: r3(cutArea / 1_000_000),
    coveringNetM2: r3(panelRes.netAreaMm2 / 1_000_000),
    lashM: r3(lash.wireMm / 1000),
    glueG: r1((cutArea / 1_000_000) * cov.gluePerM2),
    lashJoints: joints,
    lashNodes: lash.nodeCount,
    lashTies: lash.tieCount,
    volumeL: r3(volumeL),
    ledCount: led,
    surfaceM2: r3(bodySurfaceArea(frame.geometry, divisions) / 1_000_000)
  }
}

/** 批量化：单灯 × N × (1 + 损耗率)；LED 按颗数 × N（不参与损耗率） */
export function computeBatch(single: SingleLightMaterials, count: number, wasteRatio: number): BatchMaterials {
  const k = count * (1 + wasteRatio)
  return {
    ...single,
    count,
    wasteRatio,
    frameM: r3(single.frameM * k),
    frameRawM: r3(single.frameRawM * k),
    coveringM2: r3(single.coveringM2 * k),
    coveringNetM2: r3(single.coveringNetM2 * k),
    lashM: r3(single.lashM * k),
    glueG: r1(single.glueG * k),
    volumeL: r3(single.volumeL * count),
    ledCount: single.ledCount * count,
    surfaceM2: r3(single.surfaceM2 * count)
  }
}
