/**
 * 绑扎节点图（工步清单）
 * ---------------------------------------------------------------------------
 * 数据全部取自既有两处计算结果，不另算一套几何：
 *   1) 轮廓与棱长周长：geometry.ts 的 sections（层号、截面半径/高度）、polygonEdge（棱长）
 *   2) 骨架构件与绑扎余量：frame.ts 的 members（每根篾的类别、数量、lashJoints 余量处数）
 *
 * 位置取整：节点坐标一律走 geometry.r1（mm，1 位小数），与构件表截取长度同一档；
 *           去重边界 = 半个取整步长（0.05mm）：round 后坐标相等即判为同一点，
 *           即原始位置相差 < 0.05mm 一定并上，> 0.05mm 一定不并，恰好 0.05mm 按四舍五入走。
 *
 * 节点合并二选一：
 *   mode='space'  按空间位置合并：同一处的交会扎 + 圈接头扎 + 端头扎共 1 道线，节点少、工步短；
 *                 相邻两层若恰好落在同一高度会被并成一处（会并错，节点上标 suspicious）。
 *   mode='combo'  按交会的篾组合合并：交会扎与接头扎即使位置重合也分开绑，绝不并错，节点/扎道更多。
 *
 * 扎道数：一处节点 = 一道扎（几根篾交会在一起也只绕一圈）。
 * 用线量：Σ 扎道 × CRAFT.lashPerJointM；且 Σ 逐节点用线必须等于扎线总量（CHK 内断言）。
 */
import type { FrameMember, Lantern } from './types'
import { buildFrame } from './frame'
import { polyhedronInfo, r1, TAU, type Geometry } from './geometry'
import { CRAFT } from './craft'

/** 位置取整步长（mm）——与构件表 r1 同一档 */
export const POSITION_STEP_MM = 0.1
/** 去重边界（mm）：半个取整步长 */
export const POSITION_HALF_STEP_MM = POSITION_STEP_MM / 2

export type MergeMode = 'space' | 'combo'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 绑扎轨道类型 */
export type PathKind = 'vertical' | 'polygon-edge' | 'circle' | 'fixed'

export interface LashStrip {
  /** 篾实例唯一 id（构件型号#同型序号） */
  id: string
  /** 来源构件行 id（FM…），多根同型时这是「型号」 */
  memberId: string
  memberKind: FrameMember['kind']
  label: string
  /** 同型第几根（0 起，对应棱号/圆周相位） */
  ordinal: number
  /** 层号：横篾 = 所在 section 编号；竖篾/棱篾 = 跨层用 -1；中轴 = -2；辐条 = 上/下 hub 层 */
  layer: number
  /** 棱号（竖篾/多边形横篾 = 0..n-1；圆形圈 = -1） */
  edge: number
  /** 走向描述（取自既有几何，不重算） */
  run: string
  pathKind: PathKind
  /** vertical：固定相位角；polygon-edge：第几根边；circle：圆形圈；fixed：固定点（中轴） */
  angle?: number
  sectionIndex?: number
  radius?: number
  /** 灯体棱数/母线根数（沿多边形边定向用） */
  sides: number
}

/** 一次绑扎动作（尚未合并） */
export interface RawAction {
  id: string
  /** 'cross' 交会扎 / 'joint' 绑扎余量处（端头、圈接头） */
  kind: 'cross' | 'joint'
  pos: Vec3
  /** 取整后的位置键（r1，mm，1 位小数）——去重的唯一依据 */
  posKey: string
  /** 涉及的篾实例 id */
  strips: string[]
  /** 组合键（combo 模式用）：交会按篾集合；接头按「本构件+宿主篾+接头身份」 */
  comboKey: string
  /** 身份标签（同位置多接头互相区分） */
  identity?: string
  ownerStrip?: string
  /** 建议所在层（交会取较低层） */
  layer: number
  note: string
}

export interface LashNode {
  id: string
  /** 稳定身份：交会 = C/层/相位组合；接头 = J/…；跨改棱数/层数重排后尽量保持可对照 */
  stableKey: string
  pos: Vec3
  posKey: string
  layer: number
  /** 节点类别：cross 交会 / joint 接头余量 / mixed 空间合并后两种动作混在一起 */
  category: 'cross' | 'joint' | 'mixed'
  /** 参与的篾实例 */
  strips: string[]
  /** 交会的构件型号（memberId 去重） */
  memberIds: string[]
  /** 含几次绑扎余量动作（参与扎道数计算的依据之一） */
  jointCount: number
  /** 含几次交会动作 */
  crossCount: number
  /** 扎道数：一处节点一道扎（combo 拆开后各自仍是一道） */
  tieCount: number
  /** 用线量（mm，= tieCount × 每道用量） */
  wireMm: number
  /** 来源动作 */
  actions: RawAction[]
  /** 空间合并时把不同层/不同组合误并到一起的可疑标记 */
  suspicious?: boolean
  suspiciousReason?: string
  /** 该节点含哪些层（可疑判定） */
  actionLayers: number[]
  /** 工步序号（排程后写入；卡住的节点为 null） */
  stepNo: number | null
  /** 试算：被挪动的竖向位移（mm） */
  overrideDyMm?: number
  note: string
}

/** 一道工步：同层内绕线互不压线、可同时上的节点 */
export interface LashStep {
  no: number
  layer: number
  title: string
  nodes: LashNode[]
  ties: number
  wireMm: number
  note: string
}

/** 排不出先后时给出的两条路 */
export interface DeadlockRoute {
  id: 'reorder' | 'relocate'
  title: string
  detail: string
  /** 代价 */
  extraSteps: number
  extraTies: number
  extraWireMm: number
}

export interface Deadlock {
  nodes: LashNode[]
  reason: string
  routeA: DeadlockRoute
  routeB: DeadlockRoute
}

export interface MemberLashRow {
  memberId: string
  label: string
  /** 该「型号」共几根 */
  qty: number
  /** 单根参与节点数 */
  nodesPer: number
  /** 单根分到的扎道数（共节点的扎道按参与根数分摊显示，合计守恒） */
  tiesPer: number
  /** 单根分到的用线量 mm */
  wireMmPer: number
  /** 该型号合计节点参与次数 */
  nodeParticipations: number
  tiesTotal: number
  wireMmTotal: number
}

export interface ModeStats {
  mode: MergeMode
  label: string
  nodeCount: number
  tieCount: number
  wireMm: number
  stepCount: number
}

export interface LashPlan {
  geometry: Geometry
  mode: MergeMode
  strips: LashStrip[]
  rawActions: RawAction[]
  nodes: LashNode[]
  steps: LashStep[]
  members: MemberLashRow[]
  deadlocks: Deadlock[]
  /** 是否可整排（无死锁） */
  schedulable: boolean
  /** 余量处数合计（= Σ frame members qty×lashJoints，必须与逐节点 jointCount 对得上） */
  jointTotal: number
  nodeCount: number
  tieCount: number
  wireMm: number
  /** 缠裹宽度 mm（绕线经过处不许互相压住的判定档） */
  wrapWidthMm: number
  /** 启用的试算位移列表（排程时已计入） */
  overrides: NodeOverride[]
  /** 改绑扎次序解套：被强制的先后对 */
  forcedOrders: ForcedOrder[]
  /** 重算签名（改棱数/层数变化对比用） */
  signature: string
  /** 规则说明（界面/导出同源引用） */
  rules: {
    stepText: string
    roundText: string
    boundaryText: string
    wireText: string
  }
}

export interface NodeOverride {
  stableKey: string
  dyMm: number
}

export interface ForcedOrder {
  beforeStableKey: string
  afterStableKey: string
}

export interface ModeComparison {
  space: ModeStats
  combo: ModeStats
  /** 选 space 相对 combo：省/多多少（负=省） */
  deltaStepsVsCombo: number
  deltaTiesVsCombo: number
  deltaWireVsComboMm: number
}

// ---------------------------------------------------------------------------
// 几何小工具（坐标全部取自既有 geometry 结果）
// ---------------------------------------------------------------------------

function ang(k: number, n: number): number {
  // 与 LanternPreview 俯视/等轴测同一套相位：棱 k 在 -90° + 360°k/n
  return -Math.PI / 2 + (TAU * k) / n
}

function vAt(radius: number, angle: number, y: number): Vec3 {
  return { x: r1(radius * Math.cos(angle)), y: r1(y), z: r1(radius * Math.sin(angle)) }
}

function polarAt(radius: number, angle: number, y: number): Vec3 {
  return { x: radius * Math.cos(angle), y, z: radius * Math.sin(angle) }
}

function posKey(p: Vec3): string {
  return `${r1(p.x).toFixed(1)},${r1(p.y).toFixed(1)},${r1(p.z).toFixed(1)}`
}

function stripId(memberId: string, ordinal: number): string {
  return `${memberId}#${ordinal}`
}

// ---------------------------------------------------------------------------
// 1) 由「骨架构件表 + 轮廓」还原一根根篾实例（层号/棱号/走向均取自既有结果）
// ---------------------------------------------------------------------------

interface Built {
  g: Geometry
  members: FrameMember[]
  strips: LashStrip[]
  /** memberId -> strip（圆形圈/中轴等 qty=1 的直接索引） */
  stripByMember: Map<string, LashStrip>
  /** 竖篾/棱篾实例（按 ordinal） */
  verticals: { strip: LashStrip; angle: number }[]
  /** 多边形横篾边：section -> [{ strip, edge, hostVertex(=edge 端的顶点号) }] */
  edgeRings: { sectionIndex: number; edges: { strip: LashStrip; edge: number; hostVertex: number }[] }[]
  /** 圆形横篾圈：section -> strip */
  circleRings: { sectionIndex: number; strip: LashStrip }[]
  /** 收口支撑圈（旋转体非平口） */
  supportRing: { strip: LashStrip; y: number; radius: number } | null
  /** 多面体信息 */
  poly: ReturnType<typeof buildPolyStrips> | null
  /** 走马灯：中轴 + 上下辐条 + 上下 hub 位置 */
  box: ReturnType<typeof buildBoxParts> | null
  /** 竖/棱篾构件行 id */
  verticalMemberId: string
}

function buildPolyStrips(g: Geometry, members: FrameMember[]) {
  const info = polyhedronInfo(g)
  const member = members.find((m) => m.kind === 'vertical')!
  const tetra = info.kind === 'tetra'
  // 正四面体（顶点朝上）与正八面体的顶点坐标：外接球半径 = g.maxR
  const verts: Vec3[] = tetra
    ? [
        { x: 0, y: r1(info.heightMm), z: 0 },
        { x: r1(g.maxR * Math.sqrt(8 / 9)), y: 0, z: 0 },
        { x: r1(-g.maxR * Math.sqrt(2 / 9)), y: 0, z: r1(g.maxR * Math.sqrt(2 / 3)) },
        { x: r1(-g.maxR * Math.sqrt(2 / 9)), y: 0, z: r1(-g.maxR * Math.sqrt(2 / 3)) }
      ]
    : [
        { x: 0, y: r1(g.maxR), z: 0 },
        { x: 0, y: r1(-g.maxR), z: 0 },
        { x: r1(g.maxR), y: 0, z: 0 },
        { x: r1(-g.maxR), y: 0, z: 0 },
        { x: 0, y: 0, z: r1(g.maxR) },
        { x: 0, y: 0, z: r1(-g.maxR) }
      ]
  // 棱（四面体 6 / 八面体 12）：每一对连得起来的顶点
  const edges: [number, number][] = []
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      // 四面体底面三顶点全连，顶连三底点 —— 顶点集两两连边恰为 6 条；八面体 6 顶点选不相对的配对 = 12 条
      const opp = !tetra && verts[i].x === -verts[j].x && verts[i].y === -verts[j].y && verts[i].z === -verts[j].z
      if (!opp) edges.push([i, j])
    }
  }
  const strips: LashStrip[] = edges.map(([a, b], k) => {
    const layer = Math.min(verts[a].y, verts[b].y) <= 0.05 ? 0 : 1
    return {
      id: stripId(member.id, k),
      memberId: member.id,
      memberKind: member.kind,
      label: `${member.label} ${k + 1}`,
      ordinal: k,
      layer,
      edge: k,
      run: `顶点 ${a + 1}↔${b + 1}（棱长取自构件表 ${r1(info.edgeMm)}mm）`,
      sides: g.n,
      pathKind: 'fixed'
    }
  })
  return { verts, edges, strips, memberId: member.id }
}

function buildBoxParts(g: Geometry, members: FrameMember[], strips: LashStrip[]) {
  const axle = members.find((m) => m.label.includes('中轴'))
  const spokeMember = members.find((m) => m.label.includes('辐条'))
  if (!axle || !spokeMember) return null
  const n = g.n
  const top = g.sections[g.sections.length - 1]
  const bot = g.sections[0]
  const axleStrip: LashStrip = {
    id: stripId(axle.id, 0),
    memberId: axle.id,
    memberKind: axle.kind,
    label: axle.label,
    ordinal: 0,
    layer: -2,
    edge: -1,
    sides: n,
    run: '贯穿中轴（固定于灯体中心）',
    pathKind: 'fixed'
  }
  strips.push(axleStrip)
  const spokes: { strip: LashStrip; top: boolean; edge: number; angle: number; outer: Vec3 }[] = []
  for (let k = 0; k < n; k++) {
    const a = ang(k, n)
    for (const isTop of [true, false]) {
      const sec = isTop ? top : bot
      const s: LashStrip = {
        id: stripId(spokeMember.id, isTop ? k : k + n),
        memberId: spokeMember.id,
        memberKind: spokeMember.kind,
        label: `${isTop ? '上' : '下'}辐条 ${k + 1}`,
        ordinal: isTop ? k : k + n,
        layer: isTop ? g.sections.length - 1 : 0,
        edge: k,
        sides: n,
        angle: a,
        run: `由中心到 ${isTop ? '收口' : '底盘'}棱角 ${k + 1}（半径取自轮廓 ${r1(sec.radiusMm)}mm）`,
        pathKind: 'fixed'
      }
      strips.push(s)
      spokes.push({ strip: s, top: isTop, edge: k, angle: a, outer: vAt(sec.radiusMm, a, sec.yMm) })
    }
  }
  return { axleStrip, spokes, topY: top.yMm, botY: bot.yMm }
}

function buildStrips(g: Geometry, members: FrameMember[], kind: Lantern['kind']): Built {
  const strips: LashStrip[] = []
  const n = g.n

  if (kind === 'polyhedron') {
    const poly = buildPolyStrips(g, members)
    strips.push(...poly.strips)
    return {
      g,
      members,
      strips,
      stripByMember: new Map(),
      verticals: [],
      edgeRings: [],
      circleRings: [],
      supportRing: null,
      poly,
      box: null,
      verticalMemberId: poly.memberId
    }
  }

  const verticalMember = members.find((m) => m.kind === 'vertical' || m.kind === 'rib')!
  const verticals: { strip: LashStrip; angle: number }[] = []
  for (let k = 0; k < n; k++) {
    const a = ang(k, n)
    const s: LashStrip = {
      id: stripId(verticalMember.id, k),
      memberId: verticalMember.id,
      memberKind: verticalMember.kind,
      label: `${verticalMember.label} ${k + 1}`,
      ordinal: k,
      layer: -1,
      edge: k,
      angle: a,
      sides: n,
      run: g.polygon
        ? `棱角 ${k + 1}（层号跨 ${g.sections.length - 1} 层，折线长取自构件表）`
        : `母线篾 ${k + 1}（圆周相位 ${((a + Math.PI / 2) / TAU) * 360}°，沿轮廓折线）`,
      pathKind: 'vertical'
    }
    strips.push(s)
    verticals.push({ strip: s, angle: a })
  }

  // 内部横篾圈：section 1..L-1；收口圈 = 末 section；底盘圈 = section 0
  // frame.ts 的推入顺序：先内部 ring（按层），再 mouth_ring、base_ring，旋转体可能再有支撑圈
  const innerRings = members.filter((m) => m.kind === 'ring')
  const mouth = members.find((m) => m.kind === 'mouth_ring')!
  const base = members.find((m) => m.kind === 'base_ring')!
  const ringAtSection: { sectionIndex: number; member: FrameMember }[] = []
  let innerIdx = 0
  for (let si = 1; si < g.sections.length - 1; si++) {
    const member = innerRings[innerIdx++]
    if (member) ringAtSection.push({ sectionIndex: si, member })
  }
  ringAtSection.push({ sectionIndex: g.sections.length - 1, member: mouth })
  ringAtSection.push({ sectionIndex: 0, member: base })

  const edgeRings: Built['edgeRings'] = []
  const circleRings: Built['circleRings'] = []
  const stripByMember = new Map<string, LashStrip>()

  for (const { sectionIndex, member } of ringAtSection) {
    const sec = g.sections[sectionIndex]
    if (g.polygon) {
      const edges: { strip: LashStrip; edge: number; hostVertex: number }[] = []
      for (let e = 0; e < n; e++) {
        const s: LashStrip = {
          id: stripId(member.id, e),
          memberId: member.id,
          memberKind: member.kind,
          label: `${member.label}·边${e + 1}`,
          ordinal: e,
          layer: sectionIndex,
          edge: e,
          sides: n,
          angle: ang(e, n),
          sectionIndex,
          radius: sec.radiusMm,
          run: `第 ${sectionIndex} 层横篾第 ${e + 1} 边（棱长 2Rsin(π/n) 取自轮廓 R=${r1(sec.radiusMm)}mm）`,
          pathKind: 'polygon-edge'
        }
        strips.push(s)
        edges.push({ strip: s, edge: e, hostVertex: e })
      }
      edgeRings.push({ sectionIndex, edges })
    } else {
      const s: LashStrip = {
        id: stripId(member.id, 0),
        memberId: member.id,
        memberKind: member.kind,
        label: member.label,
        ordinal: 0,
        sides: n,
        layer: sectionIndex,
        edge: -1,
        sectionIndex,
        radius: sec.radiusMm,
        run: `第 ${sectionIndex} 层圆形圈（周长 2πR 取自轮廓 R=${r1(sec.radiusMm)}mm）`,
        pathKind: 'circle'
      }
      strips.push(s)
      circleRings.push({ sectionIndex, strip: s })
      stripByMember.set(member.id, s)
    }
  }

  // 收口支撑篾（旋转体、非平口时 frame.ts 追加的最后一个 ring）
  let supportRing: Built['supportRing'] = null
  if (innerRings.length > Math.max(0, g.sections.length - 2)) {
    const supportMember = innerRings[innerRings.length - 1]
    const radius = (g.sections[g.sections.length - 1].radiusMm + g.maxR) / 2
    const y = g.heightMm * (1 - g.kTop / 2)
    const s: LashStrip = {
      id: stripId(supportMember.id, 0),
      memberId: supportMember.id,
      memberKind: supportMember.kind,
      sides: n,
      label: supportMember.label,
      ordinal: 0,
      layer: g.sections.length - 1,
      edge: -1,
      radius,
      run: `收口肩部支撑圈（半径/层位取自轮廓插值 R=${r1(radius)}mm）`,
      pathKind: 'circle'
    }
    strips.push(s)
    circleRings.push({ sectionIndex: g.sections.length - 1, strip: s })
    supportRing = { strip: s, y, radius }
  }

  // 方形走马灯：中轴 + 上下辐条
  let box: Built['box'] = null
  if (kind === 'box') box = buildBoxParts(g, members, strips)

  return { g, members, strips, stripByMember, verticals, edgeRings, circleRings, supportRing, poly: null, box, verticalMemberId: verticalMember.id }
}

// ---------------------------------------------------------------------------
// 2) 逐根篾生成交会动作 + 把「绑扎余量处数」逐处登记为接头动作
// ---------------------------------------------------------------------------

let actionSeq = 0
function nextActionId(): string {
  return `A${String(++actionSeq).padStart(4, '0')}`
}

function pushCross(actions: RawAction[], pos: Vec3, stripIds: string[], layer: number, note: string) {
  const key = [...stripIds].sort().join('|')
  actions.push({
    id: nextActionId(),
    kind: 'cross',
    pos,
    posKey: posKey(pos),
    strips: [...stripIds],
    comboKey: `C:${key}`,
    layer,
    note
  })
}

function pushJoint(
  actions: RawAction[],
  pos: Vec3,
  ownerId: string,
  hostId: string | null,
  layer: number,
  identity: string,
  note: string
) {
  actions.push({
    id: nextActionId(),
    kind: 'joint',
    pos,
    posKey: posKey(pos),
    strips: [ownerId, ...(hostId ? [hostId] : [])],
    comboKey: `J:${ownerId}>${hostId ?? 'SELF'}:${identity}`,
    identity,
    ownerStrip: ownerId,
    layer,
    note
  })
}

function buildActions(b: Built): RawAction[] {
  const actions: RawAction[] = []
  actionSeq = 0
  const { g } = b

  if (b.poly) {
    // 多面体：每条棱的两端各一处绑扎余量；交会节点 = 顶点（≥2 根棱交会）
    const { verts, edges, strips } = b.poly
    for (const v of verts) {
      const incident = edges
        .map(([a, c], k) => (a === verts.indexOf(v) || c === verts.indexOf(v) ? strips[k].id : null))
        .filter((x): x is string => !!x)
      const layer = v.y <= 0.05 ? 0 : 1
      if (incident.length >= 2) pushCross(actions, v, incident, layer, `顶点交会 ${incident.length} 根棱篾`)
    }
    edges.forEach(([a, c], k) => {
      const s = strips[k]
      pushJoint(actions, verts[a], s.id, null, verts[a].y <= 0.05 ? 0 : 1, 'end-a', '棱篾端头绑扎余量（端 A）')
      pushJoint(actions, verts[c], s.id, null, verts[c].y <= 0.05 ? 0 : 1, 'end-b', '棱篾端头绑扎余量（端 B）')
    })
    return actions
  }

  // ---- 竖篾/母线篾：两端各一处绑扎余量（落在底盘圈 / 收口圈交会点上） ----
  b.verticals.forEach(({ strip, angle }) => {
    const botSec = g.sections[0]
    const topSec = g.sections[g.sections.length - 1]
    const pBot = vAt(botSec.radiusMm, angle, botSec.yMm)
    const pTop = vAt(topSec.radiusMm, angle, topSec.yMm)
    pushJoint(actions, pBot, strip.id, null, 0, 'end-bottom', '竖篾下端绑扎余量')
    pushJoint(actions, pTop, strip.id, null, g.sections.length - 1, 'end-top', '竖篾上端绑扎余量')
  })

  // ---- 逐截面：竖篾 × 横篾圈 交会；多边形另有每根横篾边的 1 处接头 ----
  for (let si = 0; si < g.sections.length; si++) {
    const sec = g.sections[si]
    const edgeRing = b.edgeRings.find((r) => r.sectionIndex === si)
    const circleRing = b.circleRings.find((r) => r.sectionIndex === si)
    const layer = Math.max(0, si - 1) // 内部层截面 i 属第 i 层的下沿；底=0、口=末层
    const crossLayer = si === 0 ? 0 : si - 1

    if (edgeRing) {
      // 每个顶点：竖篾 k 交会横篾边 k-1 与边 k（合围处）
      for (let k = 0; k < g.n; k++) {
        const a = ang(k, g.n)
        const pos = vAt(sec.radiusMm, a, sec.yMm)
        const e1 = edgeRing.edges[k].strip.id // 边 k：顶点 k → k+1，接头宿主取端 k
        const e2 = edgeRing.edges[(k - 1 + g.n) % g.n].strip.id
        pushCross(
          actions,
          pos,
          [b.verticals[k].strip.id, e1, e2],
          crossLayer,
          `第 ${si} 截面棱角 ${k + 1}：竖篾 + 两根横篾边交会`
        )
      }
      // 每根横篾边 1 处接头余量，位置在其端顶点 hostVertex
      edgeRing.edges.forEach(({ strip, hostVertex }) => {
        const a = ang(hostVertex, g.n)
        const pos = vAt(sec.radiusMm, a, sec.yMm)
        pushJoint(
          actions,
          pos,
          strip.id,
          b.verticals[hostVertex].strip.id,
          layer,
          `splice-edge${hostVertex + 1}`,
          `第 ${si} 层横篾第 ${hostVertex + 1} 边接头绑扎余量（多边形 n 处之一）`
        )
      })
    } else if (circleRing) {
      // 圆形圈：1 处接头（落在 0 号竖篾相位）；与每根母线篾交会
      b.verticals.forEach(({ strip: vs, angle }, k) => {
        const pos = vAt(sec.radiusMm, angle, sec.yMm)
        pushCross(actions, pos, [vs.id, circleRing.strip.id], crossLayer, `第 ${si} 截面母线篾 ${k + 1} × 圆形圈交会`)
      })
      const p0 = vAt(sec.radiusMm, ang(0, g.n), sec.yMm)
      pushJoint(
        actions,
        p0,
        circleRing.strip.id,
        b.verticals[0].strip.id,
        layer,
        'splice-circle',
        `第 ${si} 层圆形圈 1 处接头绑扎余量`
      )
    }
  }

  // ---- 收口支撑圈 × 母线篾 交会（支撑圈自身接头已在上面按截面登记过） ----
  if (b.supportRing) {
    const { strip: sr, y, radius } = b.supportRing
    b.verticals.forEach(({ strip: vs, angle }, k) => {
      const pos = vAt(radius, angle, y)
      pushCross(actions, pos, [vs.id, sr.id], g.sections.length - 2, `收口支撑圈 × 母线篾 ${k + 1} 交会`)
    })
    // 支撑圈自身 1 处接头
    pushJoint(actions, vAt(radius, ang(0, g.n), y), sr.id, b.verticals[0].strip.id, g.sections.length - 2, 'splice-circle', '收口支撑圈接头绑扎余量')
  }

  // ---- 方形走马灯：辐条 1 处接头在外端（棱角），内端汇于中轴 hub ----
  if (b.box) {
    const { axleStrip, spokes, topY, botY } = b.box
    const topHub: Vec3 = { x: 0, y: r1(topY), z: 0 }
    const botHub: Vec3 = { x: 0, y: r1(botY), z: 0 }
    const topSpokes = spokes.filter((s) => s.top)
    const botSpokes = spokes.filter((s) => !s.top)
    pushCross(actions, topHub, [axleStrip.id, ...topSpokes.map((s) => s.strip.id)], g.sections.length - 1, '上 hub：中轴 + 上辐条汇交')
    pushCross(actions, botHub, [axleStrip.id, ...botSpokes.map((s) => s.strip.id)], 0, '下 hub：中轴 + 下辐条汇交')
    spokes.forEach(({ strip, top, outer, angle }) => {
      const k = strip.edge
      // 构件表里每根辐条 1 处绑扎余量：外端接头，宿主为该棱角竖篾（内端汇于中轴走 hub 交会扎，不另计余量）
      pushJoint(actions, outer, strip.id, b.verticals[k].strip.id, top ? g.sections.length - 1 : 0, top ? 'spoke-top' : 'spoke-bottom', `辐条外端接头绑扎余量（${top ? '上' : '下'}，棱角 ${k + 1}，圆周相位 ${((angle + Math.PI / 2) / TAU) * 360}°）`)
    })
    // 中轴两端各 1 处绑扎余量
    pushJoint(actions, topHub, axleStrip.id, null, g.sections.length - 1, 'axle-top', '中轴上端绑扎余量')
    pushJoint(actions, botHub, axleStrip.id, null, 0, 'axle-bottom', '中轴下端绑扎余量')
  }

  return actions
}

// ---------------------------------------------------------------------------
// 3) 节点合并（二选一）
// ---------------------------------------------------------------------------

let nodeSeq = 0

function stableKeyFor(actions: RawAction[]): string {
  if (actions.every((a) => a.kind === 'cross')) return actions[0].comboKey
  if (actions.length === 1) return actions[0].comboKey
  // 同点多接头（combo 不会走到这；space 模式混合）给一个稳定的位置身份
  return `M:${actions[0].posKey}`
}

function mergeActions(actions: RawAction[], mode: MergeMode): LashNode[] {
  nodeSeq = 0
  const groups = new Map<string, RawAction[]>()
  for (const a of actions) {
    const key = mode === 'space' ? `S:${a.posKey}` : a.comboKey
    const arr = groups.get(key)
    if (arr) arr.push(a)
    else groups.set(key, [a])
  }

  const nodes: LashNode[] = []
  for (const arr of groups.values()) {
    const stripsSet = new Set<string>()
    const memberSet = new Set<string>()
    let jointCount = 0
    let crossCount = 0
    const layers = new Set<number>()
    let hasCross = false
    let hasJoint = false
    for (const a of arr) {
      a.strips.forEach((s) => stripsSet.add(s))
      a.strips.forEach((s) => memberSet.add(s.split('#')[0]))
      layers.add(a.layer)
      if (a.kind === 'joint') jointCount++
      else crossCount++
      if (a.kind === 'joint') hasJoint = true
      else hasCross = true
    }
    const first = arr[0]
    const node: LashNode = {
      id: `N${String(++nodeSeq).padStart(3, '0')}`,
      stableKey: stableKeyFor(arr),
      pos: { ...first.pos },
      posKey: first.posKey,
      layer: Math.min(...arr.map((a) => a.layer)),
      category: hasCross && hasJoint ? 'mixed' : hasCross ? 'cross' : 'joint',
      strips: [...stripsSet],
      memberIds: [...memberSet],
      jointCount,
      crossCount,
      tieCount: 1,
      wireMm: r1(CRAFT.lashPerJointM * 1000),
      actions: arr,
      actionLayers: [...layers].sort((a, b) => a - b),
      stepNo: null,
      note: arr.map((a) => a.note).join('；')
    }
    // 空间合并的并错风险：同一点里混了不同层的动作，或交会篾组合不止一套
    if (mode === 'space') {
      const crossCombos = new Set(arr.filter((a) => a.kind === 'cross').map((a) => a.comboKey))
      const reasons: string[] = []
      if (layers.size > 1) reasons.push(`该点混入了第 ${[...layers].map((x) => x + 1).join('、')} 层的绑扎，空间合并会把相邻两层并成一处`)
      if (crossCombos.size > 1) reasons.push(`该点存在 ${crossCombos.size} 组不同篾组合的交会，按位置合并会并错`)
      if (reasons.length) {
        node.suspicious = true
        node.suspiciousReason = reasons.join('；')
      }
    }
    nodes.push(node)
  }

  nodes.sort((a, b) => a.layer - b.layer || a.pos.y - b.pos.y || angleKeyOf(a.pos) - angleKeyOf(b.pos) || a.stableKey.localeCompare(b.stableKey))
  return nodes
}

// ---------------------------------------------------------------------------
// 4) 绕线缠裹冲突 + 排程（下一层不完不能绑上一层；同层互不压线可同时上）
// ---------------------------------------------------------------------------

function angleKeyOf(p: Vec3): number {
  return Math.atan2(p.z, p.x)
}

/**
 * 试算位移后的节点位置（只挪被挪节点；轨道不动）。
 * 层号保持不变——节点属于它那一圈的施工层；若被挪到物理位置低于下层节点，
 * 层序（逻辑）与绕线先后（物理）会反向成环，即当场点出的互相卡住。
 */
function applyOverrides(nodes: LashNode[], overrides: NodeOverride[]): LashNode[] {
  const map = new Map(overrides.map((o) => [o.stableKey, o.dyMm]))
  return nodes.map((n) => {
    const dy = map.get(n.stableKey)
    if (!dy) return n
    const moved: LashNode = {
      ...n,
      pos: { x: n.pos.x, y: r1(n.pos.y + dy), z: n.pos.z },
      posKey: '',
      overrideDyMm: dy,
      stepNo: null
    }
    moved.posKey = posKey(moved.pos)
    return moved
  })
}

interface Edge {
  from: number
  to: number
  why: string
  /** hard = 物理约束（层序 / 绕线不可压线），soft = 工艺偏好次序（可被改序覆盖） */
  hard: boolean
}

/**
 * 建先后约束有向图：
 *  - hard 层序边：低层节点 → 高层节点（下层没绑完上层绑不上）；
 *  - hard 绕线边：同根篾上沿走向距离 < 缠裹宽度的两节点，必须沿篾走向先绑一头（物理上绕线不许互相压住）；
 *  - soft 工艺边：同层内接头扎先于交会扎（先合围再扎竖篾，可由「改绑扎次序」覆盖）。
 * 改序只撤 soft 边；hard 边撤不掉，若与强制先后成环即为解不开的互相卡住。
 */
function buildEdges(nodes: LashNode[], stripMap: Map<string, LashStrip>, wrapMm: number, forced: ForcedOrder[]): { edges: Edge[]; adj: number[][]; conflictPairs: [number, number, string][] } {
  const idx = new Map(nodes.map((n, i) => [n.stableKey, i]))
  const edges: Edge[] = []
  const add = (i: number, j: number, why: string, hard: boolean) => {
    if (i === j) return
    if (!edges.some((e) => e.from === i && e.to === j)) edges.push({ from: i, to: j, why, hard })
  }

  /**
   * 沿共享篾走向的绕线关系：
   *  - { hard: true, first } 沿走向有严格先后（间距 > 0）——物理约束；
   *  - { hard: false, first } 完全同位（间距 ≈ 0）——不能同时绑，但谁先谁后只是次序问题；
   *  - null 两节点不共享同一根篾，或沿篾距离 ≥ 缠裹宽度（互不压线）。
   */
  const wrapOrder = (i: number, j: number): { hard: boolean; first: number } | null => {
    const ni = nodes[i]
    const nj = nodes[j]
    const EPS = 1e-6
    for (const sid of ni.strips) {
      if (!nj.strips.includes(sid)) continue
      const strip = stripMap.get(sid)
      if (!strip) continue
      if (strip.pathKind === 'vertical') {
        const d = Math.abs(ni.pos.y - nj.pos.y)
        if (d < wrapMm - EPS) {
          if (d < EPS) return { hard: false, first: ni.stableKey < nj.stableKey ? i : j }
          return { hard: true, first: ni.pos.y < nj.pos.y ? i : j }
        }
      } else if (strip.pathKind === 'circle') {
        const R = Math.max(1, strip.radius ?? Math.hypot(ni.pos.x, ni.pos.z))
        const ai = Math.atan2(ni.pos.z, ni.pos.x)
        const aj = Math.atan2(nj.pos.z, nj.pos.x)
        const fwd = ((aj - ai) % TAU + TAU) % TAU
        const d = fwd > Math.PI ? TAU - fwd : fwd
        if (Math.abs(ni.pos.y - nj.pos.y) < wrapMm && d * R < wrapMm - EPS) {
          if (d * R < EPS) return { hard: false, first: ni.stableKey < nj.stableKey ? i : j }
          return { hard: true, first: fwd <= Math.PI ? i : j }
        }
      } else if (strip.pathKind === 'polygon-edge') {
        const gap = Math.hypot(ni.pos.x - nj.pos.x, ni.pos.z - nj.pos.z)
        if (Math.abs(ni.pos.y - nj.pos.y) < wrapMm && gap < wrapMm - EPS) {
          // 沿该边：以边起点顶点（edge 号角）为 0，投影参数 t 小者先绑
          const R = strip.radius ?? Math.hypot(ni.pos.x, ni.pos.z)
          const v0 = polarAt(R, ang(strip.edge, strip.sides), ni.pos.y)
          const v1 = polarAt(R, ang(strip.edge + 1, strip.sides), ni.pos.y)
          const along = (p: Vec3) => {
            const ex = v1.x - v0.x
            const ez = v1.z - v0.z
            const len2 = ex * ex + ez * ez || 1
            return ((p.x - v0.x) * ex + (p.z - v0.z) * ez) / len2
          }
          const ti = along(ni.pos)
          const tj = along(nj.pos)
          if (gap < EPS || Math.abs(ti - tj) < EPS) return { hard: false, first: ni.stableKey < nj.stableKey ? i : j }
          return { hard: true, first: ti < tj ? i : j }
        }
      } else {
        const d3 = Math.hypot(ni.pos.x - nj.pos.x, ni.pos.y - nj.pos.y, ni.pos.z - nj.pos.z)
        if (d3 < wrapMm - EPS) {
          if (d3 < EPS) return { hard: false, first: ni.stableKey < nj.stableKey ? i : j }
          return { hard: true, first: ni.stableKey < nj.stableKey ? i : j }
        }
      }
    }
    return null
  }

  const rankOf = (n: LashNode) => (n.category === 'joint' ? 0 : n.category === 'mixed' ? 1 : 2)

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const ni = nodes[i]
      const nj = nodes[j]
      // 层序硬约束（逻辑层：下层没绑完上层绑不上）
      if (ni.layer !== nj.layer) {
        if (ni.layer < nj.layer) add(i, j, `第 ${ni.layer + 1} 层先于第 ${nj.layer + 1} 层（下层没绑完上层绑不上）`, true)
        else add(j, i, `第 ${nj.layer + 1} 层先于第 ${ni.layer + 1} 层（下层没绑完上层绑不上）`, true)
      }
      const wo = wrapOrder(i, j)
      if (wo) {
        const a = wo.first
        const b = a === i ? j : i
        if (wo.hard) {
          // 物理先后：沿篾走向先到的先绑；与层序反向时即互相卡住（层序要下先，绕线要上先）
          add(a, b, '同根篾绕线经过处不许互相压住：沿篾走向先绑这处，再绑下一处', true)
        } else if (ni.layer === nj.layer) {
          // 同层同位：不能同时上；按「接头先于交会、再按编号」定一个确定性次序（软，可改序）
          const ra = rankOf(nodes[a])
          const rb = rankOf(nodes[b])
          let first = a
          let second = b
          if (ra > rb) {
            first = b
            second = a
          } else if (ra === rb && nodes[a].stableKey > nodes[b].stableKey) {
            first = b
            second = a
          }
          add(first, second, '同一处两个扎不能同时绕线：先绑其一再绑另一个（次序可改）', false)
        }
        // 跨层同位：只受层序边管（不同步，必然先后两工步）
      }
      // 同层工艺偏好（软）——接头扎先于交会扎
      if (ni.layer === nj.layer) {
        if (rankOf(ni) < rankOf(nj)) add(i, j, '同层先合围接头、再扎交会（工艺偏好，可改序）', false)
        else if (rankOf(nj) < rankOf(ni)) add(j, i, '同层先合围接头、再扎交会（工艺偏好，可改序）', false)
      }
    }
  }

  // 强制改序（解套方案 A）：撤掉这对节点间现有的全部先后边（含层序/绕线硬边——
  // 改序本身就是「先缠半圈、第二处就位后补满」的例外施工，代价是 +1 道扎），再插入强制先后。
  for (const f of forced) {
    const i = idx.get(f.beforeStableKey)
    const j = idx.get(f.afterStableKey)
    if (i === undefined || j === undefined) continue
    for (let k = edges.length - 1; k >= 0; k--) {
      const e = edges[k]
      if ((e.from === i && e.to === j) || (e.from === j && e.to === i)) edges.splice(k, 1)
    }
    add(i, j, '改绑扎次序（例外施工：第一处先缠半圈，第二处就位后补满一道）', false)
  }

  const adj: number[][] = nodes.map(() => [])
  const conflictPairs: [number, number, string][] = []
  for (const e of edges) {
    adj[e.from].push(e.to)
    const wo = wrapOrder(e.from, e.to)
    if (wo && nodes[e.from].layer === nodes[e.to].layer) {
      conflictPairs.push([e.from, e.to, e.why])
    }
  }
  return { edges, adj, conflictPairs }
}

/** Tarjan 强连通分量：返回所有 size>1 的环（或自环） */
function findCycles(adj: number[][]): number[][] {
  let index = 0
  const stack: number[] = []
  const onStack = new Array(adj.length).fill(false)
  const ix = new Array(adj.length).fill(-1)
  const low = new Array(adj.length).fill(0)
  const sccs: number[][] = []

  const strong = (v: number) => {
    ix[v] = low[v] = index++
    stack.push(v)
    onStack[v] = true
    for (const w of adj[v]) {
      if (ix[w] === -1) {
        strong(w)
        low[v] = Math.min(low[v], low[w])
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], ix[w])
      }
    }
    if (low[v] === ix[v]) {
      const comp: number[] = []
      while (true) {
        const w = stack.pop()!
        onStack[w] = false
        comp.push(w)
        if (w === v) break
      }
      if (comp.length > 1) sccs.push(comp)
    }
  }
  for (let v = 0; v < adj.length; v++) if (ix[v] === -1) strong(v)
  return sccs
}

/** 排程：无环时按层 + 同层最早可上时刻分工步（贪心，可并行的并一步） */
function schedule(nodes: LashNode[], edges: Edge[]): LashStep[] {
  const indeg = new Array(nodes.length).fill(0)
  const adj: number[][] = nodes.map(() => [])
  for (const e of edges) {
    adj[e.from].push(e.to)
    indeg[e.to]++
  }
  // earliest step index
  const est = new Array(nodes.length).fill(0)
  const done: boolean[] = new Array(nodes.length).fill(false)
  const placed: number[] = []
  let remain = nodes.length
  while (remain > 0) {
    const ready = nodes.map((_, i) => i).filter((i) => !done[i] && indeg[i] === 0)
    if (ready.length === 0) break
    // 同一步只放同层、且互相之间无绕线冲突的节点（其余等下一拍）
    ready.sort((a, b) => nodes[a].layer - nodes[b].layer || est[a] - est[b] || nodes[a].stableKey.localeCompare(nodes[b].stableKey))
    const chosen: number[] = []
    for (const i of ready) {
      const layer = nodes[i].layer
      if (chosen.length && nodes[chosen[0]].layer !== layer) continue
      if (chosen.some((j) => edgeBetween(edges, i, j) || edgeBetween(edges, j, i))) continue
      chosen.push(i)
    }
    const stepIdx = placed.length ? Math.max(...chosen.map((i) => est[i])) : 0
    for (const i of chosen) {
      done[i] = true
      est[i] = stepIdx
      placed.push(i)
      for (const w of adj[i]) {
        indeg[w]--
        est[w] = Math.max(est[w], stepIdx + 1)
      }
    }
    remain -= chosen.length
  }

  // 按步聚合
  const buckets = new Map<number, number[]>()
  placed.forEach((i, _k) => {
    const s = est[i]
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s)!.push(i)
  })
  const steps: LashStep[] = []
  let no = 1
  const sortedSteps = [...buckets.keys()].sort((a, b) => a - b)
  for (const s of sortedSteps) {
    const ids = buckets.get(s)!
    ids.sort((a, b) => angleKeyOf(nodes[a].pos) - angleKeyOf(nodes[b].pos) || nodes[a].stableKey.localeCompare(nodes[b].stableKey))
    const layer = nodes[ids[0]].layer
    const ns = ids.map((i) => nodes[i])
    ns.forEach((n) => (n.stepNo = no))
    const hasJoint = ns.some((n) => n.category !== 'cross')
    steps.push({
      no,
      layer,
      title: `第 ${no} 步 · 第 ${layer + 1} 层${hasJoint ? '（接头/交会一起）' : '（交会扎）'}`,
      nodes: ns,
      ties: ns.reduce((s, n) => s + n.tieCount, 0),
      wireMm: r1(ns.reduce((s, n) => s + n.wireMm, 0)),
      note: `同层 ${ns.length} 处节点绕线互不压线，可同时上；下层未绑完本步不允许开始`
    })
    no++
  }
  return steps
}

function edgeBetween(edges: Edge[], i: number, j: number): boolean {
  return edges.some((e) => e.from === i && e.to === j)
}

// ---------------------------------------------------------------------------
// 5) 死锁识别与两条路
// ---------------------------------------------------------------------------

function makeDeadlock(nodes: LashNode[], cycle: number[], edges: Edge[], wrapMm: number): Deadlock {
  const cycNodes = cycle.map((i) => nodes[i])
  // 找环内一对互相卡住的边作为「哪两处」
  let pair: [LashNode, LashNode] | null = null
  let why = ''
  for (const i of cycle) {
    for (const j of cycle) {
      if (i === j) continue
      const e = edges.find((x) => x.from === i && x.to === j)
      if (e) {
        pair = [nodes[i], nodes[j]]
        why = e.why
        break
      }
    }
    if (pair) break
  }
  if (!pair) pair = [cycNodes[0], cycNodes[1]]
  const perTie = CRAFT.lashPerJointM * 1000
  return {
    nodes: cycNodes,
    reason: `节点 ${pair[0].id} 与 ${pair[1].id} 互相等对方先绑（${why}），先后成环排不开：环上 ${cycNodes.length} 处节点（${cycNodes
      .map((n) => n.id)
      .join('、')}）。`,
    routeA: {
      id: 'reorder',
      title: '路 A：改绑扎次序（强制一处先绑）',
      detail: `把 ${pair[0].id} 提到 ${pair[1].id} 之前先绑，断开先后环；被压的绕线在第一处只缠半圈、等第二处就位后再补满。`,
      extraSteps: 1,
      extraTies: 1,
      extraWireMm: r1(perTie)
    },
    routeB: {
      id: 'relocate',
      title: `路 B：挪开该层一个节点（沿竖篾让 ${wrapMm}mm）`,
      detail: `把 ${pair[0].id} 沿竖篾方向挪 ${wrapMm}mm（半个缠裹位），绕线路径不再相交，层序不变；代价是该处扎线要斜跨 ${wrapMm}mm 篾身。`,
      extraSteps: 0,
      extraTies: 0,
      extraWireMm: r1(wrapMm * 2) // 斜跨多耗线 ≈ 让位距离 ×2
    }
  }
}

// ---------------------------------------------------------------------------
// 6) 构件表逐行：参与几处节点、用掉几道扎线
// ---------------------------------------------------------------------------

function buildMemberRows(b: Built, nodes: LashNode[]): MemberLashRow[] {
  // memberId -> qty（取构件表）
  const qtyOf = new Map(b.members.map((m) => [m.id, m.qty]))
  const memberIds = [...new Set(b.strips.map((s) => mtype(s.memberId)))]
  const rows: MemberLashRow[] = []
  for (const mid of memberIds) {
    const myStrips = b.strips.filter((s) => mtype(s.memberId) === mid)
    const qty = qtyOf.get(mid) ?? myStrips.length
    // 单根参与：统计该型号的 strip 实例出现在哪些节点（按 ordinal 分根）
    const perOrdinal = new Map<number, { nodes: number; ties: number; wire: number }>()
    for (const s of myStrips) {
      if (!perOrdinal.has(s.ordinal)) perOrdinal.set(s.ordinal, { nodes: 0, ties: 0, wire: 0 })
      const rec = perOrdinal.get(s.ordinal)!
      for (const n of nodes) {
        if (!n.strips.includes(s.id)) continue
        rec.nodes++
        // 共节点的一道扎按参与篾根数分摊显示（总量在 plan 层守恒）
        const share = 1 / n.strips.length
        rec.ties += share
        rec.wire += (n.wireMm * share)
      }
    }
    const recs = [...perOrdinal.values()]
    const nodesPer = recs.length ? recs.reduce((s, r) => s + r.nodes, 0) / recs.length : 0
    const tiesPer = recs.length ? recs.reduce((s, r) => s + r.ties, 0) / recs.length : 0
    const wirePer = recs.length ? recs.reduce((s, r) => s + r.wire, 0) / recs.length : 0
    const label = b.members.find((m) => m.id === mid)?.label || mid
    rows.push({
      memberId: mid,
      label,
      qty,
      nodesPer: r3round(nodesPer),
      tiesPer: r3round(tiesPer),
      wireMmPer: r1(wirePer),
      nodeParticipations: Math.round(nodesPer * qty),
      tiesTotal: r1(tiesPer * qty),
      wireMmTotal: r1(wirePer * qty)
    })
  }
  return rows
}

function mtype(stripMemberId: string): string {
  return stripMemberId.split('#')[0]
}

function r3round(v: number): number {
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------------------
// 7) 总入口：两种合并各排一遍
// ---------------------------------------------------------------------------

function signatureOf(l: Lantern, mode: MergeMode, wrapMm: number): string {
  return [
    l.kind,
    l.sides,
    l.layers.length,
    l.layers.map((x) => x.heightMm).join('/'),
    Math.round(l.maxDiameterMm),
    Math.round(l.mouthDiameterMm),
    Math.round(l.baseDiameterMm),
    l.mouthStyle,
    l.bottomStyle,
    r1(l.smoothness * 100),
    mode,
    Math.round(wrapMm)
  ].join('|')
}

export interface LashOptions {
  mode: MergeMode
  wrapWidthMm?: number
  overrides?: NodeOverride[]
  forcedOrders?: ForcedOrder[]
}

/** 灯样 → 排程参数（合并方式 + 缠裹宽度 + 解套试算；三处同源都走这里） */
export function lashOptionsFor(l: Lantern): LashOptions {
  return {
    mode: l.lashMergeMode === 'combo' ? 'combo' : 'space',
    wrapWidthMm: l.lashWrapWidthMm,
    overrides: l.lashTrial?.overrides ?? [],
    forcedOrders: l.lashTrial?.forcedOrders ?? []
  }
}

export function buildLashPlan(l: Lantern, opts: LashOptions): LashPlan {
  const frame = buildFrame(l)
  const g = frame.geometry
  const wrapMm = Math.max(1, Math.round(opts.wrapWidthMm ?? CRAFT.lashWrapWidthMm))

  const built = buildStrips(g, frame.members, l.kind)
  const stripMap = new Map(built.strips.map((s) => [s.id, s]))
  const rawActions = buildActions(built)

  let nodes = mergeActions(rawActions, opts.mode)
  nodes = applyOverrides(nodes, opts.overrides ?? [])
  // 重排稳定顺序：层 → y → 相位角
  nodes.sort((a, b) => a.layer - b.layer || a.pos.y - b.pos.y || angleKeyOf(a.pos) - angleKeyOf(b.pos) || a.stableKey.localeCompare(b.stableKey))

  const { edges, adj } = buildEdges(nodes, stripMap, wrapMm, opts.forcedOrders ?? [])
  const cycles = findCycles(adj)
  const deadlocks = cycles.map((c) => makeDeadlock(nodes, c, edges, wrapMm))

  // 环内节点标堵；其余正常排
  const blocked = new Set<number>(cycles.flat())
  let steps: LashStep[] = []
  if (cycles.length === 0) {
    steps = schedule(nodes, edges)
  } else {
    const freeNodes = nodes.filter((_, i) => !blocked.has(i))
    const freeEdges = edges.filter((e) => !blocked.has(e.from) && !blocked.has(e.to))
    steps = schedule(freeNodes, freeEdges)
    cycles.flat().forEach((i) => (nodes[i].stepNo = null))
  }

  // 路 A 改序：每处强制先后 = 第一处先缠半圈、第二处就位后补满的额外一道扎（+每道用量）。
  // 把这道补扎挂到「第二处」节点与其所在工步，保证逐节点/逐工步合计仍守恒。
  const perTie = CRAFT.lashPerJointM * 1000
  const stepByNo = new Map(steps.map((st) => [st.no, st]))
  if (cycles.length === 0) {
    for (const f of opts.forcedOrders ?? []) {
      const target = nodes.find((n) => n.stableKey === f.afterStableKey)
      if (!target || target.stepNo === null) continue
      target.tieCount += 1
      target.wireMm = r1(target.wireMm + perTie)
      target.note += '；路A改序：该处补满一道扎（+1 道）'
      const st = stepByNo.get(target.stepNo)
      if (st) {
        st.ties += 1
        st.wireMm = r1(st.wireMm + perTie)
      }
    }
    // 路 B 挪位：斜跨让位段多耗的线（|dy|×2mm）挂到被挪节点与其工步
    for (const o of opts.overrides ?? []) {
      const target = nodes.find((n) => n.stableKey === o.stableKey)
      if (!target || target.stepNo === null) continue
      const extra = Math.abs(o.dyMm) * 2
      target.wireMm = r1(target.wireMm + extra)
      target.note += `；路B挪位：斜跨让位多耗 ${r1(extra)}mm 线`
      const st = stepByNo.get(target.stepNo)
      if (st) st.wireMm = r1(st.wireMm + extra)
    }
  }

  const members = buildMemberRows(built, nodes.filter((n) => (n.stepNo !== null)))
  const jointTotal = frame.members.reduce((s, m) => s + m.qty * m.lashJoints, 0)
  const tiedNodes = nodes.filter((n) => n.stepNo !== null)
  const tieCountAll = tiedNodes.reduce((s, n) => s + n.tieCount, 0)
  const wireMm = r1(tiedNodes.reduce((s, n) => s + n.wireMm, 0))

  return {
    geometry: g,
    mode: opts.mode,
    strips: built.strips,
    rawActions,
    nodes,
    steps,
    members,
    deadlocks,
    schedulable: cycles.length === 0,
    jointTotal,
    nodeCount: tiedNodes.length,
    tieCount: tieCountAll,
    wireMm,
    wrapWidthMm: wrapMm,
    overrides: opts.overrides ?? [],
    forcedOrders: opts.forcedOrders ?? [],
    signature: signatureOf(l, opts.mode, wrapMm),
    rules: {
      stepText: '下层没绑完上层绑不上：严格自底盘圈向收口圈逐层；同层内绕线经过处互不压住的节点可同时上。',
      roundText: `位置按毫米取整 ${POSITION_STEP_MM.toFixed(1)}mm 档（与构件表截取长度同一档 r1），坐标保留 1 位小数；逐节点用线量保留 1 位小数，扎线总量保留 3 位小数（m）。`,
      boundaryText: `去重边界 = 半个取整步长 ${POSITION_HALF_STEP_MM.toFixed(2)}mm：取整后三个坐标全等算一处；原始差距 < ${POSITION_HALF_STEP_MM.toFixed(
        2
      )}mm 必并、> ${POSITION_HALF_STEP_MM.toFixed(2)}mm 必不并，恰在边界按四舍五入。`,
      wireText: `一处交会节点 = 一道扎；每道用线 ${CRAFT.lashPerJointM.toFixed(2)}m；Σ 逐节点扎道 × 每道用量必须等于扎线总量，差 10mm（1cm）即在自检中报红。`
    }
  }
}

/** 两种合并方案并排对比（取舍用） */
export function compareModes(l: Lantern, wrapMm?: number): ModeComparison {
  const space = buildLashPlan(l, { mode: 'space', wrapWidthMm: wrapMm })
  const combo = buildLashPlan(l, { mode: 'combo', wrapWidthMm: wrapMm })
  const stat = (p: LashPlan, label: string): ModeStats => ({
    mode: p.mode,
    label,
    nodeCount: p.nodeCount,
    tieCount: p.tieCount,
    wireMm: p.wireMm,
    stepCount: p.steps.length
  })
  return {
    space: stat(space, '按空间位置合并'),
    combo: stat(combo, '按交会篾组合合并'),
    deltaStepsVsCombo: space.steps.length - combo.steps.length,
    deltaTiesVsCombo: space.tieCount - combo.tieCount,
    deltaWireVsComboMm: space.wireMm - combo.wireMm
  }
}

// ---------------------------------------------------------------------------
// 8) 改棱数/层数后的三处变化对比
// ---------------------------------------------------------------------------

export interface LashChangeReport {
  changed: boolean
  reason: string
  preview: { moved: { stableKey: string; from: Vec3; to: Vec3; layer: number }[]; added: string[]; removed: string[] }
  frame: { memberLabel: string; nodesDelta: number; tiesDelta: number; wireDeltaMm: number }[]
  steps: { fromNo: number | null; toNo: number | null; stableKey: string; title: string }[]
  totals: { before: { nodes: number; ties: number; wireMm: number; steps: number }; after: { nodes: number; ties: number; wireMm: number; steps: number } }
}

/**
 * 前后两份 plan 对比（同一合并模式）。
 * stableKey 对交会节点 = 层/棱篾组合，对接头 = 构件+宿主+身份，重排后可对照。
 */
export function diffPlans(before: LashPlan, after: LashPlan, sidesChanged: boolean, layersChanged: boolean): LashChangeReport {
  const beforeMap = new Map(before.nodes.map((n) => [n.stableKey, n]))
  const afterMap = new Map(after.nodes.map((n) => [n.stableKey, n]))
  const moved: LashChangeReport['preview']['moved'] = []
  for (const [key, an] of afterMap) {
    const bn = beforeMap.get(key)
    if (bn && (bn.posKey !== an.posKey)) {
      moved.push({ stableKey: key, from: bn.pos, to: an.pos, layer: an.layer })
    }
  }
  const added = [...afterMap.keys()].filter((k) => !beforeMap.has(k))
  const removed = [...beforeMap.keys()].filter((k) => !afterMap.has(k))

  // 构件表：型号按 label 对（member id 重排后可能换号）
  const frame: LashChangeReport['frame'] = []
  const bm = new Map(before.members.map((m) => [m.label, m]))
  for (const am of after.members) {
    const b = bm.get(am.label)
    if (!b) {
      frame.push({ memberLabel: am.label, nodesDelta: am.nodeParticipations, tiesDelta: am.tiesTotal, wireDeltaMm: am.wireMmTotal })
    } else {
      const nodesDelta = r1(am.nodeParticipations - b.nodeParticipations)
      const tiesDelta = r1(am.tiesTotal - b.tiesTotal)
      const wireDelta = r1(am.wireMmTotal - b.wireMmTotal)
      if (nodesDelta || tiesDelta || wireDelta) frame.push({ memberLabel: am.label, nodesDelta, tiesDelta, wireDeltaMm: wireDelta })
    }
  }

  // 工步：按节点 stableKey 对步号
  const steps: LashChangeReport['steps'] = []
  const beforeStep = new Map(before.nodes.map((n) => [n.stableKey, n.stepNo]))
  const afterStep = new Map(after.nodes.map((n) => [n.stableKey, n.stepNo]))
  const allKeys = new Set([...beforeStep.keys(), ...afterStep.keys()])
  for (const key of allKeys) {
    const b = beforeStep.get(key) ?? null
    const a = afterStep.get(key) ?? null
    if (b !== a) steps.push({ fromNo: b, toNo: a, stableKey: key, title: afterMap.get(key)?.note.slice(0, 24) || beforeMap.get(key)?.note.slice(0, 24) || key })
  }

  const reasons: string[] = []
  if (sidesChanged) reasons.push(`棱数 ${before.geometry.n} → ${after.geometry.n}`)
  if (layersChanged) reasons.push(`层数 ${before.geometry.sections.length - 1} → ${after.geometry.sections.length - 1}`)
  return {
    changed: moved.length > 0 || added.length > 0 || removed.length > 0 || frame.length > 0 || steps.length > 0,
    reason: reasons.join('；') || '参数变化',
    preview: { moved, added, removed },
    frame,
    steps,
    totals: {
      before: { nodes: before.nodeCount, ties: before.tieCount, wireMm: before.wireMm, steps: before.steps.length },
      after: { nodes: after.nodeCount, ties: after.tieCount, wireMm: after.wireMm, steps: after.steps.length }
    }
  }
}
