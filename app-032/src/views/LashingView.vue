<script setup lang="ts">
/**
 * 绑扎节点图与工步清单
 *  - 节点/扎道/工步全部取自 computeAll().lash（与参数预览页、骨架构件表、CSV 导出同源）；
 *  - 节点合并二选一并列出两条路各自的工步数、扎道数、用线量代价；
 *  - 排不出先后时当场点出卡住的两处，给「改绑扎次序 / 挪开节点」两条路并写清代价；
 *  - 换合并方式 = 旧版结果（含已导出的清单）作废，已按旧版绑好的层需拆开重绑，明确提示。
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import ChecksPanel from '../components/ChecksPanel.vue'
import { getLantern } from '../core/store'
import { computeAll } from '../core/checks'
import { DEFAULT_LOFT_OPTIONS } from '../core/paginate'
import { buildLashPlan, type LashPlan } from '../core/lashing'
import { downloadText, lashMembersCsv, lashNodesCsv, lashStepsCsv } from '../core/exporter'
import { CRAFT } from '../core/craft'

const route = useRoute()
const lantern = computed(() => getLantern(route.params.id as string))
const full = computed(() => {
  const l = lantern.value
  if (!l) return null
  return computeAll(l, { ...DEFAULT_LOFT_OPTIONS, paper: l.pageSize, overlapMm: l.overlapMm })
})
const plan = computed<LashPlan | null>(() => full.value?.lash ?? null)

/** 作废提示：换合并方式后，旧版工步与用线量失效，照旧版绑好的层要拆开重绑 */
const discarded = ref<{ mode: 'space' | 'combo'; ties: number; wireMm: number; steps: number } | null>(null)

function chooseMode(mode: 'space' | 'combo') {
  const l = lantern.value
  const p = plan.value
  if (!l || !p || l.lashMergeMode === mode) return
  // 记下被放弃那版让出的代价（旧版作废重来）
  discarded.value = { mode: p.mode, ties: p.tieCount, wireMm: p.wireMm, steps: p.steps.length }
  l.lashMergeMode = mode
  // 改合并方式：上一版的解套试算一起作废
  l.lashTrial = undefined
}

function applyRoute(which: 'reorder' | 'relocate') {
  const l = lantern.value
  const p = plan.value
  if (!l || !p || !p.deadlocks.length) return
  const d = p.deadlocks[0]
  if (which === 'reorder') {
    // 路 A：强制环中第一处先于第二处
    const [a, b] = d.nodes
    l.lashTrial = {
      overrides: [],
      forcedOrders: [{ beforeStableKey: a.stableKey, afterStableKey: b.stableKey }, ...(l.lashTrial?.forcedOrders ?? [])]
    }
  } else {
    // 路 B：把第一处沿竖篾挪开一个缠裹宽度（向上让，物理绕线矛盾解除）
    const a = d.nodes[0]
    l.lashTrial = {
      overrides: [{ stableKey: a.stableKey, dyMm: l.lashWrapWidthMm }, ...(l.lashTrial?.overrides ?? [])],
      forcedOrders: []
    }
  }
}

function clearTrial() {
  const l = lantern.value
  if (l) l.lashTrial = undefined
}

function onWrap(e: Event) {
  const l = lantern.value
  if (!l) return
  l.lashWrapWidthMm = Math.max(4, Math.min(30, Number((e.target as HTMLInputElement).value) || 12))
  l.lashTrial = undefined
}

function exportSteps() {
  const l = lantern.value
  const p = plan.value
  if (l && p) downloadText(`${l.name}-绑扎工步清单.csv`, lashStepsCsv(l, p))
}
function exportNodes() {
  const l = lantern.value
  const p = plan.value
  if (l && p) downloadText(`${l.name}-绑扎节点明细.csv`, lashNodesCsv(l, p))
}
function exportMembers() {
  const l = lantern.value
  const p = plan.value
  if (l && p) downloadText(`${l.name}-构件绑扎用量.csv`, lashMembersCsv(l, p))
}

function exportAllThree() {
  const l = lantern.value
  const p = plan.value
  if (!l || !p) return
  // 三份清单同一次导出、同一份工步：工步 / 节点明细 / 构件用量
  downloadText(`${l.name}-绑扎工步清单.csv`, lashStepsCsv(l, p))
  setTimeout(() => downloadText(`${l.name}-绑扎节点明细.csv`, lashNodesCsv(l, p)), 120)
  setTimeout(() => downloadText(`${l.name}-构件绑扎用量.csv`, lashMembersCsv(l, p)), 240)
}

const cmp = computed(() => full.value?.lashCompare)
const otherMode = computed(() => (plan.value?.mode === 'space' ? 'combo' : 'space'))

/** 纯净版（不含试算）对比，用于显示两条路的固有差 */
function deltaText(delta: number, unit: string): string {
  if (delta === 0) return `持平`
  return `${delta > 0 ? '多' : '省'} ${Math.abs(delta)} ${unit}`
}

/** 死锁节点的立体坐标文本 */
function posText(n: { pos: { x: number; y: number; z: number } }): string {
  return `(${n.pos.x.toFixed(1)}, ${n.pos.y.toFixed(1)}, ${n.pos.z.toFixed(1)}) mm`
}

/** 该节点交会的是哪几根篾（取自同一份 strips，层号/棱号/走向照原结果） */
function stripNames(n: { strips: string[] }): string {
  const p = plan.value
  if (!p) return ''
  return n.strips
    .map((id) => p.strips.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => s!.label)
    .join('、')
}

/** 按层归组预览工步 */
const stepsByLayer = computed(() => {
  const p = plan.value
  if (!p) return []
  const map = new Map<number, LashPlan['steps']>()
  for (const st of p.steps) {
    if (!map.has(st.layer)) map.set(st.layer, [])
    map.get(st.layer)!.push(st)
  }
  return [...map.entries()].map(([layer, steps]) => ({ layer, steps }))
})

const blockedNodes = computed(() => plan.value?.nodes.filter((n) => n.stepNo === null) ?? [])

/** 不排程的对照版（当前若处于试算后，用来显示「照旧版」数据） */
const pristine = computed<LashPlan | null>(() => {
  const l = lantern.value
  if (!l || !l.lashTrial) return null
  return buildLashPlan(l, { mode: l.lashMergeMode, wrapWidthMm: l.lashWrapWidthMm })
})
</script>

<template>
  <div v-if="!lantern || !full || !plan" class="missing">找不到该灯样。<router-link to="/">返回</router-link></div>
  <div v-else class="lash-view">
    <section class="head">
      <div>
        <h2>绑扎节点图 · {{ lantern.name }}</h2>
        <p class="sub">
          一根根篾在灯体上的位置算出交会点，按毫米取整去重后排成工步：下层没绑完上层绑不上，同层绕线互不压住的节点一起上。
          层号、棱号、走向取自轮廓与棱长周长；余量处数取自骨架构件表（共 <b>{{ plan.jointTotal }}</b> 处，参与扎道计算）；
          取整容差与构件表同为 0.1mm 档。
        </p>
      </div>
      <div class="ops">
        <button @click="exportSteps">导出工步清单 CSV</button>
        <button @click="exportNodes">导出节点明细 CSV</button>
        <button @click="exportMembers">导出构件绑扎用量 CSV</button>
        <button class="primary" @click="exportAllThree">三份清单一起导出</button>
      </div>
    </section>

    <!-- 总量条（= 参数预览页 / 构件表 / 导出三处同一组数） -->
    <section class="stats">
      <div class="stat"><span>节点数</span><b>{{ plan.nodeCount }}</b></div>
      <div class="stat"><span>扎道数</span><b>{{ plan.tieCount }}</b></div>
      <div class="stat"><span>扎线用量</span><b>{{ (plan.wireMm / 1000).toFixed(3) }} m</b></div>
      <div class="stat"><span>工步数</span><b>{{ plan.steps.length }}</b></div>
      <div class="stat"><span>余量处数（构件表）</span><b>{{ plan.jointTotal }}</b></div>
      <div class="stat"><span>缠裹宽度</span><b>{{ plan.wrapWidthMm }} mm</b></div>
      <div class="stat"><span>每道用线</span><b>{{ CRAFT.lashPerJointM.toFixed(2) }} m</b></div>
      <div class="stat" :class="{ bad: !plan.schedulable }">
        <span>排程状态</span><b>{{ plan.schedulable ? '整张排得开' : `${plan.deadlocks.length} 处卡住` }}</b>
      </div>
    </section>

    <!-- 节点合并：二选一 + 代价 -->
    <section class="modes">
      <h3>节点怎么合并（二选一，选定后旧版作废重来）</h3>
      <div class="mode-cards">
        <div class="mode-card" :class="{ on: plan.mode === 'space' }" @click="chooseMode('space')">
          <header>
            <span class="radio">{{ plan.mode === 'space' ? '●' : '○' }}</span>
            <strong>按空间位置合并</strong>
            <em>节点少、工步短</em>
          </header>
          <ul>
            <li>节点 <b>{{ cmp?.space.nodeCount }}</b> 处 · 扎道 <b>{{ cmp?.space.tieCount }}</b> 道</li>
            <li>用线 <b>{{ ((cmp?.space.wireMm ?? 0) / 1000).toFixed(3) }}</b> m · 工步 <b>{{ cmp?.space.stepCount }}</b> 步</li>
            <li class="cost">相邻两层落在同一高度处会被并错——本灯已标可疑节点 <b>{{ plan.nodes.filter((n) => n.suspicious).length }}</b> 处</li>
          </ul>
        </div>
        <div class="mode-card" :class="{ on: plan.mode === 'combo' }" @click="chooseMode('combo')">
          <header>
            <span class="radio">{{ plan.mode === 'combo' ? '●' : '○' }}</span>
            <strong>按交会的篾组合合并</strong>
            <em>不会并错，节点明显多</em>
          </header>
          <ul>
            <li>节点 <b>{{ cmp?.combo.nodeCount }}</b> 处 · 扎道 <b>{{ cmp?.combo.tieCount }}</b> 道</li>
            <li>用线 <b>{{ ((cmp?.combo.wireMm ?? 0) / 1000).toFixed(3) }}</b> m · 工步 <b>{{ cmp?.combo.stepCount }}</b> 步</li>
            <li class="cost">交会扎与接头扎即使同位也分开绑，绝不并错</li>
          </ul>
        </div>
      </div>
      <p class="mode-delta" v-if="cmp">
        当前选用「{{ plan.mode === 'space' ? '按空间位置合并' : '按交会篾组合合并' }}」；
        另一条路（{{ otherMode === 'space' ? '按空间位置合并' : '按交会篾组合合并' }}）相对它：
        工步 {{ deltaText((otherMode === 'space' ? cmp.space.stepCount : cmp.combo.stepCount) - plan.steps.length, '步') }}、
        扎道 {{ deltaText((otherMode === 'space' ? cmp.space.tieCount : cmp.combo.tieCount) - plan.tieCount, '道') }}、
        用线 {{ deltaText((otherMode === 'space' ? cmp.space.wireMm : cmp.combo.wireMm) - plan.wireMm, 'mm') }}。
      </p>
      <div class="wrap-row">
        <label>
          绕线缠裹宽度判定档
          <input
            :value="lantern.lashWrapWidthMm"
            type="number"
            min="4"
            max="30"
            step="1"
            @change="onWrap"
          />
          mm
        </label>
        <small>同一根篾上沿走向间距小于此值的两道扎绕线会互相压住，必须排成先后、不能同一步上；改档位整张重排。</small>
      </div>
      <div v-if="discarded" class="discard">
        已作废：旧版「{{ discarded.mode === 'space' ? '按空间位置合并' : '按交会篾组合合并' }}」的 {{ discarded.steps }} 步工步、
        {{ discarded.ties }} 道扎、{{ (discarded.wireMm / 1000).toFixed(3) }}m 用线量连同已导出的旧清单一起失效；
        已照旧版绑好的层必须拆开重绑，按本页新清单重做。
        <button @click="discarded = null">知道了</button>
      </div>
    </section>

    <!-- 死锁：哪两处卡住 + 两条路 -->
    <section v-if="!plan.schedulable" class="deadlock">
      <h3>⚠ 排不出先后：当场点出互相卡住的地方</h3>
      <div v-for="(d, di) in plan.deadlocks" :key="di" class="dead-card">
        <p class="dead-reason">{{ d.reason }}</p>
        <ul class="dead-nodes">
          <li v-for="n in d.nodes" :key="n.id">
            <b>{{ n.id }}</b> · 第 {{ n.layer + 1 }} 层 · {{ posText(n) }} ·
            <span class="dim">{{ n.note }}</span>
          </li>
        </ul>
        <div class="routes">
          <div class="route">
            <h4>{{ d.routeA.title }}</h4>
            <p>{{ d.routeA.detail }}</p>
            <p class="price">代价：多 {{ d.routeA.extraSteps }} 道工步、{{ d.routeA.extraTies }} 道扎、{{ d.routeA.extraWireMm }}mm 扎线（第一处先缠半圈，第二处就位后补满）</p>
            <button class="primary" @click="applyRoute('reorder')">按路 A 改序重排</button>
          </div>
          <div class="route">
            <h4>{{ d.routeB.title }}</h4>
            <p>{{ d.routeB.detail }}</p>
            <p class="price">代价：工步与扎道不增加，扎线多耗 {{ d.routeB.extraWireMm }}mm（斜跨让位段）；该处节点高度在预览图上同步挪 {{ plan.wrapWidthMm }}mm</p>
            <button class="primary" @click="applyRoute('relocate')">按路 B 挪位重排</button>
          </div>
        </div>
      </div>
      <p v-if="blockedNodes.length" class="blocked-line">
        以下 {{ blockedNodes.length }} 处节点暂不排步，选定上面一条路后整张重排：
        <span v-for="n in blockedNodes" :key="n.id" class="blocked-tag">{{ n.id }}（{{ posText(n) }}）</span>
      </p>
    </section>

    <section v-if="lantern.lashTrial" class="trial">
      已启用解套试算：{{ plan.overrides.length }} 处节点挪位、{{ plan.forcedOrders.length }} 处强制改序；
      预览图、构件表与导出均按重排后的同一份结果取数。
      <button @click="clearTrial">撤销试算，恢复原排程</button>
      <div v-if="pristine" class="pristine">
        原排程（已被取代）：{{ pristine.steps.length }} 步 / {{ pristine.tieCount }} 道 /
        {{ (pristine.wireMm / 1000).toFixed(3) }}m，其中 {{ pristine.deadlocks.length }} 处死锁。
      </div>
    </section>

    <!-- 工步清单（按层分组） -->
    <section class="steps">
      <h3>照单绑扎的工步清单（自底盘圈向收口圈）</h3>
      <div v-for="g in stepsByLayer" :key="g.layer" class="layer-block">
        <h4>第 {{ g.layer + 1 }} 层 · {{ g.steps.length }} 道工步</h4>
        <div v-for="st in g.steps" :key="st.no" class="step">
          <div class="step-no">第<br />{{ st.no }}<br />步</div>
          <div class="step-body">
            <div class="step-title">{{ st.title }} · {{ st.nodes.length }} 处节点可同时上 · {{ st.ties }} 道扎 · 用线 {{ st.wireMm.toFixed(1) }}mm</div>
            <div class="node-chips">
              <span
                v-for="n in st.nodes"
                :key="n.id"
                class="chip"
                :class="{ suspicious: n.suspicious, moved: n.overrideDyMm }"
              >
                {{ n.id }}
                <em>{{ posText(n) }}</em>
                <i v-if="n.jointCount">·含余量×{{ n.jointCount }}</i>
                <small class="chip-tip">
                  {{ stripNames(n) }}<template v-if="n.suspicious">｜⚠ {{ n.suspiciousReason }}</template>
                </small>
              </span>
            </div>
            <div class="step-note">{{ st.note }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 规则与精度 -->
    <section class="rules">
      <h3>去重、取整与用线口径</h3>
      <ul>
        <li>{{ plan.rules.stepText }}</li>
        <li>{{ plan.rules.roundText }}</li>
        <li>{{ plan.rules.boundaryText }}</li>
        <li>{{ plan.rules.wireText }}</li>
        <li>扎线守恒核对：{{ plan.tieCount }} 道 × {{ CRAFT.lashPerJointM.toFixed(2) }}m = {{ (plan.wireMm / 1000).toFixed(3) }}m，逐节点合计同为 {{ (plan.wireMm / 1000).toFixed(3) }}m，差 10mm（1cm）即在自检 CHK-09 报红。</li>
      </ul>
    </section>

    <ChecksPanel
      :checks="full.checks.filter((c) => ['CHK-09', 'CHK-10', 'CHK-11', 'CHK-04'].includes(c.id))"
      :elapsed-ms="full.elapsedMs"
      title="绑扎节点自检"
    />

    <div class="nav-links">
      <router-link :to="`/design/${lantern.id}`">← 回参数与灯体预览（节点与扎道描在灯体上）</router-link>
      <router-link :to="`/frame/${lantern.id}`">骨架构件表（每行标节点数/扎道/用线）→</router-link>
    </div>
  </div>
</template>

<style scoped>
.lash-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
}

h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: #8f1c19;
  border-left: 4px solid var(--red);
  padding-left: 10px;
}

.sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  max-width: 920px;
}

.ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  padding: 6px 12px;
  font-size: 12.5px;
}

button:hover {
  border-color: var(--red);
  color: var(--red);
}

button.primary {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
  font-weight: 600;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}

.stat {
  background: var(--surface);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
}

.stat span {
  font-size: 11px;
  color: var(--ink-soft);
}

.stat b {
  font-family: var(--mono);
  font-size: 16px;
}

.stat.bad b {
  color: var(--red);
}

.modes,
.deadlock,
.steps,
.rules,
.trial {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: var(--shadow);
}

h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.mode-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 900px) {
  .mode-cards {
    grid-template-columns: 1fr;
  }
}

.mode-card {
  border: 2px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.mode-card:hover {
  border-color: var(--red-soft);
}

.mode-card.on {
  border-color: var(--red);
  background: #fdf3f2;
}

.mode-card header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.radio {
  color: var(--red);
  font-size: 16px;
}

.mode-card em {
  margin-left: auto;
  font-style: normal;
  font-size: 11.5px;
  color: var(--jade);
  background: #eaf4ef;
  border: 1px solid #cbe3d8;
  border-radius: 999px;
  padding: 1px 8px;
}

.mode-card ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mode-card .cost {
  color: var(--ink-soft);
  font-size: 12px;
}

.mode-delta {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--blue);
}

.wrap-row {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.wrap-row input {
  width: 70px;
  font: inherit;
  font-family: var(--mono);
  padding: 3px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
}

.wrap-row small {
  color: var(--ink-soft);
}

.discard {
  margin-top: 12px;
  padding: 9px 12px;
  font-size: 12.5px;
  background: #fdf3e2;
  border: 1px solid #e8cfa4;
  border-radius: 8px;
  color: #8a4b12;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.discard button {
  padding: 2px 10px;
  font-size: 12px;
}

.deadlock {
  border-color: #e0a39d;
  background: #fdf6f5;
}

.dead-card {
  border: 1px solid #ecc9c4;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}

.dead-reason {
  margin: 0 0 8px;
  font-weight: 600;
  font-size: 13px;
}

.dead-nodes {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dead-nodes .dim {
  color: var(--ink-soft);
}

.routes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 900px) {
  .routes {
    grid-template-columns: 1fr;
  }
}

.route {
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.route h4 {
  margin: 0;
  font-size: 13px;
}

.route p {
  margin: 0;
  font-size: 12.5px;
}

.route .price {
  color: #8a4b12;
  font-size: 12px;
}

.route button {
  align-self: flex-start;
}

.blocked-line {
  margin: 12px 0 0;
  font-size: 12.5px;
}

.blocked-tag {
  display: inline-block;
  margin: 3px 4px 0 0;
  padding: 2px 8px;
  background: #fdecea;
  border: 1px solid #f2c7c1;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--red);
}

.trial {
  background: #eef6f2;
  border-color: #b7d8cb;
  font-size: 12.5px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.pristine {
  width: 100%;
  font-size: 12px;
  color: var(--ink-soft);
}

.layer-block {
  margin-bottom: 14px;
}

.layer-block h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #8f1c19;
  border-bottom: 2px solid #ecd6c4;
  padding-bottom: 4px;
}

.step {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--line);
}

.step:last-child {
  border-bottom: none;
}

.step-no {
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--red);
  color: #fff;
  display: grid;
  place-items: center;
  text-align: center;
  font-size: 10px;
  line-height: 1.15;
  font-weight: 600;
}

.step-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.step-title {
  font-size: 13px;
  font-weight: 600;
}

.node-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  font-size: 11.5px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  border-radius: 6px;
  padding: 2px 7px;
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
}

.chip em {
  font-style: normal;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-soft);
}

.chip i {
  font-style: normal;
  color: var(--gold);
  font-size: 10.5px;
}

.chip-tip {
  flex-basis: 100%;
  color: var(--ink-soft);
  font-size: 10.5px;
  font-weight: 400;
}

.chip.suspicious {
  border-color: #e0a93f;
  background: #fdf6e3;
}

.chip.moved {
  border-color: var(--jade);
  background: #eaf4ef;
}

.step-note {
  font-size: 11.5px;
  color: var(--ink-soft);
}

.rules ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--ink-soft);
}

.nav-links {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.missing {
  padding: 40px;
  text-align: center;
}
</style>
