/**
 * 绑扎节点图与工步清单（规格书 §绑扎节点图）
 *
 * 单一数据源原则：
 *  - 每根篾的层号、棱号与走向只取自 buildGeometry()（轮廓/截面/棱长/周长）
 *    与 buildFrame()（骨架构件与每行 lashJoints 绑扎余量处数），本模块不另算一套尺寸；
 *  - 构件表每行的「参与节点数 / 扎道数 / 用线量」、灯体预览上的节点与扎道、
 *    导出的三份清单全部取本模块产出的同一份 LashPlan；
 *  - 位置精度与构件表同一档：计算值保留 0.1mm（r1），去重按 1mm 取整落格。
 */
import type { FrameMember, Lantern, LashMergeMode } from './types'
import { buildGeometry, r1, type Geometry } from './geometry'
import { buildFrame, type FrameResult } from './frame'
import { CRAFT } from './craft'

/** 去重取整档：位置按毫米取整（落格键） */
export const POS_GRID_MM = 1
/** 与构件表同一档的显示/计算精度：mm 一位小数 */
export const POS_TOL_MM = 0.1
/** 绕线经过处（单个扎道的绕线包络半径，mm）：两处包络相压即不得同一工步 */
export const FOOTPRINT_MM = 8
/** 相邻层最小安全间距（mm）：小于绕线包络即判互相压住风险 */
export const MIN_LEVEL_GAP_MM = 10
/** 贴边判定带（mm）：小数部分落在 0.5±0.05 时给出边界提示 */
const BOUNDARY_BAND = 0.05

/** 交会种类：交会扎 / 端头收口（吃余量）/ 接头（吃余量）/ 轴心扎 / 辐条内端归轴（不吃余量） */
export type IncidenceKind = 'crossing' | 'tuck' | 'splice' | 'axle' | 'hub'

/** 同点先后次序（小者先绑）：交会 → 辐条归轴 → 端头收口 → 环间接头 */
const KIND_RANK: Record<IncidenceKind, number> = { crossing: 0, axle: 0, hub: 1, tuck: 2, splice: 3 }
const KIND_LABEL: Record<IncidenceKind, string> = {
  crossing: '竖横交会',
  tuck: '端头收口',
  splice: '横篾接头',
  axle: '中轴归轴',
  hub: '辐条归轴'
}

interface RawIncidence {
  /** 稳定主键（改棱数/层数后做差异对比用） */
  key: string
  /** 所属篾的组合身份（组合合并用） */
  memberKey: string
  kind: IncidenceKind
  /** 该交会归属的横篾截面（0=底盘、L=收口），非截面节点为 -1 */
  section: number
  /** 空间位置（mm，未取整） */
  x: number
  y: number
  z: number
  note?: string
}

export interface LashNode {
  /** 稳定主键（取首要交会的身份） */
  primaryKey: string
  /** 显示编号，如 N12 */
  code: string
  label: string
  /** 归属层带序号（自底向上 0 起） */
  band: number
  bandName: string
  section: number
  corner: number
  kind: IncidenceKind
  /** 交会篾组合身份（去重后的 memberKey 集合） */
  members: string[]
  memberLabels: string[]
  /** 位置：计算值（mm，1 位小数，与构件表同档） */
  xMm: number
  yMm: number
  zMm: number
  /** 位置：取整落格（mm，整数；去重判定用） */
  gx: number
  gy: number
  gz: number
  /** 本节点扎几道 */
  ties: number
  /** 扎线用量（m）= ties × CRAFT.lashPerJointM */
  wireM: number
  /** 逐道扎线的记账行（memberRow 指向构件表语义行） */
  tieRows: { memberRow: string; kind: IncidenceKind }[]
  /** 是否由多种交会合并而成（组合模式下被拆开的同点异种扎） */
  mergedKinds: IncidenceKind[]
  /** 取整后是否落在整毫米边界 ±0.05mm（贴边提示） */
  boundary: boolean
  /** 卡死标记：一个格里混进了两个层带（位置合并并错） */
  crossBand?: boolean
  crossBandNames?: string[]
  /** 被解法挪动后的提示（路线 B） */
  shifted?: { dMm: number; along: string }
}

export interface LashStep {
  /** 全灯统一工步序号（自 1 起） */
  ordinal: number
  /** 层带内波次 */
  wave: number
  band: number
  bandName: string
  /** 本步可同时绑扎的节点 */
  nodeCodes: string[]
  nodeKeys: string[]
  ties: number
  wireM: number
  title: string
}

/** 构件表一行（语义行）的绑扎统计 */
export interface LashRowStat {
  rowKey: string
  label: string
  qty: number
  /** 该行（含其全部根数）参与的节点处数（按节点去重） */
  nodes: number
  /** 用掉几道扎线（逐道记账加总） */
  ties: number
  /** 扎线用量 m */
  wireM: number
}

export interface LashDeadlock {
  /** 被卡在同一格里的节点主键 */
  nodeKey: string
  code: string
  posText: string
  /** 互相卡住的两处（层带工序名） */
  placeA: string
  placeB: string
}

export interface LashFixOption {
  id: 'reorder' | 'shift'
  title: string
  plan: LashPlan
  /** 相对原方案各自让出/多付的代价 */
  addedNodes: number
  addedTies: number
  addedSteps: number
  addedWireM: number
  /** 路线 B：竹篾引弯量（mm，不是扎线） */
  addedBendMm: number
  detail: string
}

export interface LashPlan {
  mode: LashMergeMode
  signature: string
  nodes: LashNode[]
  steps: LashStep[]
  rows: LashRowStat[]
  deadlocks: LashDeadlock[]
  fixes: { reorder: LashFixOption; shift: LashFixOption } | null
  nodeCount: number
  totalTies: number
  totalWireM: number
  stepCount: number
  /** 余量处数记账：吃余量的交会（端头+接头）应 = 构件表 Σqty×lashJoints */
  allowanceIncidences: number
  allowanceJointsFromFrame: number
  /** 位置合并并错（跨层带落格）的节点数 */
  crossBandCount: number
  boundaryCount: number
  generatedAt: string
}

/* ------------------------------------------------------------------ */
/* 层带定义                                                            */
/* ------------------------------------------------------------------ */

function bandNameOf(section: number, last: number): string {
  if (section < 0) return '收口肩部（支撑篾）'
  if (section === 0) return '底盘层'
  if (section === last) return '收口层'
  return `第 ${section} 层`
}

/* ------------------------------------------------------------------ */
/* 交会点枚举（位置全部取自 geometry.sections / 轮廓）                  */
/* ------------------------------------------------------------------ */

function cornerAngle(j: number, n: number): number {
  return -Math.PI / 2 + (2 * Math.PI * j) / n
}

function buildIncidences(l: Lantern, g: Geometry, frame: FrameResult): RawIncidence[] {
  const out: RawIncidence[] = []
  const L = g.sections.length - 1
  const push = (ic: RawIncidence) => out.push(ic)
  const secY = (s: number) => g.sections[s].yMm
  const secR = (s: number) => g.sections[s].radiusMm

  if (l.kind === 'polyhedron') {
    // 正多面体：节点 = 顶点；每顶点 1 道收口扎，记账到该顶点编号最小的那根棱篾
    // （构件表 6/12 根棱篾 × 两端各 1 处余量，恰好逐道对应）
    const R = g.maxR
    if (g.n <= 4) {
      // 正四面体：底面三角落在 y=0，顶点在高度处（外接球心在 y=R/3）
      const baseR = R * Math.sqrt(2 / 3)
      const h = (4 * R) / 3
      const verts: { id: string; x: number; y: number; z: number }[] = []
      for (let j = 0; j < 3; j++) {
        const a = cornerAngle(j, 3)
        verts.push({ id: `B${j}`, x: baseR * Math.cos(a), y: 0, z: baseR * Math.sin(a) })
      }
      verts.push({ id: 'A', x: 0, y: h, z: 0 })
      const edges: [string, string][] = [
        ['B0', 'B1'],
        ['B1', 'B2'],
        ['B2', 'B0'],
        ['A', 'B0'],
        ['A', 'B1'],
        ['A', 'B2']
      ]
      // 每根棱篾两端各 1 处端头（主键逐棱，组合模式逐棱成道；位置模式按顶点并为 1 道）
      const vNames: Record<string, string> = { B0: '底盘层', B1: '底盘层', B2: '底盘层', A: '顶顶点层' }
      edges.forEach(([p, q], ei) => {
        for (const vid of [p, q]) {
          const v = verts.find((x) => x.id === vid)!
          push({ key: `PV:tetra:${vid}:e${ei}`, memberKey: `E#${ei}`, kind: 'tuck', section: 0, x: v.x, y: v.y, z: v.z, note: `bandName:${vNames[vid]}` })
        }
      })
    } else {
      // 正八面体：底盘极点 y=0 → 赤道 y=R → 收口极点 y=2R（三个层带）
      const verts: { id: string; band: number; section: number; x: number; y: number; z: number }[] = [
        { id: 'D', band: 0, section: 0, x: 0, y: 0, z: 0 },
        { id: 'T', band: 2, section: g.sections.length - 1, x: 0, y: 2 * R, z: 0 }
      ]
      for (let j = 0; j < 4; j++) {
        const a = cornerAngle(j, 4)
        verts.push({ id: `E${j}`, band: 1, section: 0, x: R * Math.cos(a), y: R, z: R * Math.sin(a) })
      }
      const edges: [string, string][] = []
      for (let j = 0; j < 4; j++) {
        edges.push(['T', `E${j}`], ['D', `E${j}`], [`E${j}`, `E${(j + 1) % 4}`])
      }
      const vNames: Record<string, string> = { D: '底盘极点层', T: '收口极点层' }
      for (let j = 0; j < 4; j++) vNames[`E${j}`] = '赤道层'
      edges.forEach(([p, q], ei) => {
        for (const vid of [p, q]) {
          const v = verts.find((x) => x.id === vid)!
          push({
            key: `PV:octa:${vid}:e${ei}`,
            memberKey: `E#${ei}`,
            kind: 'tuck',
            section: v.section,
            x: v.x,
            y: v.y,
            z: v.z,
            note: `band:${v.band}|bandName:${vNames[vid]}`
          })
        }
      })
    }
    return out
  }

  const n = g.n
  const at = (s: number, j: number) => {
    const a = cornerAngle(j, n)
    const r = secR(s)
    return { x: r * Math.cos(a), y: secY(s), z: r * Math.sin(a), a }
  }

  if (g.polygon) {
    // 棱柱 / 方灯：每截面每棱角 = 竖篾 × 横篾交会；每根横篾（边）的 1 处接头余量落在其编号端棱角
    for (let s = 0; s <= L; s++) {
      for (let j = 0; j < n; j++) {
        const p = at(s, j)
        push({ key: `X:s${s}:c${j}`, memberKey: `V#${j}`, kind: 'crossing', section: s, ...p })
        push({ key: `X:s${s}:c${j}`, memberKey: `R${s}#${j}`, kind: 'crossing', section: s, ...p })
        // 边篾 j 的接头余量落在棱角 j（每棱角恰好 1 处）
        push({ key: `S:s${s}:c${j}`, memberKey: `R${s}#${j}`, kind: 'splice', section: s, ...p })
      }
    }
    // 竖篾两端各 1 处端头收口（不随截面循环重复）
    for (let j = 0; j < n; j++) {
      const p0 = at(0, j)
      const pL = at(L, j)
      push({ key: `T:s0:c${j}`, memberKey: `V#${j}`, kind: 'tuck', section: 0, ...p0 })
      push({ key: `T:sL:c${j}`, memberKey: `V#${j}`, kind: 'tuck', section: L, ...pL })
    }

    // 方形走马灯：中轴 + 上下辐条（仅 box）。
    // 辐条每根只有 1 处绑扎余量（外端接头）；内端在轴心处没有余量，组合模式下另计 1 道归轴扎。
    if (l.kind === 'box') {
      for (const [s, tag, name] of [
        [0, 'B', '底盘'],
        [L, 'T', '收口']
      ] as const) {
        // 中轴每端 1 处端头收口（吃中轴两端余量）
        push({ key: `H:${tag}`, memberKey: 'AX', kind: 'axle', section: s, x: 0, y: secY(s), z: 0, note: `${name}中轴归轴` })
        push({ key: `AXT:${tag}`, memberKey: 'AX', kind: 'tuck', section: s, x: 0, y: secY(s), z: 0 })
        for (let j = 0; j < n; j++) {
          const p = at(s, j)
          // 辐条外端接头落在棱角交会处（吃辐条 1 处余量）
          push({ key: `SP:${tag}:c${j}`, memberKey: `SP#${tag}${j}`, kind: 'splice', section: s, ...p })
          // 辐条内端归轴（不吃余量）
          push({ key: `H:${tag}`, memberKey: `SP#${tag}${j}`, kind: 'hub', section: s, x: 0, y: secY(s), z: 0 })
        }
      }
    }
    return out
  }

  // 旋转体：n 根母线篾 × 每截面交会；圆形圈以 0 号母线处为唯一接头
  for (let s = 0; s <= L; s++) {
    for (let j = 0; j < n; j++) {
      const p = at(s, j)
      push({ key: `X:s${s}:c${j}`, memberKey: `V#${j}`, kind: 'crossing', section: s, ...p })
      // 同一根圆形圈在每个交会处都在场（接头余量只有 1 处，落在 c0）
      push({ key: `X:s${s}:c${j}`, memberKey: `R${s}#0`, kind: 'crossing', section: s, ...p })
    }
    const p0 = at(s, 0)
    push({ key: `S:s${s}:c0`, memberKey: `R${s}#0`, kind: 'splice', section: s, ...p0 })
  }
  for (let j = 0; j < n; j++) {
    const pb = at(0, j)
    const pt = at(L, j)
    push({ key: `T:s0:c${j}`, memberKey: `V#${j}`, kind: 'tuck', section: 0, ...pb })
    push({ key: `T:sL:c${j}`, memberKey: `V#${j}`, kind: 'tuck', section: L, ...pt })
  }

  // 收口支撑篾（旋转体收口时）：在肩部中点与 n 根母线交会，另有 1 处自身接头
  if (frame.members.some((m) => m.role === 'shoulder_ring')) {
    const y0 = g.heightMm * (1 - g.kTop)
    const ySh = (y0 + g.heightMm) / 2
    const rSh = g.profile.length
      ? secRadiusAt(g, ySh)
      : (secR(L) + g.maxR) / 2
    for (let j = 0; j < n; j++) {
      const a = cornerAngle(j, n)
      push({
        key: `X:sh:c${j}`,
        memberKey: `V#${j}`,
        kind: 'crossing',
        section: -1,
        x: rSh * Math.cos(a),
        y: ySh,
        z: rSh * Math.sin(a)
      })
      push({
        key: `X:sh:c${j}`,
        memberKey: 'SH#0',
        kind: 'crossing',
        section: -1,
        x: rSh * Math.cos(a),
        y: ySh,
        z: rSh * Math.sin(a)
      })
    }
    const a0 = cornerAngle(0, n)
    push({ key: 'S:sh:c0', memberKey: 'SH#0', kind: 'splice', section: -1, x: rSh * Math.cos(a0), y: ySh, z: rSh * Math.sin(a0) })
  }

  return out
}

function secRadiusAt(g: Geometry, y: number): number {
  // 轮廓线性插值（与 radiusAtY 等价，避免循环依赖再 import）
  const p = g.profile
  if (y <= p[0].y) return p[0].x
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i].y) {
      const span = p[i].y - p[i - 1].y
      const t = span < 1e-9 ? 0 : (y - p[i - 1].y) / span
      return p[i - 1].x + (p[i].x - p[i - 1].x) * t
    }
  }
  return p[p.length - 1].x
}

/* ------------------------------------------------------------------ */
/* 取整与去重                                                          */
/* ------------------------------------------------------------------ */

/** 毫米取整（四舍五入；边界 0.5mm 处显式可判） */
export function gridRound(v: number): number {
  return Math.round(v)
}

function frac(v: number): number {
  return v - Math.floor(v)
}

function isBoundary(v: number): boolean {
  const f = frac(Math.abs(v))
  return Math.abs(f - 0.5) < BOUNDARY_BAND
}

function cellKeyOf(x: number, y: number, z: number): string {
  return `${gridRound(x)},${gridRound(y)},${gridRound(z)}`
}

/* ------------------------------------------------------------------ */
/* 构件表语义行映射（单一数据源：行取自 buildFrame）                    */
/* ------------------------------------------------------------------ */

export interface MemberRow {
  rowKey: string
  member: FrameMember
  /** 该行使用的 memberKey 前缀/精确集合 */
  match: (mk: string) => boolean
}

export function memberRows(l: Lantern, frame: FrameResult): MemberRow[] {
  void l
  const rows: MemberRow[] = []
  for (const m of frame.members) {
    if (m.kind === 'vertical' || m.kind === 'rib') {
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk.startsWith('V#') })
    } else if (m.role === 'shoulder_ring') {
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk === 'SH#0' })
    } else if (m.kind === 'ring' || m.kind === 'mouth_ring' || m.kind === 'base_ring') {
      const s = m.ringSection ?? 0
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk.startsWith(`R${s}#`) })
    } else if (m.label === '中轴（走马灯转轴）') {
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk === 'AX' })
    } else if (m.label === '上下辐条') {
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk.startsWith('SP#') })
    } else {
      // 多面体棱篾
      rows.push({ rowKey: m.id, member: m, match: (mk) => mk.startsWith('E#') })
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* 签名（改棱数/层数整张重排的作废依据）                                */
/* ------------------------------------------------------------------ */

export function planSignature(l: Lantern, mode: LashMergeMode): string {
  const parts = [
    l.kind,
    Math.round(l.sides),
    l.maxDiameterMm,
    l.mouthDiameterMm,
    l.baseDiameterMm,
    l.mouthStyle,
    l.bottomStyle,
    l.smoothness.toFixed(2),
    l.ctrl1.x.toFixed(2),
    l.ctrl1.y.toFixed(2),
    l.ctrl2.x.toFixed(2),
    l.ctrl2.y.toFixed(2),
    l.layers.map((ly) => `${r1(ly.heightMm)}/${r1(ly.diameterMm)}`).join('|'),
    mode
  ]
  return sigHash(parts.join('§'))
}

function sigHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return 'S' + (h >>> 0).toString(36)
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export interface BuildLashOptions {
  mode?: LashMergeMode
  /** 路线 A：这些格里的节点强制按组合拆点（同时解除该格跨带并错标记） */
  forceSplitCells?: Set<string>
  /** 路线 B：这些格里层带较高的交会整体沿环向挪开 FOOTPRINT_MM */
  shiftCells?: Set<string>
}

export function buildLashing(l: Lantern, opts: BuildLashOptions = {}): LashPlan {
  const mode: LashMergeMode = opts.mode ?? l.lashingMerge ?? 'position'
  const g = buildGeometry(l)
  const frame = buildFrame(l)
  const rows = memberRows(l, frame)
  const L = g.sections.length - 1

  let incidences = buildIncidences(l, g, frame)

  // 路线 B：把指定格里层带较高的交会整体沿该层环向挪开
  if (opts.shiftCells && opts.shiftCells.size) {
    incidences = applyShifts(incidences, opts.shiftCells, g)
  }

  // 层带：按取整后的 y 排序去重，名称优先取交会自带的层带名（多面体顶点专用）
  const bandYs = Array.from(new Set(incidences.map((ic) => r1(ic.y)))).sort((a, b) => a - b)
  const bandNameAtY = new Map<number, string>()
  for (const y of bandYs) {
    const ic = incidences.find((x) => r1(x.y) === y)
    const named = ic?.note?.match(/bandName:(.+)/)?.[1]
    bandNameAtY.set(y, named ?? bandNameOf(ic?.section ?? 0, L))
  }
  const bandOfY = (y: number) => bandYs.indexOf(r1(y))

  // ---- 合并成节点 ----
  // 按空间位置：同格并为一个节点（相邻两层落同一格会并错，crossBand 点出）。
  // 按交会篾组合：同格里交会扎成组、各端头/各接头/归轴各自成组（不会并错，但节点明显变多）。
  const splitCombo = mode === 'combination'
  type Cluster = { key: string; cell: string; ics: RawIncidence[] }
  const clusters = new Map<string, Cluster>()
  const groupIdOf = (ic: RawIncidence): string => {
    if (ic.kind === 'crossing' || ic.kind === 'axle') return 'X'
    if (ic.kind === 'tuck') return `T:${ic.memberKey}`
    if (ic.kind === 'splice') return `S:${ic.memberKey}`
    return `H:${ic.memberKey}` // hub
  }
  for (const ic of incidences) {
    const cell = cellKeyOf(ic.x, ic.y, ic.z)
    const splitHere = splitCombo || !!opts.forceSplitCells?.has(cell)
    const key = splitHere ? `C:${cell}:${groupIdOf(ic)}` : `P:${cell}`
    let cl = clusters.get(key)
    if (!cl) {
      cl = { key, cell, ics: [] }
      clusters.set(key, cl)
    }
    cl.ics.push(ic)
  }

  const nodes: LashNode[] = []
  let seq = 0
  for (const [, cl] of clusters) {
    const split = cl.key.startsWith('C:')
    nodes.push(buildNode(cl, ++seq, bandOfY, bandYs, bandNameAtY, L, rows, split, split && !!opts.forceSplitCells?.has(cl.cell)))
  }  // 稳定排序：自底向上、同带按棱号、再按种类
  nodes.sort((a, b) => a.band - b.band || a.corner - b.corner || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.primaryKey.localeCompare(b.primaryKey))
  nodes.forEach((nd, i) => (nd.code = `N${String(i + 1).padStart(2, '0')}`))

  // ---- 卡死检测：位置合并把相邻两层并到同一格 ----
  const deadlocks: LashDeadlock[] = []
  for (const nd of nodes) {
    if (nd.crossBand) {
      const yNames = (nd.crossBandNames ?? []).map((nm) => {
        // 反查该名称层带的高度
        const idx = bandYs.findIndex((y) => bandNameAtY.get(y) === nm)
        return idx >= 0 ? `${nm}（高 ${bandYs[idx].toFixed(1)}mm）` : nm
      })
      deadlocks.push({
        nodeKey: nd.primaryKey,
        code: nd.code,
        posText: `(${nd.xMm.toFixed(1)}, ${nd.yMm.toFixed(1)}, ${nd.zMm.toFixed(1)})mm`,
        placeA: yNames[0],
        placeB: yNames[1]
      })
    }
  }

  // ---- 排程 ----
  const steps = schedule(nodes, deadlocks)

  // ---- 构件表行统计（逐道扎线记账） ----
  const rowStats = buildRowStats(nodes, rows)

  const totalTies = nodes.reduce((s, nd) => s + nd.ties, 0)
  const totalWireM = r3m(totalTies * CRAFT.lashPerJointM)
  const allowanceIncidences = incidences.filter((ic) => ic.kind === 'tuck' || ic.kind === 'splice').length
  const allowanceJointsFromFrame = frame.members.reduce((s, m) => s + m.qty * m.lashJoints, 0)

  const plan: LashPlan = {
    mode,
    signature: planSignature(l, mode),
    nodes,
    steps,
    rows: rowStats,
    deadlocks,
    fixes: null,
    nodeCount: nodes.length,
    totalTies,
    totalWireM,
    stepCount: steps.length,
    allowanceIncidences,
    allowanceJointsFromFrame,
    crossBandCount: nodes.filter((nd) => nd.crossBand).length,
    boundaryCount: nodes.filter((nd) => nd.boundary).length,
    generatedAt: new Date().toISOString()
  }

  if (deadlocks.length) {
    plan.fixes = {
      reorder: buildFixReorder(l, plan),
      shift: buildFixShift(l, plan)
    }
  }
  return plan
}

function buildNode(
  cl: { key: string; cell: string; ics: RawIncidence[] },
  seq: number,
  bandOfY: (y: number) => number,
  bandYs: number[],
  bandNameAtY: Map<number, string>,
  lastSection: number,
  rows: MemberRow[],
  /** 组合成组（组合合并 / 路线 A 强制拆点）：每组各算各的扎道 */
  splitGroup: boolean,
  /** 路线 A 的拆点格：按组合拆开后每小组只含一个层带，不再算跨带并错 */
  resolvingCell: boolean
): LashNode {
  void cl.cell
  const ics = cl.ics
  const primary =
    ics.find((ic) => ic.kind === 'crossing' || ic.kind === 'axle') ??
    ics.find((ic) => ic.kind === 'hub') ??
    ics.find((ic) => ic.kind === 'tuck') ??
    ics[0]
  // 位置取首要交会（路线 B 挪动后同格只含挪动后的交会）
  const x = r1(primary.x)
  const y = r1(primary.y)
  const z = r1(primary.z)
  // 稳定主键：位置合并的多面体端头按顶点（去掉逐棱后缀 :eN）；组合模式每组独立，不并错
  const primaryKey = splitGroup ? cl.key : primary.key.replace(/:e\d+$/, '')
  const cornerMatch = primary.key.match(/c(\d+)/)
  const polyVertex = primary.key.match(/^PV:(tetra|octa):([A-Za-z]+\d*)/)
  const corner = cornerMatch ? Number(cornerMatch[1]) : polyVertex ? -2 : -1

  const bandsHere = Array.from(new Set(ics.map((ic) => bandOfY(ic.y))))
  const band = resolvingCell ? bandsHere[0] : Math.min(...bandsHere)
  const crossBand = bandsHere.length > 1 && !resolvingCell
  const crossBandNames = crossBand ? bandsHere.map((b) => bandNameAtY.get(bandYs[b])!) : undefined
  const section = resolvingCell ? ics[0].section : primary.section

  const memberSet = Array.from(new Set(ics.map((ic) => ic.memberKey))).sort()
  const kinds = Array.from(new Set(ics.map((ic) => ic.kind)))
  const kind = primary.kind

  // ---- 扎道数（逐道记账） ----
  const tieRows: LashNode['tieRows'] = []
  const crossingCount = ics.filter((ic) => ic.kind === 'crossing').length
  const axle = ics.find((ic) => ic.kind === 'axle')
  const tucks = ics.filter((ic) => ic.kind === 'tuck')
  const splices = ics.filter((ic) => ic.kind === 'splice')
  const hubs = ics.filter((ic) => ic.kind === 'hub')

  /**
   * 合并方式决定一个节点扎几道：
   *  - 位置合并（splitGroup=false）：交会扎 1 道把同点所有端头/接头/辐条一并缠上；
   *    纯端头/纯接头节点各 1 道。被吸收的余量处数仍记账但不另绕（省扎线的来源）。
   *  - 组合合并 / 强制拆点（splitGroup=true）：交会 1 道，每个端头、每个接头、每根辐条
   *    内端各独立 1 道，互不并错，扎道明显变多。
   */
  const ringIc = ics.find((ic) => ic.kind === 'crossing' && (ic.memberKey.startsWith('R') || ic.memberKey === 'SH#0'))
  if (crossingCount > 0) {
    tieRows.push({ memberRow: rowOf((ringIc ?? primary).memberKey, rows), kind: 'crossing' })
    if (splitGroup) {
      for (const ic of tucks) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'tuck' })
      for (const ic of splices) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'splice' })
      for (const ic of hubs) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'hub' })
    }
  } else if (axle) {
    // 轴心节点：位置模式 1 道轴心扎并全部辐条内端；组合模式 1 轴心 + 每辐条 1 道
    tieRows.push({ memberRow: rowOf('AX', rows), kind: 'axle' })
    if (splitGroup) for (const ic of hubs) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'hub' })
  } else {
    // 独立端头 / 独立接头（两种合并方式都要扎）
    for (const ic of tucks) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'tuck' })
    for (const ic of splices) tieRows.push({ memberRow: rowOf(ic.memberKey, rows), kind: 'splice' })
  }

  const ties = tieRows.length
  const memberLabels = memberSet.map((mk) => labelOf(mk, rows))

  const label = describeNode(kind, section, lastSection, corner, ties, primary.key)

  const bandName = bandNameAtY.get(bandYs[band]) ?? bandNameOf(section, lastSection)
  const shiftNote = ics.find((ic) => ic.note?.startsWith('挪开'))?.note
  const shifted = shiftNote
    ? { dMm: FOOTPRINT_MM, along: '沿该层横篾环向切向' }
    : undefined

  return {
    primaryKey,
    code: `N${String(seq).padStart(2, '0')}`,
    label,
    band,
    bandName,
    section,
    corner,
    kind,
    members: memberSet,
    memberLabels,
    xMm: x,
    yMm: y,
    zMm: z,
    gx: gridRound(x),
    gy: gridRound(y),
    gz: gridRound(z),
    ties,
    wireM: r3m(ties * CRAFT.lashPerJointM),
    tieRows,
    mergedKinds: kinds,
    boundary: isBoundary(x) || isBoundary(y) || isBoundary(z),
    crossBand,
    crossBandNames,
    shifted
  }
}

function describeNode(kind: IncidenceKind, section: number, last: number, corner: number, ties: number, key: string): string {
  const pv = key.match(/^PV:(tetra|octa):([A-Za-z]+\d*)/)
  if (pv) {
    const [, shape, vid] = pv
    const m = vid.match(/(\d+)$/)
    const idx = m ? Number(m[1]) : -1
    const name =
      shape === 'octa'
        ? vid === 'D'
          ? '底盘极点'
          : vid === 'T'
            ? '收口极点'
            : `赤道第 ${idx + 1} 顶点`
        : vid === 'A'
          ? '顶顶点'
          : `底盘第 ${idx + 1} 顶点`
    return `${name}·${KIND_LABEL[kind]}（${ties} 道）`
  }
  const where = section < 0 ? '收口肩部' : section === 0 ? '底盘' : section === last ? '收口' : `第 ${section} 层`
  const at = corner >= 0 ? `第 ${corner + 1} 棱` : '轴心'
  return `${where}·${at}·${KIND_LABEL[kind]}（${ties} 道）`
}

function rowOf(memberKey: string, rows: MemberRow[]): string {
  return rows.find((r) => r.match(memberKey))?.rowKey ?? rows[0]?.rowKey ?? '?'
}

function labelOf(memberKey: string, rows: MemberRow[]): string {
  const r = rows.find((r) => r.match(memberKey))
  if (r) return r.member.label
  if (memberKey === 'AX') return '中轴'
  return memberKey
}

/* ------------------------------------------------------------------ */
/* 排程：下层不完成不上层；同层绕线包络相压的排成先后，余者同波次        */
/* ------------------------------------------------------------------ */

function schedule(nodes: LashNode[], deadlocks: LashDeadlock[]): LashStep[] {
  const blocked = new Set(deadlocks.map((d) => d.nodeKey))
  const live = nodes.filter((nd) => !blocked.has(nd.primaryKey))
  const byKey = new Map(live.map((nd) => [nd.primaryKey, nd]))

  // 边：A 必须先于 B
  const edges = new Map<string, Set<string>>()
  const indeg = new Map<string, number>()
  live.forEach((nd) => indeg.set(nd.primaryKey, 0))
  const addEdge = (a: string, b: string) => {
    if (a === b || !byKey.has(a) || !byKey.has(b)) return
    if (!edges.has(a)) edges.set(a, new Set())
    if (!edges.get(a)!.has(b)) {
      edges.get(a)!.add(b)
      indeg.set(b, (indeg.get(b) ?? 0) + 1)
    }
  }

  // 层带闸门：下一带全部完成，上一带才能开始
  const byBand = new Map<number, LashNode[]>()
  live.forEach((nd) => {
    if (!byBand.has(nd.band)) byBand.set(nd.band, [])
    byBand.get(nd.band)!.push(nd)
  })
  const bandOrds = Array.from(byBand.keys()).sort((a, b) => a - b)
  for (let i = 1; i < bandOrds.length; i++) {
    for (const lo of byBand.get(bandOrds[i - 1])!) {
      for (const hi of byBand.get(bandOrds[i])!) addEdge(lo.primaryKey, hi.primaryKey)
    }
  }

  // 同层：绕线包络相压 → 按交会→归轴→收口→接头排先后
  for (const list of byBand.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const d = Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm, a.zMm - b.zMm)
        if (d < FOOTPRINT_MM) {
          const ra = KIND_RANK[a.kind]
          const rb = KIND_RANK[b.kind]
          if (ra !== rb) {
            if (ra < rb) addEdge(a.primaryKey, b.primaryKey)
            else addEdge(b.primaryKey, a.primaryKey)
          } else {
            const ka = a.primaryKey.localeCompare(b.primaryKey)
            if (ka < 0) addEdge(a.primaryKey, b.primaryKey)
            else addEdge(b.primaryKey, a.primaryKey)
          }
        }
      }
    }
  }

  // Kahn 波次：同波次 = 可同时上
  const remaining = new Set(live.map((nd) => nd.primaryKey))
  const steps: LashStep[] = []
  let guard = live.length + 1
  while (remaining.size && guard-- > 0) {
    const wave = live.filter((nd) => remaining.has(nd.primaryKey) && (indeg.get(nd.primaryKey) ?? 0) === 0)
    if (!wave.length) break
    // 同波次内仍按层带分组（不同带不会同波，闸门保证），保留稳定次序
    wave.sort((a, b) => a.band - b.band || a.corner - b.corner || a.code.localeCompare(b.code))
    const band = wave[0].band
    const bandName = wave[0].bandName
    const sameBand = wave.filter((nd) => nd.band === band)
    const ties = sameBand.reduce((s, nd) => s + nd.ties, 0)
    steps.push({
      ordinal: steps.length + 1,
      wave: steps.filter((st) => st.band === band).length + 1,
      band,
      bandName,
      nodeCodes: sameBand.map((nd) => nd.code),
      nodeKeys: sameBand.map((nd) => nd.primaryKey),
      ties,
      wireM: r3m(ties * CRAFT.lashPerJointM),
      title: stepTitle(bandName, steps.filter((st) => st.band === band).length + 1, sameBand)
    })
    for (const nd of sameBand) {
      remaining.delete(nd.primaryKey)
      for (const to of edges.get(nd.primaryKey) ?? []) indeg.set(to, (indeg.get(to) ?? 1) - 1)
    }
  }
  return steps
}

function stepTitle(bandName: string, waveInBand: number, nodes: LashNode[]): string {
  const kinds = Array.from(new Set(nodes.map((nd) => nd.kind)))
  const action =
    waveInBand === 1 && kinds.includes('crossing')
      ? '立交会扎'
      : kinds.includes('splice')
        ? '补接头扎'
        : kinds.includes('tuck')
          ? '收端头扎'
          : kinds.includes('axle') || kinds.includes('hub')
            ? '归轴扎'
            : '绑扎'
  return `${bandName}：${action} ${nodes.length} 处（可同时上）`
}

/* ------------------------------------------------------------------ */
/* 行统计                                                              */
/* ------------------------------------------------------------------ */

function buildRowStats(nodes: LashNode[], rows: MemberRow[]): LashRowStat[] {
  return rows.map((r) => {
    const nodeSet = new Set<string>()
    let ties = 0
    for (const nd of nodes) {
      const mine = nd.tieRows.filter((t) => t.memberRow === r.rowKey).length
      if (mine > 0) {
        ties += mine
        nodeSet.add(nd.primaryKey)
      }
      // 参与节点：该节点交会篾里含本行（即使不记账，如位置合并里被吸收的接头/归轴）
      if (nd.members.some((mk) => r.match(mk))) nodeSet.add(nd.primaryKey)
    }
    return {
      rowKey: r.rowKey,
      label: r.member.label,
      qty: r.member.qty,
      nodes: nodeSet.size,
      ties,
      wireM: r3m(ties * CRAFT.lashPerJointM)
    }
  })
}

/* ------------------------------------------------------------------ */
/* 路线 B：挪开节点                                                    */
/* ------------------------------------------------------------------ */

function applyShifts(incidences: RawIncidence[], shiftCells: Set<string>, g: Geometry): RawIncidence[] {
  const n = g.n
  // 找每个格里最高层带的交会
  const byCell = new Map<string, RawIncidence[]>()
  for (const ic of incidences) {
    const c = cellKeyOf(ic.x, ic.y, ic.z)
    if (!shiftCells.has(c)) continue
    if (!byCell.has(c)) byCell.set(c, [])
    byCell.get(c)!.push(ic)
  }
  const shiftIds = new Set<string>()
  for (const [, ics] of byCell) {
    const maxY = Math.max(...ics.map((ic) => r1(ic.y)))
    for (const ic of ics) {
      if (r1(ic.y) === maxY) shiftIds.add(ic.key + '|' + ic.memberKey + '|' + ic.kind)
    }
  }
  return incidences.map((ic) => {
    const id = ic.key + '|' + ic.memberKey + '|' + ic.kind
    if (!shiftIds.has(id)) return ic
    // 沿该层环向（切向）挪 FOOTPRINT_MM
    const j = Number(ic.key.match(/c(\d+)/)?.[1] ?? 0)
    const a1 = cornerAngle((j + 1) % n, n)
    const a0 = cornerAngle(j, n)
    let tx = Math.cos(a1) - Math.cos(a0)
    let tz = Math.sin(a1) - Math.sin(a0)
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl
    tz /= tl
    return {
      ...ic,
      x: ic.x + tx * FOOTPRINT_MM,
      z: ic.z + tz * FOOTPRINT_MM,
      note: `挪开：沿环向错位 ${FOOTPRINT_MM}mm`
    }
  })
}

/* ------------------------------------------------------------------ */
/* 两条解法路线（卡死时当场点出 + 各自代价）                            */
/* ------------------------------------------------------------------ */

function deadlockCells(plan: LashPlan): Set<string> {
  const cells = new Set<string>()
  for (const d of plan.deadlocks) {
    const nd = plan.nodes.find((n) => n.primaryKey === d.nodeKey)!
    cells.add(`${nd.gx},${nd.gy},${nd.gz}`)
  }
  return cells
}

function buildFixReorder(l: Lantern, base: LashPlan): LashFixOption {
  const plan = buildLashing(l, { mode: base.mode, forceSplitCells: deadlockCells(base) })
  const addedNodes = plan.nodeCount - base.nodeCount
  const addedTies = plan.totalTies - base.totalTies
  const addedSteps = plan.stepCount - base.stepCount
  const addedWireM = r3m(addedTies * CRAFT.lashPerJointM)
  return {
    id: 'reorder',
    title: '路线一：改绑扎次序（同点拆成先后两道）',
    plan,
    addedNodes,
    addedTies,
    addedSteps,
    addedWireM,
    addedBendMm: 0,
    detail:
      `把并错的 ${base.deadlocks.length} 处按「交会先扎、接头/收口后扎」拆成先后两道，不挪任何篾、不改灯形；` +
      `代价：节点 +${addedNodes} 处、扎道 +${addedTies} 道（扎线 +${addedWireM.toFixed(3)}m）、工步 +${addedSteps} 步。`
  }
}

function buildFixShift(l: Lantern, base: LashPlan): LashFixOption {
  const plan = buildLashing(l, { mode: base.mode, shiftCells: deadlockCells(base) })
  const addedTies = plan.totalTies - base.totalTies
  const addedSteps = plan.stepCount - base.stepCount
  // 每处挪开引弯 FOOTPRINT_MM（同一格里多个层带只引 1 次）
  const bend = new Set(plan.nodes.filter((nd) => nd.shifted).map((nd) => `${nd.gx},${nd.gy},${nd.gz}`)).size * FOOTPRINT_MM
  return {
    id: 'shift',
    title: `路线二：挪开上层节点（沿环向错位 ${FOOTPRINT_MM}mm）`,
    plan,
    addedNodes: plan.nodeCount - base.nodeCount,
    addedTies,
    addedSteps,
    addedWireM: r3m(addedTies * CRAFT.lashPerJointM),
    addedBendMm: bend,
    detail:
      `把上层的 ${base.deadlocks.length} 个节点沿横篾环向挪 ${FOOTPRINT_MM}mm 再扎，扎道与扎线不增加` +
      (addedTies === 0 ? '' : `（重排后扎道 Δ${addedTies}）`) +
      `；代价：对应篾要引弯压 ${bend}mm（竹篾损耗，不是扎线），节点偏离棱线交会处，蒙面对位标记要跟着挪 ${FOOTPRINT_MM}mm，外观有轻微错位风险。`
  }
}

/* ------------------------------------------------------------------ */
/* 两种合并方案对比（二选一的取舍依据）                                */
/* ------------------------------------------------------------------ */

export interface LashModeComparison {
  position: LashPlan
  combination: LashPlan
  /** 组合方案比位置方案多付出的代价 */
  extraNodes: number
  extraTies: number
  extraSteps: number
  extraWireM: number
  positionCrossBand: number
}

export function compareModes(l: Lantern): LashModeComparison {
  const position = buildLashing(l, { mode: 'position' })
  const combination = buildLashing(l, { mode: 'combination' })
  return {
    position,
    combination,
    extraNodes: combination.nodeCount - position.nodeCount,
    extraTies: combination.totalTies - position.totalTies,
    extraSteps: combination.stepCount - position.stepCount,
    extraWireM: r3m((combination.totalTies - position.totalTies) * CRAFT.lashPerJointM),
    positionCrossBand: position.crossBandCount
  }
}

/* ------------------------------------------------------------------ */
/* 改棱数/层数后的三处差异（预览节点 / 构件表行 / 工步次序）            */
/* ------------------------------------------------------------------ */

export interface LashSnapshot {
  signature: string
  mode: LashMergeMode
  nodes: Record<string, { x: number; y: number; z: number; ties: number; code: string }>
  rows: Record<string, { nodes: number; ties: number; wireM: number }>
  steps: Record<string, number>
}

export interface LashDiff {
  changed: boolean
  moved: { key: string; code: string; from: string; to: string; dMm: number }[]
  nodeTiesChanged: { key: string; code: string; from: number; to: number }[]
  nodesAdded: string[]
  nodesRemoved: string[]
  rowsChanged: { label: string; tiesFrom: number; tiesTo: number; wireFrom: number; wireTo: number; nodesFrom: number; nodesTo: number }[]
  stepsReordered: { key: string; code: string; from: number; to: number }[]
  stepsAdded: string[]
  stepsRemoved: string[]
  affectedBands: string[]
}

export function snapshotPlan(plan: LashPlan): LashSnapshot {
  const nodes: LashSnapshot['nodes'] = {}
  for (const nd of plan.nodes) {
    nodes[nd.primaryKey] = { x: nd.xMm, y: nd.yMm, z: nd.zMm, ties: nd.ties, code: nd.code }
  }
  const rows: LashSnapshot['rows'] = {}
  for (const r of plan.rows) rows[r.rowKey] = { nodes: r.nodes, ties: r.ties, wireM: r.wireM }
  const steps: Record<string, number> = {}
  plan.steps.forEach((st) => st.nodeKeys.forEach((k) => (steps[k] = st.ordinal)))
  return { signature: plan.signature, mode: plan.mode, nodes, rows, steps }
}

export function diffPlans(before: LashSnapshot, now: LashPlan): LashDiff {
  const moved: LashDiff['moved'] = []
  const nodeTiesChanged: LashDiff['nodeTiesChanged'] = []
  const affectedBandSet = new Set<string>()
  for (const nd of now.nodes) {
    const old = before.nodes[nd.primaryKey]
    if (!old) continue
    const d = Math.hypot(old.x - nd.xMm, old.y - nd.yMm, old.z - nd.zMm)
    if (d >= POS_GRID_MM) {
      moved.push({
        key: nd.primaryKey,
        code: nd.code,
        from: `(${old.x.toFixed(1)},${old.y.toFixed(1)},${old.z.toFixed(1)})`,
        to: `(${nd.xMm.toFixed(1)},${nd.yMm.toFixed(1)},${nd.zMm.toFixed(1)})`,
        dMm: r1(d)
      })
      affectedBandSet.add(nd.bandName)
    }
    if (old.ties !== nd.ties) {
      nodeTiesChanged.push({ key: nd.primaryKey, code: nd.code, from: old.ties, to: nd.ties })
      affectedBandSet.add(nd.bandName)
    }
  }
  const nowKeys = new Set(now.nodes.map((nd) => nd.primaryKey))
  const oldKeySet = new Set(Object.keys(before.nodes))
  const nodesAdded = now.nodes.filter((nd) => !oldKeySet.has(nd.primaryKey)).map((nd) => nd.code)
  const nodesRemoved = Object.entries(before.nodes)
    .filter(([k]) => !nowKeys.has(k))
    .map(([, v]) => v.code)
  now.nodes.filter((nd) => !oldKeySet.has(nd.primaryKey)).forEach((nd) => affectedBandSet.add(nd.bandName))

  const rowsChanged: LashDiff['rowsChanged'] = []
  for (const r of now.rows) {
    const old = before.rows[r.rowKey]
    if (!old) continue
    if (old.ties !== r.ties || Math.abs(old.wireM - r.wireM) > 0.0009 || old.nodes !== r.nodes) {
      rowsChanged.push({
        label: r.label,
        tiesFrom: old.ties,
        tiesTo: r.ties,
        wireFrom: old.wireM,
        wireTo: r.wireM,
        nodesFrom: old.nodes,
        nodesTo: r.nodes
      })
    }
  }

  const nowStep: Record<string, number> = {}
  now.steps.forEach((st) => st.nodeKeys.forEach((k) => (nowStep[k] = st.ordinal)))
  const stepsReordered: LashDiff['stepsReordered'] = []
  for (const [k, ord] of Object.entries(before.steps)) {
    if (k in nowStep && nowStep[k] !== ord) {
      const nd = now.nodes.find((n) => n.primaryKey === k)
      stepsReordered.push({ key: k, code: nd?.code ?? k, from: ord, to: nowStep[k] })
      if (nd) affectedBandSet.add(nd.bandName)
    }
  }
  const stepsAdded = now.nodes.filter((nd) => !(nd.primaryKey in before.steps)).map((nd) => nd.code)
  const stepsRemoved = Object.keys(before.steps).filter((k) => !(k in nowStep)).map((k) => before.nodes[k]?.code ?? k)

  return {
    changed:
      moved.length > 0 ||
      nodeTiesChanged.length > 0 ||
      nodesAdded.length > 0 ||
      nodesRemoved.length > 0 ||
      rowsChanged.length > 0 ||
      stepsReordered.length > 0,
    moved,
    nodeTiesChanged,
    nodesAdded,
    nodesRemoved,
    rowsChanged,
    stepsReordered,
    stepsAdded,
    stepsRemoved,
    affectedBands: Array.from(affectedBandSet)
  }
}

/* ------------------------------------------------------------------ */

function r3m(v: number): number {
  return Math.round(v * 1000) / 1000
}
