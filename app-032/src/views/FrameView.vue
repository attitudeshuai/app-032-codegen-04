<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChecksPanel from '../components/ChecksPanel.vue'
import { getLantern } from '../core/store'
import { computeAll } from '../core/checks'
import { DEFAULT_LOFT_OPTIONS } from '../core/paginate'
import { groupMembers } from '../core/frame'
import { kindName, membersCsv, downloadText, lashMembersCsv, lashStepsCsv, lashNodesCsv } from '../core/exporter'
import { styleLabel } from '../core/craft'
import type { FrameMember } from '../core/types'
import type { MemberLashRow } from '../core/lashing'

const route = useRoute()
const router = useRouter()
const lantern = computed(() => getLantern(route.params.id as string))
const full = computed(() => {
  const l = lantern.value
  if (!l) return null
  return computeAll(l, { ...DEFAULT_LOFT_OPTIONS, paper: l.pageSize, overlapMm: l.overlapMm })
})
const groups = computed(() => (full.value ? groupMembers(full.value.frame.members) : []))

/** 构件绑扎用量行（取自绑扎节点图同一份结果） */
const lashRowOf = computed(() => {
  const map = new Map<string, MemberLashRow>()
  if (full.value) for (const row of full.value.lash.members) map.set(row.memberId, row)
  return map
})

const lashTotal = computed(() => {
  const p = full.value?.lash
  if (!p) return { ties: 0, wire: 0, nodes: 0 }
  return { ties: p.members.reduce((s, m) => s + m.tiesTotal, 0), wire: p.members.reduce((s, m) => s + m.wireMmTotal, 0), nodes: p.nodeCount }
})
function bendText(m: FrameMember): string {
  if (m.bendRadiusMm) return `R${m.bendRadiusMm.toFixed(1)}mm`
  if (m.bendAngleDeg) return `${m.bendAngleDeg.toFixed(1)}°`
  return '—'
}

function exportCsv() {
  const l = lantern.value
  if (!l || !full.value) return
  downloadText(`${l.name}-构件清单.csv`, membersCsv(l, full.value.frame.members))
}

function exportLash() {
  const l = lantern.value
  if (!l || !full.value) return
  downloadText(`${l.name}-构件绑扎用量.csv`, lashMembersCsv(l, full.value.lash))
}

function exportSteps() {
  const l = lantern.value
  const f = full.value
  if (!l || !f) return
  downloadText(`${l.name}-绑扎工步清单.csv`, lashStepsCsv(l, f.lash))
  setTimeout(() => downloadText(`${l.name}-绑扎节点明细.csv`, lashNodesCsv(l, f.lash)), 150)
}
</script>

<template>
  <div v-if="!lantern || !full" class="missing">找不到该灯样。<router-link to="/">返回</router-link></div>
  <div v-else class="frame-view">
    <section class="head">
      <div>
        <h2>骨架件表 · {{ lantern.name }}</h2>
        <p class="sub">
          {{ styleLabel(lantern.mouthStyle) }} / {{ styleLabel(lantern.bottomStyle) }} ·
          最大直径 {{ lantern.maxDiameterMm }}mm · 总高 {{ lantern.totalHeightMm }}mm ·
          {{ lantern.layers.length }} 层 · {{ lantern.sides }} 棱 ·
          每根篾两端各留 <b>{{ lantern.lashAllowanceMm }}mm</b> 绑扎余量，
          横篾圈接头处（圆形 1 处 / 多边形 {{ lantern.sides }} 处）同样加余量。
        </p>
      </div>
      <div class="ops">
        <button @click="exportCsv">导出构件清单 CSV</button>
        <button @click="exportLash">导出构件绑扎用量 CSV</button>
        <button @click="exportSteps">导出绑扎工步清单 CSV</button>
        <button class="primary" @click="router.push(`/lashing/${lantern.id}`)">看绑扎节点图与工步</button>
      </div>
    </section>

    <section class="stats">
      <div class="stat"><span>构件总根数</span><b>{{ full.frame.totalQty }}</b></div>
      <div class="stat"><span>备料总长（含余量）</span><b>{{ (full.frame.stockLengthMm / 1000).toFixed(3) }} m</b></div>
      <div class="stat"><span>净长合计</span><b>{{ (full.frame.rawLengthMm / 1000).toFixed(3) }} m</b></div>
      <div class="stat"><span>绑扎余量合计</span><b>{{ full.frame.lashExtraMm.toFixed(1) }} mm</b></div>
      <div class="stat"><span>绑扎节点（同源）</span><b>{{ full.lash.nodeCount }} 处</b></div>
      <div class="stat"><span>扎道合计</span><b>{{ full.lash.tieCount }} 道</b></div>
      <div class="stat"><span>扎线用量</span><b>{{ (full.lash.wireMm / 1000).toFixed(3) }} m</b></div>
      <div class="stat"><span>合并方式</span><b style="font-size:12px">{{ full.lash.mode === 'space' ? '按空间位置' : '按篾组合' }}</b></div>
    </section>

    <p class="same-source">
      下表每行的「参与节点 / 分到扎道 / 用线」取自绑扎节点图同一份工步清单（共节点的一道扎按参与篾根数分摊，合计守恒：
      表内扎道 {{ lashTotal.ties.toFixed(1) }} = 扎道总数 {{ full.lash.tieCount }}；表内用线 {{ lashTotal.wire.toFixed(1) }}mm =
      节点用线总量 {{ full.lash.wireMm.toFixed(1) }}mm）。余量处数 ×{{ lantern.lashAllowanceMm }}mm 决定截取长度，余量处数同时参与扎道数计算。
    </p>

    <section v-for="grp in groups" :key="grp.group" class="group">
      <h3>{{ grp.group }}</h3>
      <table>
        <thead>
          <tr>
            <th>构件名称</th>
            <th>类别</th>
            <th class="num">净长 (mm)</th>
            <th class="num">截取长度 (mm，含余量)</th>
            <th class="num">余量处数</th>
            <th class="num">数量</th>
            <th class="num">总截取长 (mm)</th>
            <th class="num">单根参与节点</th>
            <th class="num">单根分到扎道</th>
            <th class="num">单根用线 (mm)</th>
            <th>弯曲半径 / 折角</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in grp.items" :key="m.id">
            <td class="name">{{ m.label }}</td>
            <td>{{ kindName(m.kind) }}</td>
            <td class="num mono">{{ m.rawLengthMm.toFixed(1) }}</td>
            <td class="num mono strong">{{ m.lengthMm.toFixed(1) }}</td>
            <td class="num mono">×{{ m.lashJoints }}</td>
            <td class="num mono">{{ m.qty }}</td>
            <td class="num mono">{{ (m.lengthMm * m.qty).toFixed(1) }}</td>
            <td class="num mono lash-cell">{{ lashRowOf.get(m.id)?.nodesPer ?? '—' }}</td>
            <td class="num mono lash-cell">{{ lashRowOf.get(m.id) ? lashRowOf.get(m.id)!.tiesPer.toFixed(2) : '—' }}</td>
            <td class="num mono lash-cell">{{ lashRowOf.get(m.id) ? lashRowOf.get(m.id)!.wireMmPer.toFixed(1) : '—' }}</td>
            <td class="mono small">{{ bendText(m) }}</td>
            <td class="note">{{ m.note }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <ChecksPanel
      :checks="full.checks.filter((c) => ['CHK-01', 'CHK-02', 'CHK-04', 'CHK-09', 'CHK-11', 'CHK-08'].includes(c.id))"
      :elapsed-ms="full.elapsedMs"
      title="骨架与绑扎节点自检"
    />
  </div>
</template>

<style scoped>
.frame-view {
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
  max-width: 900px;
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

button.primary:hover {
  background: #9c1f1b;
  color: #fff;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
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
  font-size: 15px;
}

.group {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: var(--shadow);
}

.group h3 {
  margin: 0;
  padding: 8px 14px;
  font-size: 13px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
  color: var(--ink);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

th {
  text-align: left;
  padding: 7px 12px;
  color: var(--ink-soft);
  font-weight: 500;
  font-size: 11.5px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

td {
  padding: 7px 12px;
  border-bottom: 1px dashed var(--line);
  vertical-align: top;
}

tr:last-child td {
  border-bottom: none;
}

.num {
  text-align: right;
}

.mono {
  font-family: var(--mono);
}

.strong {
  font-weight: 700;
  color: #8f1c19;
}

.small {
  font-size: 12px;
}

.name {
  font-weight: 600;
}

.note {
  color: var(--ink-soft);
  font-size: 12px;
  max-width: 340px;
}

.lash-cell {
  color: #8f1c19;
  font-weight: 600;
}

.same-source {
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--surface-2);
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
}

.missing {
  padding: 40px;
  text-align: center;
}
</style>
