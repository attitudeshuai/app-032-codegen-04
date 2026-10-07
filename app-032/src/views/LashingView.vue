<script setup lang="ts">
/**
 * 绑扎节点图与工步清单页
 * 节点位置、扎道数、用线量全部取自 full.lashing（= computeAll → buildLashing 这同一份），
 * 与参数预览页、骨架构件表、导出 CSV / 打印表完全同源。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChecksPanel from '../components/ChecksPanel.vue'
import { getLantern } from '../core/store'
import { computeAll } from '../core/checks'
import { DEFAULT_LOFT_OPTIONS } from '../core/paginate'
import {
  compareModes,
  snapshotPlan,
  diffPlans,
  FOOTPRINT_MM,
  type LashPlan
} from '../core/lashing'
import type { LashMergeMode } from '../core/types'
import { useLashState } from '../core/lashState'
import { downloadText, lashingCsv } from '../core/exporter'
import { CRAFT } from '../core/craft'

const route = useRoute()
const router = useRouter()
const lantern = computed(() => getLantern(route.params.id as string))
const full = computed(() => {
  const l = lantern.value
  if (!l) return null
  return computeAll(l, { ...DEFAULT_LOFT_OPTIONS, paper: l.pageSize, overlapMm: l.overlapMm })
})

const cmp = computed(() => (lantern.value ? compareModes(lantern.value) : null))
const mode = computed<LashMergeMode>({
  get: () => lantern.value?.lashingMerge ?? 'position',
  set: (v) => {
    if (lantern.value) lantern.value.lashingMerge = v
    chosenFix.value = null
  }
})

/** 卡死时当场采用的解法路线（只影响当前出图，不写回灯样几何） */
const chosenFix = ref<null | 'reorder' | 'shift'>(null)
const basePlan = computed<LashPlan | null>(() => (mode.value === 'position' ? cmp.value?.position ?? null : cmp.value?.combination ?? null))
const plan = computed<LashPlan | null>(() => {
  const b = basePlan.value
  if (!b || !b.deadlocks.length || !chosenFix.value || !b.fixes) return b
  return chosenFix.value === 'reorder' ? b.fixes.reorder.plan : b.fixes.shift.plan
})

const lashStore = useLashState()
const st = computed(() => (lantern.value ? lashStore.ensure(lantern.value.id, mode.value) : null))
const stale = computed(() => !!(plan.value && st.value?.approvedSignature && lashStore.isStale(lantern.value!.id, plan.value.signature)))
const diff = computed(() => {
  if (!plan.value || !st.value?.snapshot) return null
  return diffPlans(st.value.snapshot, plan.value)
})

function switchMode(v: LashMergeMode) {
  chosenFix.value = null
  mode.value = v
}

function approveCurrent() {
  const l = lantern.value
  const p = plan.value
  if (!l || !p) return
  lashStore.approve(
    l.id,
    mode.value,
    snapshotPlan(p),
    { nodes: p.nodeCount, ties: p.totalTies, wireM: p.totalWireM, steps: p.stepCount }
  )
  lashStore.markExported(l.id, mode.value, '已批准工步（现场版）')
}

function exportCsv() {
  const l = lantern.value
  const p = plan.value
  if (!l || !p) return
  downloadText(`${l.name}-绑扎工步清单-${p.mode === 'position' ? '位置合并' : '组合合并'}.csv`, lashingCsv(l, p))
  lashStore.markExported(l.id, mode.value, `${l.name}-绑扎工步清单.csv`)
}

const bands = computed(() => {
  if (!plan.value) return []
  const out: { name: string; steps: typeof plan.value.steps }[] = []
  for (const s of plan.value.steps) {
    let g = out.find((x) => x.name === s.bandName)
    if (!g) {
      g = { name: s.bandName, steps: [] }
      out.push(g)
    }
    g.steps.push(s)
  }
  return out
})

function nodeByCode(code: string) {
  return plan.value?.nodes.find((n) => n.code === code)
}

function nodePos(code: string) {
  const nd = nodeByCode(code)
  return nd ? `(${nd.xMm.toFixed(1)}, ${nd.yMm.toFixed(1)})mm` : ''
}

const rowTiesTotal = computed(() => plan.value?.rows.reduce((s, r) => s + r.ties, 0) ?? 0)
/** 原始方案的卡死信息（无论是否已选解法都保留展示） */
const dl = computed(() => basePlan.value?.deadlocks ?? [])
const dlFixes = computed(() => basePlan.value?.fixes ?? null)
</script>

<template>
  <div v-if="!lantern || !full || !plan || !cmp" class="missing">找不到该灯样。<router-link to="/">返回</router-link></div>
  <div v-else class="lash-view">
    <section class="head">
      <div>
        <h2>绑扎节点图与工步清单 · {{ lantern.name }}</h2>
        <p class="sub">
          按一根根篾在灯体上的交会算节点，自底向上排先后：<b>下层没绑完上层绑不上</b>，同层绕线经过处（包络
          {{ FOOTPRINT_MM }}mm）不互压的同一工步一起上。位置、扎道数、用线量与
          <router-link :to="`/design/${lantern.id}`">参数预览</router-link>、
          <router-link :to="`/frame/${lantern.id}`">骨架构件表</router-link>、导出清单<b>同一份取数</b>。
        </p>
      </div>
      <div class="ops">
        <button @click="exportCsv">导出工步清单 CSV</button>
        <button class="primary" @click="router.push(`/print/${lantern.id}?view=lashing`)">打印工步清单</button>
      </div>
    </section>

    <!-- 旧版作废横幅 -->
    <section v-if="stale" class="void-banner">
      <h3>⚠ 当前灯样已改动，旧版节点图与已导出的工步清单全部作废，须整张重排重来</h3>
      <ul>
        <li>
          旧版（{{ st!.mode === 'position' ? '按空间位置合并' : '按交会篾组合合并' }}，{{ st!.approvedAt }} 批准）：
          {{ st!.totals.nodes }} 处节点 / {{ st!.totals.ties }} 道扎 / {{ st!.totals.wireM.toFixed(3) }}m 扎线 /
          {{ st!.totals.steps }} 步 —— 排列次序与扎线用量随之失效。
        </li>
        <li>
          已经照旧版绑好的层带要点名拆开重绑：
          <b v-if="st!.boundBands.length">{{ st!.boundBands.join('、') }}</b>
          <span v-else class="muted">（尚未勾选已绑层；在下方工步表勾选现场已完成的层带，作废时会点名）</span>
        </li>
        <li v-if="st!.exportedNames.length">已导出/已发放的文件须收回：{{ st!.exportedNames.join('、') }}</li>
      </ul>
      <button class="primary" @click="approveCurrent">确认新版无误，以此版为准（旧版正式作废）</button>
    </section>

    <!-- 汇总 -->
    <section class="stats">
      <div class="stat"><span>节点</span><b>{{ plan.nodeCount }} 处</b></div>
      <div class="stat"><span>扎道合计</span><b>{{ plan.totalTies }} 道</b></div>
      <div class="stat"><span>扎线总量</span><b>{{ plan.totalWireM.toFixed(3) }} m（{{ (plan.totalWireM * 100).toFixed(1) }}cm）</b></div>
      <div class="stat"><span>工步</span><b>{{ plan.stepCount }} 步</b></div>
      <div class="stat"><span>逐行加总扎道</span><b :class="{ bad: rowTiesTotal !== plan.totalTies }">{{ rowTiesTotal }} 道</b></div>
      <div class="stat"><span>余量处数</span><b>{{ plan.allowanceIncidences }} / 构件表 {{ plan.allowanceJointsFromFrame }}</b></div>
      <div class="stat"><span>贴整毫米边界节点</span><b>{{ plan.boundaryCount }} 个</b></div>
    </section>

    <!-- 合并方式二选一 -->
    <section class="modes">
      <h3>节点怎么合并：二选一（选错的一版连同已导出清单作废重来）</h3>
      <div class="mode-cards">
        <div class="mode-card" :class="{ on: mode === 'position' }" @click="switchMode('position')">
          <h4>按空间位置合并</h4>
          <p class="good">节点与扎道少、工步短：{{ cmp.position.nodeCount }} 处 / {{ cmp.position.totalTies }} 道 /
            {{ cmp.position.totalWireM.toFixed(3) }}m / {{ cmp.position.stepCount }} 步</p>
          <p class="bad">代价：相邻两层落在同一 {{ 1 }}mm 格会被并错
            <span v-if="cmp.positionCrossBand">（当前已并错 {{ cmp.positionCrossBand }} 处，见下方卡死）</span>
            <span v-else>（当前未发生；层间距 &lt; {{ FOOTPRINT_MM }}mm 时风险出现）</span>。
          </p>
          <p class="muted">被交会扎一并缠上的端头/接头不另绕，比组合方案省
            {{ cmp.extraTies }} 道扎线（{{ cmp.extraWireM.toFixed(3) }}m）、少 {{ cmp.extraNodes }} 处节点、少
            {{ cmp.extraSteps }} 步工。</p>
        </div>
        <div class="mode-card" :class="{ on: mode === 'combination' }" @click="switchMode('combination')">
          <h4>按交会的篾组合合并</h4>
          <p class="good">绝不并错：每个端头、每道接头按交会篾组合独立成点。</p>
          <p class="bad">代价：节点明显变多——{{ cmp.combination.nodeCount }} 处 / {{ cmp.combination.totalTies }} 道 /
            {{ cmp.combination.totalWireM.toFixed(3) }}m / {{ cmp.combination.stepCount }} 步，
            比位置方案多 {{ cmp.extraTies }} 道扎（多 {{ cmp.extraWireM.toFixed(3) }}m 扎线）、多
            {{ cmp.extraNodes }} 处节点、多 {{ cmp.extraSteps }} 步工。</p>
        </div>
      </div>
      <p class="decision">
        当前取舍：<b>{{ mode === 'position' ? '按空间位置合并' : '按交会篾组合合并' }}</b>（版本签名
        <span class="mono">{{ plan.signature }}</span>）。
        放弃的那条路让出：{{ mode === 'position' ? `组合方案多用 ${cmp.extraTies} 道扎线 / ${cmp.extraWireM.toFixed(3)}m / ${cmp.extraSteps} 道工序，位置方案让出的是这部分人工与扎线，风险是跨层同格并错` : `位置方案少 ${cmp.extraTies} 道扎线 / ${cmp.extraWireM.toFixed(3)}m、少 ${cmp.extraSteps} 道工序，放弃它换来的是绝不并错` }}。
      </p>
    </section>

    <!-- 卡死与两条路线 -->
    <section v-if="dl.length" class="deadlock">
      <h3>排不出先后：{{ dl.length }} 处互相卡住（当场点出）</h3>
      <ul>
        <li v-for="d in dl" :key="d.nodeKey">
          <b>{{ d.code }}</b> {{ d.posText }}：<b>{{ d.placeA }}</b> 与 <b>{{ d.placeB }}</b> 两处互相等对方先绑。
        </li>
      </ul>
      <div v-if="dlFixes" class="fixes">
        <div class="fix" :class="{ chosen: chosenFix === 'reorder' }" @click="chosenFix = 'reorder'">
          <h4>路线一：改绑扎次序（同点拆成先后两道）</h4>
          <p>{{ dlFixes.reorder.detail }}</p>
          <p class="muted">让出代价：不挪篾、不改灯形；多扎 {{ dlFixes.reorder.addedTies }} 道、多
            {{ dlFixes.reorder.addedSteps }} 步、多 {{ dlFixes.reorder.addedWireM.toFixed(3) }}m 扎线。</p>
        </div>
        <div class="fix" :class="{ chosen: chosenFix === 'shift' }" @click="chosenFix = 'shift'">
          <h4>路线二：挪开上层一个节点（环向错位 {{ FOOTPRINT_MM }}mm）</h4>
          <p>{{ dlFixes.shift.detail }}</p>
          <p class="muted">让出代价：竹篾引弯 {{ dlFixes.shift.addedBendMm }}mm（竹篾损耗，不是扎线）、蒙面对位标记同步挪
            {{ FOOTPRINT_MM }}mm；扎道不增加。</p>
        </div>
      </div>
      <p v-if="chosenFix" class="fix-note">已按「{{ chosenFix === 'reorder' ? '改绑扎次序' : '挪开节点' }}」重排：
        {{ plan.nodeCount }} 处 / {{ plan.totalTies }} 道 / {{ plan.stepCount }} 步，卡死 {{ plan.deadlocks.length }} 处。确认后点下方「以此版为准」。</p>
    </section>

    <!-- 改棱/层数后的三处变化 -->
    <section v-if="diff" class="diff">
      <h3>相对上一批准版，整张重排后的三处变化</h3>
      <p v-if="!diff.changed" class="muted">三处均无变化（签名仍不同仅因版本戳）。</p>
      <template v-else>
        <div class="diff-col">
          <h4>① 预览图上挪动的节点（{{ diff.moved.length }}）</h4>
          <ul>
            <li v-for="m in diff.moved.slice(0, 30)" :key="m.key">
              {{ m.code }}：{{ m.from }} → {{ m.to }}（挪 {{ m.dMm.toFixed(1) }}mm）
            </li>
            <li v-if="diff.moved.length > 30">… 另 {{ diff.moved.length - 30 }} 处</li>
          </ul>
          <p v-if="diff.nodesAdded.length || diff.nodesRemoved.length" class="muted">
            新增 {{ diff.nodesAdded.join('、') || '—' }}；消失 {{ diff.nodesRemoved.join('、') || '—' }}
          </p>
        </div>
        <div class="diff-col">
          <h4>② 构件表里扎道数/用线量变了的篾（{{ diff.rowsChanged.length }}）</h4>
          <ul>
            <li v-for="r in diff.rowsChanged" :key="r.label">
              {{ r.label }}：节点 {{ r.nodesFrom }}→{{ r.nodesTo }} 处，扎道 {{ r.tiesFrom }}→{{ r.tiesTo }} 道，
              用线 {{ r.wireFrom.toFixed(3) }}→{{ r.wireTo.toFixed(3) }}m
            </li>
          </ul>
        </div>
        <div class="diff-col">
          <h4>③ 工步清单先后跟着换的步（{{ diff.stepsReordered.length }}）</h4>
          <ul>
            <li v-for="s in diff.stepsReordered.slice(0, 30)" :key="s.key">
              {{ s.code }}：第 {{ s.from }} 步 → 第 {{ s.to }} 步
            </li>
          </ul>
          <p v-if="diff.affectedBands.length" class="muted">涉及层带：{{ diff.affectedBands.join('、') }}</p>
        </div>
      </template>
    </section>

    <!-- 工步清单 -->
    <section class="steps">
      <div class="block-head">
        <h3>工步清单（照单做；同一格内可同时上）</h3>
        <div v-if="st" class="band-checks">
          <span class="muted">现场已绑（旧版作废时点名拆绑）：</span>
          <label v-for="b in bands" :key="b.name">
            <input type="checkbox" :checked="st.boundBands.includes(b.name)" @change="lashStore.toggleBound(lantern.id, mode, b.name)" />
            {{ b.name }}
          </label>
        </div>
      </div>
      <div v-for="b in bands" :key="b.name" class="band">
        <h4>
          {{ b.name }}
          <span class="muted">
            · 已绑：{{ st?.boundBands.includes(b.name) ? '是' : '否' }}
          </span>
        </h4>
        <table>
          <thead>
            <tr>
              <th class="num">步</th>
              <th>内容</th>
              <th>本步节点（编号 · 扎道数）</th>
              <th class="num">节点数</th>
              <th class="num">扎道</th>
              <th class="num">扎线(m)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in b.steps" :key="s.ordinal">
              <td class="num mono strong">{{ s.ordinal }}</td>
              <td>{{ s.title }}</td>
              <td class="nodes">
                <span v-for="code in s.nodeCodes" :key="code" class="node-chip" :title="nodePos(code)">
                  {{ code }}·{{ nodeByCode(code)?.ties }}
                </span>
              </td>
              <td class="num mono">{{ s.nodeCodes.length }}</td>
              <td class="num mono">{{ s.ties }}</td>
              <td class="num mono">{{ s.wireM.toFixed(3) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 节点明细 -->
    <section class="nodes">
      <h3>节点明细（坐标 mm，1 位小数；括号内为 1mm 去重格）</h3>
      <table>
        <thead>
          <tr>
            <th>节点</th>
            <th>层带</th>
            <th class="num">棱</th>
            <th>位置 (x, y, z) mm</th>
            <th>去重格</th>
            <th class="num">扎道</th>
            <th class="num">扎线(m)</th>
            <th>交会篾</th>
            <th>提示</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="nd in plan.nodes" :key="nd.primaryKey" :class="{ dead: nd.crossBand }">
            <td class="mono strong">{{ nd.code }}</td>
            <td>{{ nd.bandName }}</td>
            <td class="num">{{ nd.corner >= 0 ? nd.corner + 1 : '轴' }}</td>
            <td class="mono">({{ nd.xMm.toFixed(1) }}, {{ nd.yMm.toFixed(1) }}, {{ nd.zMm.toFixed(1) }})</td>
            <td class="mono muted">({{ nd.gx }},{{ nd.gy }},{{ nd.gz }})</td>
            <td class="num mono strong">{{ nd.ties }}</td>
            <td class="num mono">{{ nd.wireM.toFixed(3) }}</td>
            <td class="members">{{ nd.memberLabels.join('、') }}</td>
            <td class="warns">
              <b v-if="nd.crossBand" class="bad">跨层并错·卡死</b>
              <span v-if="nd.boundary" class="edge">贴整毫米边界</span>
              <span v-if="nd.shifted" class="shift">已挪 {{ nd.shifted.dMm }}mm</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 逐行记账 -->
    <section class="rowstats">
      <h3>骨架构件逐行扎线记账（与骨架件表逐格一致）</h3>
      <table>
        <thead>
          <tr>
            <th>构件行</th>
            <th class="num">数量</th>
            <th class="num">参与节点(处)</th>
            <th class="num">扎道(道)</th>
            <th class="num">扎线(m)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in plan.rows" :key="r.rowKey">
            <td>{{ r.label }}</td>
            <td class="num mono">{{ r.qty }}</td>
            <td class="num mono">{{ r.nodes }}</td>
            <td class="num mono strong">{{ r.ties }}</td>
            <td class="num mono">{{ r.wireM.toFixed(3) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <ChecksPanel
      :checks="full.checks.filter((c) => ['CHK-09', 'CHK-10', 'CHK-11'].includes(c.id))"
      :elapsed-ms="full.elapsedMs"
      title="节点图自检"
    />

    <section class="approve-foot">
      <button class="primary" @click="approveCurrent">以此版为准（批准出图 / 建立重排对照基线）</button>
      <span class="muted">每道扎线 {{ CRAFT.lashPerJointM }}m · 位置 mm（0.1 位小数）· 去重按 1mm 落格 · 差 1cm 也在 CHK-09 报出</span>
    </section>
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

h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--ink);
}

h4 {
  margin: 0 0 6px;
  font-size: 13px;
}

.sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  max-width: 980px;
}

.ops {
  display: flex;
  gap: 8px;
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

.muted {
  color: var(--ink-soft);
  font-size: 12px;
}

.mono {
  font-family: var(--mono);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
  font-size: 14px;
}

.bad {
  color: var(--red);
}

.void-banner,
.modes,
.deadlock,
.diff,
.steps,
.nodes,
.rowstats,
.approve-foot {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: var(--shadow);
}

.void-banner {
  border-color: #d88;
  background: #fdf1ef;
}

.void-banner ul {
  margin: 6px 0 10px;
  padding-left: 20px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mode-cards,
.fixes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.mode-card,
.fix {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  background: var(--surface-2);
}

.mode-card.on,
.fix.chosen {
  border-color: var(--red);
  box-shadow: 0 0 0 1px var(--red) inset;
  background: #fdf3f2;
}

.mode-card p,
.fix p {
  margin: 4px 0;
  font-size: 12.5px;
}

.good {
  color: var(--jade);
}

.decision {
  margin: 10px 0 0;
  font-size: 12.5px;
  background: var(--surface-2);
  border-radius: 6px;
  padding: 8px 10px;
}

.deadlock {
  border-color: #d88;
  background: #fdf6f5;
}

.deadlock ul {
  margin: 4px 0 10px;
  padding-left: 20px;
  font-size: 12.5px;
}

.fix-note {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--jade);
  font-weight: 600;
}

.diff {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.diff h3 {
  grid-column: 1 / -1;
}

.diff-col ul {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
}

.block-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.band-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
}

.band {
  margin-top: 10px;
}

.band h4 {
  color: #8f1c19;
  border-bottom: 1px solid var(--line);
  padding-bottom: 4px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

th {
  text-align: left;
  padding: 6px 8px;
  color: var(--ink-soft);
  font-weight: 500;
  font-size: 11.5px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

td {
  padding: 5px 8px;
  border-bottom: 1px dashed var(--line);
  vertical-align: top;
}

.num {
  text-align: right;
}

.strong {
  font-weight: 700;
  color: #8f1c19;
}

.nodes .node-chip {
  display: inline-block;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  margin: 1px 2px;
  font-family: var(--mono);
  font-size: 11.5px;
}

tr.dead {
  background: #fdf0ee;
}

.members {
  max-width: 280px;
  color: var(--ink-soft);
  font-size: 12px;
}

.warns .edge {
  color: var(--gold);
  font-size: 12px;
  margin-right: 6px;
}

.warns .shift {
  color: var(--jade);
  font-size: 12px;
}

.approve-foot {
  display: flex;
  align-items: center;
  gap: 14px;
}

.missing {
  padding: 40px;
  text-align: center;
}
</style>
