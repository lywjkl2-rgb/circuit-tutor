// 시뮬레이션 결과 → 단계별 해설 보고서 (한국어 + LaTeX)

import { COMPONENTS, formatSI, isFet, num } from '../engine/components';
import type { Netlist, SimElement } from '../engine/netlist';
import { stateKo, sourceValue, type Analysis, type OpResult } from '../engine/simulator';
import { diodeParams, fetParams } from '../engine/models';
import { cabs, carg } from '../engine/linalg';
import { findPatterns } from './patterns';
import { Graph, isVSource, type Pattern } from './topology';
import { n as tn, nv, q, sym } from './tex';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'math'; tex: string }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'note'; tone: 'info' | 'warn' | 'tip'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'flow'; steps: { label: string; detail: string; elementId?: string; node?: number; kind: 'node' | 'element' }[] }
  | { kind: 'subhead'; text: string; elementIds?: string[] };

export interface Section { id: string; title: string; blocks: Block[] }

export interface ElementRole {
  id: string;
  name: string;
  typeLabel: string;
  roles: { title: string; text: string }[];
  values: { label: string; value: string }[];
  state?: string;
}

export interface Report {
  ok: boolean;
  sections: Section[];   // 해석 순서대로
  roles: ElementRole[];
  patterns: Pattern[];
  outputNode?: number;
  warnings: string[];
}

const f = formatSI;
/** 음수 0(-0.0) 없이 고정 소수점 표기 */
const fx = (v: number, d: number) => { const s = v.toFixed(d); return /^-0\.?0*$/.test(s) ? s.slice(1) : s; };

export function explain(a: Analysis): Report {
  const { net, op } = a;
  const warnings = [...net.warnings];
  if (!op.ok) {
    return {
      ok: false, roles: [], patterns: [], warnings: [...warnings, op.error ?? '해석 실패'],
      sections: [{ id: 'error', title: '해석할 수 없음', blocks: [{ kind: 'note', tone: 'warn', text: op.error ?? '해석에 실패했습니다.' }] }],
    };
  }
  const patterns = findPatterns(net, op);
  const outputNode = pickOutputNode(net, patterns);
  const sections: Section[] = [
    overviewSection(net, op),
    structureSection(net, patterns),
    equationSection(a),
    resultSection(net, op),
    flowSection(net, op),
  ];
  const t = timeSection(a, patterns, outputNode);
  if (t) sections.push(t);
  const fr = freqSection(a, outputNode);
  if (fr) sections.push(fr);
  return { ok: true, sections, roles: elementRoles(net, op, patterns), patterns, outputNode, warnings };
}

function pickOutputNode(net: Netlist, patterns: Pattern[]): number | undefined {
  const label = net.nodeNames.findIndex(n => /^(v?out|vo|output|출력)/i.test(n));
  if (label > 0) return label;
  const prio = ['inverting', 'noninverting', 'summing', 'integrator', 'follower', 'comparator', 'bridge', 'halfwave', 'zener', 'cmos-inverter', 'common-source', 'source-follower', 'common-emitter', 'emitter-follower', 'rlc', 'rc', 'rl', 'divider'];
  for (const k of prio) {
    const p = patterns.find(pp => pp.kind === k && pp.outputNode);
    if (p) return p.outputNode;
  }
  return undefined;
}

// ------------------------------------------------------------------ 1. 개요
function overviewSection(net: Netlist, op: OpResult): Section {
  const counts = new Map<string, number>();
  for (const e of net.elements) counts.set(COMPONENTS[e.type].label, (counts.get(COMPONENTS[e.type].label) ?? 0) + 1);
  const srcs = net.elements.filter(e => ['V', 'VAC', 'VPULSE', 'I'].includes(e.type));
  const blocks: Block[] = [
    {
      kind: 'p',
      text: `이 회로는 소자 ${net.elements.length}개(${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')})와 기준 노드(접지)를 포함한 노드 ${net.nodeCount}개로 이루어져 있습니다.`,
    },
  ];
  if (srcs.length) {
    blocks.push({
      kind: 'list',
      items: srcs.map(s => {
        const p = s.props;
        switch (s.type) {
          case 'V': return `**${s.name}** — 직류 전압원 ${f(num(p, 'voltage'), 'V')}: 회로 전체에 에너지를 공급합니다.`;
          case 'VAC': return `**${s.name}** — 교류 전압원: $v(t) = ${q(num(p, 'offset'), 'V')} + ${q(num(p, 'amplitude'), 'V')}\\sin(2\\pi\\cdot${q(num(p, 'frequency'), 'Hz')}\\,t)$ (실효값 ${f(num(p, 'amplitude') / Math.SQRT2, 'V')})`;
          case 'VPULSE': return `**${s.name}** — 구형파 전압원 ${f(num(p, 'low'), 'V')} ↔ ${f(num(p, 'high'), 'V')}, ${f(num(p, 'frequency'), 'Hz')}, 듀티 ${num(p, 'duty')}%`;
          default: return `**${s.name}** — 직류 전류원 ${f(num(p, 'current'), 'A')}`;
        }
      }),
    });
  } else {
    blocks.push({ kind: 'note', tone: 'warn', text: '독립 전원이 없습니다. 모든 전압·전류가 0이 됩니다(초기 충전된 커패시터 제외).' });
  }
  if (!net.hasGround) blocks.push({ kind: 'note', tone: 'info', text: '회로에 접지 기호가 없어 전원의 − 단자를 0 V 기준으로 삼았습니다. 전압은 모두 이 기준에 대한 값입니다.' });
  for (const w of net.warnings) blocks.push({ kind: 'note', tone: 'warn', text: w });
  void op;
  return { id: 'overview', title: '1. 회로 구성 파악', blocks };
}

// ------------------------------------------------------------------ 2. 구조/패턴
function structureSection(net: Netlist, patterns: Pattern[]): Section {
  const blocks: Block[] = [];
  if (!patterns.length) {
    blocks.push({ kind: 'p', text: '잘 알려진 기본 회로 패턴은 찾지 못했습니다. 아래의 일반적인 절점 해석(MNA)으로 회로를 풉니다.' });
  } else {
    blocks.push({ kind: 'p', text: `회로를 잘 알려진 기본 구조로 나누어 보면 다음 ${patterns.length}가지가 보입니다. 복잡한 회로도 이런 기본 블록의 조합으로 이해할 수 있습니다.` });
  }
  for (const p of patterns) {
    blocks.push({ kind: 'subhead', text: p.title, elementIds: p.elementIds });
    for (const t of p.text) blocks.push({ kind: 'p', text: t });
    for (const fm of p.formulas) blocks.push({ kind: 'math', tex: fm });
  }
  void net;
  return { id: 'structure', title: '2. 회로 구조와 동작 원리', blocks };
}

// ------------------------------------------------------------------ 3. 방정식 세우기 (MNA)
function termFor(e: SimElement, node: number, net: Netlist): string | null {
  const nn = (k: number) => nv(net.nodeNames[k], k);
  const pinIdx = e.nodes.indexOf(node);
  const other = e.nodes.length === 2 ? e.nodes[1 - pinIdx] : -1;
  const diff = (a: number, b: number) => (b === 0 ? nn(a) : `(${nn(a)} - ${nn(b)})`);
  switch (e.type) {
    case 'R': return `\\frac{${diff(node, other)}}{${sym(e.name)}}`;
    case 'SW': return e.props.closed ? `\\frac{${diff(node, other)}}{R_{on}}` : null;
    case 'C': return null; // 직류: 개방
    case 'L': case 'V': case 'VAC': case 'VPULSE': case 'AM':
      return pinIdx === 0 ? `I_{${e.name}}` : `-I_{${e.name}}`;
    case 'I': return pinIdx === 0 ? `${sym(e.name)}` : `-${sym(e.name)}`;
    case 'D': case 'LED': case 'ZD': return pinIdx === 0 ? `I_{${e.name}}` : `-I_{${e.name}}`;
    case 'NPN': case 'PNP': return ['I_{B', 'I_{C', 'I_{E'][pinIdx] + `,${e.name}}`;
    case 'NMOS': case 'PMOS': return pinIdx === 0 ? null : (pinIdx === 1 ? '' : '-') + `I_{D,${e.name}}`;
    case 'NJF': case 'PJF': return ['I_{G', 'I_{D', 'I_{S'][pinIdx] + `,${e.name}}`;
    case 'OPAMP': return pinIdx === 2 ? `I_{out,${e.name}}` : null;
    default: return null;
  }
}

function equationSection(a: Analysis): Section {
  const { net, op } = a;
  const blocks: Block[] = [];
  blocks.push({
    kind: 'p',
    text: '회로를 푸는 표준 절차는 **수정 절점 해석법(MNA)** 입니다. ① 기준 노드(접지)를 정하고 ② 나머지 노드 전압을 미지수로 둔 뒤 ③ 각 노드에서 키르히호프 전류 법칙(KCL: 나가는 전류의 합 = 0)을 세우고 ④ 전압원마다 "두 단자 전압차 = 전원 전압" 식을 더해 연립방정식을 풉니다.',
  });
  if (net.elements.some(e => e.type === 'C' || e.type === 'L')) {
    blocks.push({ kind: 'note', tone: 'info', text: '직류 정상 상태(충분히 오랜 시간 뒤)에서는 커패시터를 **개방**, 인덕터를 **단락(0 V 전압원)**으로 바꿔 풉니다. 시간에 따른 변화는 아래 "시간 응답" 단계에서 다룹니다.' });
  }
  blocks.push({ kind: 'subhead', text: '① 노드 정의' });
  blocks.push({
    kind: 'list',
    items: net.nodeNames.map((nm, i) => i === 0 ? `**GND** — 기준 노드, $0\\,\\text{V}$` : `**${nm}** — 미지수 $${nv(nm, i)}$ (연결: ${net.elements.filter(e => e.nodes.includes(i)).map(e => e.name).join(', ')})`),
  });
  blocks.push({ kind: 'subhead', text: '② 각 노드의 KCL (나가는 전류의 합 = 0)' });
  for (let k = 1; k < net.nodeCount; k++) {
    const terms = net.elements.flatMap(e => e.nodes.map((nd, i) => (nd === k ? { e, i } : null)).filter(Boolean) as { e: SimElement; i: number }[])
      .map(({ e }) => termFor(e, k, net)).filter((t): t is string => !!t);
    if (!terms.length) continue;
    const eq = terms.join(' + ').replace(/\+ -/g, '- ');
    blocks.push({ kind: 'math', tex: `\\text{${net.nodeNames[k]}}:\\quad ${eq} = 0` });
  }
  const constraints: string[] = [];
  for (const e of net.elements) {
    const [p, m] = e.nodes;
    const nn = (k: number) => nv(net.nodeNames[k], k);
    const lhs = m === 0 ? nn(p) : `${nn(p)} - ${nn(m)}`;
    if (e.type === 'V') constraints.push(`${lhs} = ${q(num(e.props, 'voltage'), 'V')} \\quad (${e.name})`);
    if (e.type === 'VAC' || e.type === 'VPULSE') constraints.push(`${lhs} = v_{${e.name}}(t) \\quad (\\text{t=0: } ${q(sourceValue(e, 0), 'V')})`);
    if (e.type === 'AM') constraints.push(`${lhs} = 0 \\quad (${e.name}\\text{: 전류계는 0 V 전압원})`);
    if (e.type === 'L') constraints.push(`${lhs} = 0 \\quad (${e.name}\\text{: 직류에서 단락})`);
    if (e.type === 'OPAMP') {
      const [nm, np, no] = e.nodes;
      constraints.push(`${nn(no)} = V_{sat}\\tanh\\!\\left(\\frac{A(${nn(np)} - ${nn(nm)})}{V_{sat}}\\right) \\quad (${e.name})`);
    }
  }
  if (constraints.length) {
    blocks.push({ kind: 'subhead', text: '③ 전원·소자 제약식' });
    for (const c of constraints) blocks.push({ kind: 'math', tex: c });
  }
  const nl = net.elements.filter(e => ['D', 'LED', 'ZD', 'NPN', 'PNP', 'NMOS', 'PMOS', 'NJF', 'PJF'].includes(e.type));
  if (nl.length) {
    blocks.push({ kind: 'subhead', text: '④ 비선형 소자 모델' });
    for (const e of nl) {
      if (isFet(e.type)) {
        const fp = fetParams(e.type, e.props);
        const pch = fp.s < 0;
        const vgs = pch ? 'V_{SG}' : 'V_{GS}', vds = pch ? 'V_{SD}' : 'V_{DS}';
        const kTex = fp.jfet ? `\\frac{2I_{DSS}}{V_P^2}` : 'k';
        const vt = fp.jfet ? (pch ? 'V_P' : '|V_P|') : (pch ? '|V_{th}|' : 'V_{th}');
        const vtCond = fp.jfet ? `${vgs} - (-${vt})` : `${vgs} - ${vt}`;
        blocks.push({
          kind: 'math',
          tex: `${pch ? `|I_{D,${e.name}}|` : `I_{D,${e.name}}`} = \\begin{cases} 0 & ${vtCond} \\le 0\\;(\\text{차단}) \\\\ ${kTex}\\left[V_{ov}${vds} - \\tfrac12 ${vds}^2\\right](1+\\lambda ${vds}) & ${vds} < V_{ov}\\;(\\text{트라이오드}) \\\\ \\tfrac12 ${kTex}\\,V_{ov}^2(1+\\lambda ${vds}) & ${vds} \\ge V_{ov}\\;(\\text{포화}) \\end{cases},\\quad V_{ov} = ${vtCond}`,
        });
        if (fp.jfet) blocks.push({ kind: 'p', text: `JFET는 $I_{DSS} = ${q(Math.abs(num(e.props, 'idss', 0.01)), 'A')}$, $V_P = ${q(num(e.props, 'vp'), 'V')}$이므로 포화 영역 식은 $I_D = I_{DSS}\\left(1 - V_{GS}/V_P\\right)^2$과 같습니다. 게이트–채널 PN 접합이 역바이어스일 때만 정상 동작합니다.` });
        else blocks.push({ kind: 'p', text: `${e.name}: $V_{th} = ${q(num(e.props, 'vth'), 'V')}$, $k = ${q(fp.K, 'A/V²')}$, $\\lambda = ${tn(fp.lambda, 3)}\\,\\text{V}^{-1}$. 게이트는 산화막으로 절연되어 있어 직류 게이트 전류는 0입니다.` });
      } else if (e.type === 'NPN' || e.type === 'PNP') {
        blocks.push({ kind: 'math', tex: `I_{C,${e.name}} = \\\\beta I_{B,${e.name}},\\\\quad I_{B,${e.name}} \\\\approx \\\\frac{I_S}{\\\\beta}\\\\left(e^{V_{BE}/V_T} - 1\\\\right)\\\\quad(\\\\text{Ebers–Moll, }\\\\beta=${num(e.props, 'beta', 100)})` });
      } else {
        const p = diodeParams(e.type, e.props);
        blocks.push({ kind: 'math', tex: `I_{${e.name}} = I_S\\left(e^{V_D/(nV_T)} - 1\\right),\\quad I_S = ${tn(p.is, 3)}\\,\\text{A},\\; n = ${p.n}${p.bv ? `,\\; V_Z = ${q(p.bv, 'V')}` : ''}` });
      }
    }
    blocks.push({ kind: 'p', text: `지수 함수가 들어 있어 손으로는 바로 풀 수 없으므로, 시뮬레이터는 **뉴턴–랩슨 반복법**으로 식을 선형화해 풉니다. 이번 해석은 ${op.iterations}번 반복 만에 수렴했습니다. 손 계산에서는 "도통하면 $V_F \\approx 0.7\\,\\text{V}$인 전압원"으로 근사해 풀 수 있습니다.` });
  }
  if (op.matrix) {
    const { A, b, unknowns } = op.matrix;
    const mat = `\\begin{pmatrix}${A.map(r => r.map(v => tn(v)).join(' & ')).join(' \\\\ ')}\\end{pmatrix}`;
    const xv = `\\begin{pmatrix}${unknowns.join(' \\\\ ')}\\end{pmatrix}`;
    const bv = `\\begin{pmatrix}${b.map(v => tn(v)).join(' \\\\ ')}\\end{pmatrix}`;
    blocks.push({ kind: 'subhead', text: '⑤ 행렬 형태 $\\mathbf{A}\\mathbf{x} = \\mathbf{b}$' });
    blocks.push({ kind: 'p', text: '위 식들을 숫자를 넣어 행렬로 정리하면 다음과 같습니다. 왼쪽 위 블록은 컨덕턴스(1/R), 나머지는 전원 제약을 나타냅니다.' });
    blocks.push({ kind: 'math', tex: `${mat}${xv} = ${bv}` });
  }
  return { id: 'equations', title: '3. 회로 방정식 세우기', blocks };
}

// ------------------------------------------------------------------ 4. 결과
function resultSection(net: Netlist, op: OpResult): Section {
  const blocks: Block[] = [];
  blocks.push({ kind: 'p', text: '연립방정식을 풀어 얻은 노드 전압입니다.' });
  blocks.push({
    kind: 'math',
    tex: net.nodeNames.slice(1).map((nm, i) => `${nv(nm, i + 1)} = ${q(op.v[i + 1], 'V')}`).join(',\\quad ') || '\\text{(노드 없음)}',
  });
  blocks.push({ kind: 'subhead', text: '소자별 전류와 전력' });
  blocks.push({ kind: 'p', text: '노드 전압을 알면 각 소자의 전류는 소자 식(옴의 법칙 등)에 대입해 바로 구할 수 있습니다.' });
  const nn = (k: number) => nv(net.nodeNames[k], k);
  net.elements.forEach((e, i) => {
    const r = op.elements[i];
    const vA = op.v[e.nodes[0]], vB = op.v[e.nodes[1]] ?? 0;
    const I = r.pinCurrents[0];
    switch (e.type) {
      case 'R': {
        const R = num(e.props, 'resistance');
        blocks.push({ kind: 'math', tex: `I_{${e.name}} = \\frac{${nn(e.nodes[0])} - ${nn(e.nodes[1])}}{${sym(e.name)}} = \\frac{${q(vA, 'V')} - ${q(vB, 'V')}}{${q(R, 'Ω')}} = ${q(I, 'A')},\\quad P = I^2R = ${q(I * I * R, 'W')}` });
        break;
      }
      case 'V': case 'VAC': case 'VPULSE':
        blocks.push({ kind: 'math', tex: `I_{${e.name}} = ${q(-I, 'A')}\\;(+\\text{단자에서 나감}),\\quad P_{공급} = ${q(-r.power, 'W')}` });
        break;
      case 'I':
        blocks.push({ kind: 'math', tex: `${sym(e.name)} = ${q(I, 'A')},\\quad V = ${q(op.v[e.nodes[1]] - op.v[e.nodes[0]], 'V')},\\quad P_{공급} = ${q(-r.power, 'W')}` });
        break;
      case 'D': case 'LED': case 'ZD':
        blocks.push({ kind: 'math', tex: `V_{${e.name}} = ${q(vA - vB, 'V')},\\quad I_{${e.name}} = ${q(I, 'A')}\\;(\\text{${stateKo(r.state)}}),\\quad P = ${q(r.power, 'W')}` });
        break;
      case 'C':
        blocks.push({ kind: 'math', tex: `V_{${e.name}} = ${q(vA - vB, 'V')},\\quad I_{${e.name}} = 0\\;(\\text{직류에서 개방}),\\quad W = \\tfrac12 CV^2 = ${q(0.5 * num(e.props, 'capacitance') * (vA - vB) ** 2, 'J')}` });
        break;
      case 'L':
        blocks.push({ kind: 'math', tex: `I_{${e.name}} = ${q(I, 'A')},\\quad V = 0\\;(\\text{직류에서 단락}),\\quad W = \\tfrac12 LI^2 = ${q(0.5 * num(e.props, 'inductance') * I * I, 'J')}` });
        break;
      case 'NPN': case 'PNP': {
        const [ib, ic, ie] = r.pinCurrents;
        blocks.push({ kind: 'math', tex: `${e.name}:\\; I_B = ${q(ib, 'A')},\\; I_C = ${q(ic, 'A')},\\; I_E = ${q(-ie, 'A')},\\; V_{CE} = ${q(op.v[e.nodes[1]] - op.v[e.nodes[2]], 'V')}\\;(\\text{${stateKo(r.state)}})` });
        break;
      }
      case 'NMOS': case 'PMOS': case 'NJF': case 'PJF': {
        const [ig, id] = r.pinCurrents;
        const [vg, vd, vs] = e.nodes.map(nd => op.v[nd]);
        blocks.push({ kind: 'math', tex: `${e.name}:\\; V_{GS} = ${q(vg - vs, 'V')},\\; V_{DS} = ${q(vd - vs, 'V')},\\; I_D = ${q(id, 'A')}${e.type === 'NJF' || e.type === 'PJF' ? `,\\; I_G = ${q(ig, 'A')}` : ''}\\;(\\text{${stateKo(r.state)}})` });
        break;
      }
      case 'OPAMP':
        blocks.push({ kind: 'math', tex: `${e.name}:\\; V_+ - V_- = ${q(op.v[e.nodes[1]] - op.v[e.nodes[0]], 'V')},\\; V_{out} = ${q(op.v[e.nodes[2]], 'V')},\\; I_{out} = ${q(-r.pinCurrents[2], 'A')}\\;(\\text{${stateKo(r.state)}})` });
        break;
      case 'AM':
        blocks.push({ kind: 'math', tex: `\\text{전류계 } ${e.name} = ${q(I, 'A')}` });
        break;
      case 'VM':
        blocks.push({ kind: 'math', tex: `\\text{전압계 } ${e.name} = ${q(vA - vB, 'V')}` });
        break;
      case 'SW':
        blocks.push({ kind: 'math', tex: `${e.name}\\;(\\text{${e.props.closed ? '닫힘' : '열림'}}):\\; I = ${q(e.props.closed ? I : 0, 'A')}` });
        break;
    }
  });
  // 전력 평형
  const supplied = op.elements.filter(r => r.power < 0).reduce((s, r) => s - r.power, 0);
  const absorbed = op.elements.filter(r => r.power > 0).reduce((s, r) => s + r.power, 0);
  if (supplied > 1e-15 || absorbed > 1e-15) {
    blocks.push({ kind: 'subhead', text: '검산: 에너지 보존 (전력 평형)' });
    blocks.push({ kind: 'math', tex: `\\sum P_{공급} = ${q(supplied, 'W')} \\;\\approx\\; \\sum P_{소비} = ${q(absorbed, 'W')}` });
    blocks.push({ kind: 'p', text: '전원이 내보낸 전력과 소자들이 소비한 전력이 같으므로 계산이 옳다는 것을 확인할 수 있습니다(텔레겐 정리).' });
  }
  return { id: 'results', title: '4. 풀이 결과 (직류 동작점)', blocks };
}

// ------------------------------------------------------------------ 5. 전류 흐름 순서
function flowSection(net: Netlist, op: OpResult): Section {
  const g = new Graph(net);
  const blocks: Block[] = [];
  const TH = 1e-9;
  const els = net.elements;
  const pc = (e: SimElement) => op.elements[els.indexOf(e)].pinCurrents;
  blocks.push({ kind: 'p', text: '전류는 전원의 (+) 단자에서 나와 전위가 높은 곳에서 낮은 곳으로 소자를 지나며 에너지를 내주고, 다시 전원의 (−) 단자로 돌아옵니다. 각 소자를 지날 때의 **전압 강하의 합은 전원 전압과 같습니다(KVL)**.' });

  const sources = els.filter(e => (isVSource(e) || e.type === 'I') && op.elements[els.indexOf(e)].power < -1e-12);
  for (const src of sources) {
    const cur = pc(src);
    // 전류가 소자 밖으로 나가는 핀 = pinCurrent 음수
    const outPin = cur[0] < 0 ? 0 : 1;
    const start = src.nodes[outPin], end = src.nodes[1 - outPin];
    const steps: Extract<Block, { kind: 'flow' }>['steps'] = [];
    steps.push({ kind: 'element', label: `${src.name} ${src.type === 'I' ? '' : outPin === 0 ? '(+)' : '(−)'}`, detail: `${f(Math.abs(cur[0]), 'A')} 출발`, elementId: src.id });
    const visited = new Set<string>([src.id]);
    let node = start;
    const drops: string[] = [];
    for (let guard = 0; guard < 40; guard++) {
      steps.push({ kind: 'node', label: g.name(node), detail: f(op.v[node], 'V'), node });
      if (node === end) break;
      // 이 노드에서 소자로 들어가는 전류가 가장 큰 소자
      let best: { e: SimElement; pin: number; i: number } | undefined;
      for (const { e, pin } of g.incident[node]) {
        if (visited.has(e.id)) continue;
        const i = pc(e)[pin];
        if (i > TH && (!best || i > best.i)) best = { e, pin, i };
      }
      if (!best) break;
      visited.add(best.e.id);
      const pcs = pc(best.e);
      let outIdx = -1, most = 0;
      pcs.forEach((v, j) => { if (j !== best!.pin && v < most) { most = v; outIdx = j; } });
      if (outIdx < 0) break;
      const next = best.e.nodes[outIdx];
      const drop = op.v[node] - op.v[next];
      drops.push(`${q(drop, 'V')}`);
      steps.push({ kind: 'element', label: best.e.name, detail: `${f(best.i, 'A')}, ${drop >= 0 ? '강하' : '상승'} ${f(Math.abs(drop), 'V')}`, elementId: best.e.id });
      node = next;
    }
    blocks.push({ kind: 'subhead', text: `${src.name}에서 시작하는 주 전류 경로` });
    blocks.push({ kind: 'flow', steps });
    if (node === end && drops.length) {
      const vs = Math.abs(op.v[start] - op.v[end]);
      blocks.push({ kind: 'math', tex: `\\text{KVL: } ${drops.join(' + ').replace(/\+ -/g, '- ')} = ${q(vs, 'V')} \\;(= ${src.name}\\text{ 단자 전압})` });
    }
  }
  // 노드별 전류 분기 (전위 높은 순)
  const order = [...Array(net.nodeCount).keys()].filter(k => k !== 0).sort((x, y) => op.v[y] - op.v[x]);
  const rows: string[][] = [];
  for (const k of order) {
    const into: string[] = [], outOf: string[] = [];
    for (const { e, pin } of g.incident[k]) {
      const i = pc(e)[pin];
      if (i > TH) outOf.push(`${e.name} ${f(i, 'A')}`);
      else if (i < -TH) into.push(`${e.name} ${f(-i, 'A')}`);
    }
    if (into.length + outOf.length === 0) continue;
    rows.push([`${g.name(k)} (${f(op.v[k], 'V')})`, into.join(', ') || '—', outOf.join(', ') || '—']);
  }
  if (rows.length) {
    blocks.push({ kind: 'subhead', text: '노드별 전류의 갈라짐과 합쳐짐 (KCL 확인)' });
    blocks.push({ kind: 'p', text: '전위가 높은 노드부터 나열했습니다. 각 노드에서 들어오는 전류의 합과 나가는 전류의 합이 같습니다.' });
    blocks.push({ kind: 'table', head: ['노드 (전압)', '들어오는 전류 (출처)', '나가는 전류 (행선지)'], rows });
  }
  return { id: 'flow', title: '5. 전류의 흐름과 순서', blocks };
}

// ------------------------------------------------------------------ 6. 시간 응답
function timeSection(a: Analysis, patterns: Pattern[], outputNode?: number): Section | undefined {
  const tr = a.tran;
  if (!tr) return undefined;
  const net = a.net;
  const blocks: Block[] = [];
  if (!tr.ok) {
    blocks.push({ kind: 'note', tone: 'warn', text: tr.error ?? '과도 해석 실패' });
    return { id: 'time', title: '6. 시간에 따른 동작 (과도 응답)', blocks };
  }
  const F0 = tr.frames[0], FL = tr.frames[tr.frames.length - 1];
  blocks.push({
    kind: 'p',
    text: `과도 해석은 ${tr.initial === 'zero' ? '**전원을 켜는 순간(t = 0)**, 모든 커패시터가 방전되고 인덕터 전류가 0인 상태' : '직류 동작점 상태'}에서 시작해 $${q(tr.tStop, 's')}$까지 $\\Delta t = ${q(tr.dt, 's')}$ 간격으로 회로 방정식을 반복해 풉니다. 커패시터·인덕터는 매 시간 간격마다 "저항 + 전원" 등가 모델(사다리꼴 적분)로 바뀝니다.`,
  });
  blocks.push({ kind: 'math', tex: `i_C = C\\frac{dv_C}{dt} \\;\\approx\\; \\frac{2C}{\\Delta t}\\left(v_{n} - v_{n-1}\\right) - i_{n-1}` });

  // 단계 1: t=0+
  blocks.push({ kind: 'subhead', text: '① t = 0⁺ (스위치를 켠 직후)' });
  const items: string[] = [];
  net.elements.forEach((e, i) => {
    if (e.type === 'C') items.push(`**${e.name}**: 전압 $${q(F0.v[e.nodes[0]] - F0.v[e.nodes[1]], 'V')}$ (순간적으로 변할 수 없어 초기값 유지) → 전류 $${q(F0.ip[i][0], 'A')}$`);
    if (e.type === 'L') items.push(`**${e.name}**: 전류 $${q(F0.ip[i][0], 'A')}$ (순간적으로 변할 수 없음) → 전압 $${q(F0.v[e.nodes[0]] - F0.v[e.nodes[1]], 'V')}$`);
  });
  if (items.length) blocks.push({ kind: 'list', items });
  if (outputNode) blocks.push({ kind: 'p', text: `출력 노드 ${net.nodeNames[outputNode]}의 전압은 $${q(F0.v[outputNode], 'V')}$에서 시작합니다.` });

  // 단계 2: 변화 과정
  const taus = patterns.filter(p => p.tau).map(p => ({ p, tau: p.tau! }));
  blocks.push({ kind: 'subhead', text: '② 변화 과정' });
  if (taus.length) {
    for (const { p, tau } of taus) {
      blocks.push({ kind: 'p', text: `${p.title.split(' — ')[0]}: 시정수 $\\tau = ${q(tau, 's')}$. 변화량이 τ마다 $e^{-1}\\approx 36.8\\%$씩 줄어듭니다.` });
    }
    const t1 = taus[0].tau;
    if (outputNode && t1 < tr.tStop) {
      const at = (t: number) => tr.frames.reduce((x, fr) => (Math.abs(fr.t - t) < Math.abs(x.t - t) ? fr : x));
      blocks.push({
        kind: 'table', head: ['시각', `${net.nodeNames[outputNode]} 전압`, '최종값 대비'],
        rows: [0, 1, 2, 3, 5].filter(m => m * t1 <= tr.tStop).map(m => {
          const v = at(m * t1).v[outputNode];
          const v0 = F0.v[outputNode], vf = FL.v[outputNode];
          const pct = Math.abs(vf - v0) > 1e-12 ? ((v - v0) / (vf - v0)) * 100 : 100;
          return [m === 0 ? '0' : `${m}τ = ${f(m * t1, 's')}`, f(v, 'V'), `${pct.toFixed(1)} %`];
        }),
      });
    }
  }
  const rl = patterns.find(p => p.kind === 'rlc');
  if (rl?.f0) blocks.push({ kind: 'p', text: `LC 공진 주파수 ${f(rl.f0, 'Hz')}(주기 ${f(1 / rl.f0, 's')})로 에너지가 커패시터와 인덕터 사이를 오갑니다.` });

  if (tr.events.length) {
    blocks.push({ kind: 'subhead', text: '③ 시간 순서대로 일어난 사건' });
    const ev = tr.events.slice(0, 24);
    blocks.push({ kind: 'table', head: ['시각', '사건'], rows: ev.map(e => [f(e.t, 's'), e.text]) });
    if (tr.events.length > ev.length) blocks.push({ kind: 'p', text: `… 외 ${tr.events.length - ev.length}건 (주기적으로 반복)` });
  }

  // 단계 4: 최종 상태
  blocks.push({ kind: 'subhead', text: `${tr.events.length ? '④' : '③'} 해석 종료 시점 (t = ${f(tr.tStop, 's')})` });
  const periodic = net.elements.some(e => e.type === 'VAC' || e.type === 'VPULSE');
  if (periodic) {
    const tail = tr.frames.filter(fr => fr.t >= tr.tStop * 0.6);
    const rows: string[][] = [];
    for (let k = 1; k < net.nodeCount; k++) {
      const vs = tail.map(fr => fr.v[k]);
      const mx = Math.max(...vs), mn = Math.min(...vs), avg = vs.reduce((s, v) => s + v, 0) / vs.length;
      rows.push([net.nodeNames[k], f(mn, 'V'), f(mx, 'V'), f(avg, 'V'), f(mx - mn, 'V')]);
    }
    blocks.push({ kind: 'p', text: '주기적인 전원이 있으므로 마지막 40 % 구간의 최소·최대·평균값으로 정상 상태를 요약합니다.' });
    blocks.push({ kind: 'table', head: ['노드', '최소', '최대', '평균(직류 성분)', '피크-피크'], rows });
  } else {
    const items2: string[] = [];
    for (let k = 1; k < net.nodeCount; k++) items2.push(`${net.nodeNames[k]}: ${f(FL.v[k], 'V')} (직류 해석값 ${f(a.op.v[k], 'V')})`);
    blocks.push({ kind: 'list', items: items2 });
    blocks.push({ kind: 'p', text: '충분한 시간이 지나면 커패시터는 개방, 인덕터는 단락이 되어 직류 동작점(4단계)의 값과 같아집니다.' });
  }
  const energy: string[] = [];
  net.elements.forEach((e, i) => {
    if (e.type === 'C') { const v = FL.v[e.nodes[0]] - FL.v[e.nodes[1]]; energy.push(`${e.name}: $\\tfrac12 CV^2 = ${q(0.5 * num(e.props, 'capacitance') * v * v, 'J')}$`); }
    if (e.type === 'L') { const I = FL.ip[i][0]; energy.push(`${e.name}: $\\tfrac12 LI^2 = ${q(0.5 * num(e.props, 'inductance') * I * I, 'J')}$`); }
  });
  if (energy.length) blocks.push({ kind: 'p', text: `저장된 에너지 — ${energy.join(', ')}` });
  return { id: 'time', title: '6. 시간에 따른 동작 (과도 응답)', blocks };
}

// ------------------------------------------------------------------ 7. 주파수 응답
function freqSection(a: Analysis, outputNode?: number): Section | undefined {
  const ac = a.ac;
  if (!ac || !ac.ok) return undefined;
  const net = a.net;
  const input = net.elements.find(e => e.id === ac.inputId)!;
  const out = outputNode ?? net.nodeCount - 1;
  const mags = ac.v.map(row => cabs(row[out]));
  const db = mags.map(m => 20 * Math.log10(Math.max(m, 1e-15)));
  const maxDb = Math.max(...db), iMax = db.indexOf(maxDb);
  const lowDb = db[0], highDb = db[db.length - 1];
  const crossings: number[] = [];
  for (let i = 1; i < db.length; i++) {
    const th = maxDb - 3.0103;
    if ((db[i - 1] - th) * (db[i] - th) < 0) {
      const t = (th - db[i - 1]) / (db[i] - db[i - 1]);
      crossings.push(Math.exp(Math.log(ac.freqs[i - 1]) + t * (Math.log(ac.freqs[i]) - Math.log(ac.freqs[i - 1]))));
    }
  }
  let shape = '평탄(주파수에 무관)';
  if (lowDb > highDb + 6 && maxDb - lowDb < 1) shape = '저역통과';
  else if (highDb > lowDb + 6 && maxDb - highDb < 1) shape = '고역통과';
  else if (maxDb > lowDb + 3 && maxDb > highDb + 3) shape = '대역통과(공진 피크)';
  else if (Math.min(...db) < Math.min(lowDb, highDb) - 6) shape = '대역저지';
  const blocks: Block[] = [];
  blocks.push({
    kind: 'p',
    text: `${input.name}를 크기 1, 위상 0°인 사인파 입력으로 두고 주파수를 ${f(ac.freqs[0], 'Hz')}부터 ${f(ac.freqs[ac.freqs.length - 1], 'Hz')}까지 바꾸며 출력 노드 **${net.nodeNames[out]}**의 크기와 위상을 계산했습니다(소신호 AC 해석). 커패시터는 임피던스 $Z_C = 1/(j\\omega C)$, 인덕터는 $Z_L = j\\omega L$로 바뀝니다.`,
  });
  blocks.push({ kind: 'math', tex: `H(j\\omega) = \\frac{V_{${net.nodeNames[out]}}(j\\omega)}{V_{${input.name}}(j\\omega)}` });
  blocks.push({ kind: 'p', text: `응답 형태: **${shape}**. 최대 이득 ${fx(maxDb, 1)} dB (${f(ac.freqs[iMax], 'Hz')}), 저주파 ${fx(lowDb, 1)} dB, 고주파 ${fx(highDb, 1)} dB.` });
  if (crossings.length) {
    blocks.push({ kind: 'p', text: `−3 dB 주파수(출력이 최대의 $1/\\sqrt2 \\approx 70.7\\%$가 되는 지점): ${crossings.map(c => f(c, 'Hz')).join(', ')}` });
  }
  const ph0 = carg(ac.v[0][out]) * 180 / Math.PI, ph1 = carg(ac.v[ac.v.length - 1][out]) * 180 / Math.PI;
  blocks.push({ kind: 'p', text: `위상은 저주파에서 ${fx(ph0, 0)}°, 고주파에서 ${fx(ph1, 0)}°입니다.` });
  return { id: 'freq', title: '7. 주파수 응답 (AC 해석)', blocks };
}

// ------------------------------------------------------------------ 소자별 역할
function elementRoles(net: Netlist, op: OpResult, patterns: Pattern[]): ElementRole[] {
  const g = new Graph(net);
  return net.elements.map((e, i) => {
    const r = op.elements[i];
    const roles: { title: string; text: string }[] = [];
    for (const p of patterns) if (p.roles[e.id]) roles.push(p.roles[e.id]);
    if (!roles.length) roles.push(defaultRole(e, g, op, r.pinCurrents));
    const v = e.nodes.map(nd => op.v[nd]);
    const values: { label: string; value: string }[] = [];
    if (e.nodes.length === 2) {
      values.push({ label: '양단 전압', value: f(v[0] - v[1], 'V') });
      values.push({ label: '전류', value: f(r.pinCurrents[0], 'A') });
    } else {
      COMPONENTS[e.type].pins.forEach((p, j) => values.push({ label: `${p.name} 전압 / 전류`, value: `${f(v[j], 'V')} / ${f(r.pinCurrents[j], 'A')}` }));
    }
    values.push({ label: r.power < 0 ? '공급 전력' : '소비 전력', value: f(Math.abs(r.power), 'W') });
    return { id: e.id, name: e.name, typeLabel: COMPONENTS[e.type].label, roles, values, state: r.state ? stateKo(r.state) : undefined };
  });
}

function defaultRole(e: SimElement, g: Graph, op: OpResult, pc: number[]): { title: string; text: string } {
  const [a, b] = e.nodes;
  switch (e.type) {
    case 'V': case 'VAC': case 'VPULSE': case 'I':
      return pc[0] < 0 || (e.type === 'I' && op.v[e.nodes[1]] >= op.v[e.nodes[0]])
        ? { title: '에너지 공급원', text: '회로에 전력을 공급합니다.' }
        : { title: '에너지를 받는 쪽', text: '전류가 (+) 단자로 들어가고 있어 전력을 흡수(충전)합니다.' };
    case 'R': {
      if (a === 0 || b === 0) return { title: '부하/풀다운 저항', text: '노드와 접지 사이에서 전류를 흘려 전력을 소비하거나 노드 전위를 정합니다.' };
      return { title: '직렬 저항', text: '전압 강하를 일으키고 전류를 제한합니다.' };
    }
    case 'C':
      return a === 0 || b === 0
        ? { title: '바이패스/필터 커패시터', text: '노드 전압의 빠른 변화를 접지로 흘려보내 전압을 안정시킵니다.' }
        : { title: '결합 커패시터', text: '직류는 막고 교류(변화하는 신호)만 전달합니다.' };
    case 'L': return { title: '인덕터', text: '전류의 급격한 변화를 억제하고 에너지를 자기장에 저장합니다.' };
    case 'D': case 'LED': case 'ZD':
      return { title: e.type === 'LED' ? '발광 다이오드' : '다이오드', text: '한쪽 방향(애노드→캐소드)으로만 전류를 흘립니다.' };
    case 'SW': return { title: '스위치', text: e.props.closed ? '닫혀서 전류 경로를 연결합니다.' : '열려서 전류 경로를 끊습니다.' };
    case 'AM': return { title: '전류계', text: '직렬로 끼워 전류를 측정합니다(내부 저항 0).' };
    case 'VM': return { title: '전압계', text: '병렬로 연결해 두 점의 전압차를 측정합니다(내부 저항 ∞).' };
    case 'NPN': case 'PNP': return { title: '트랜지스터', text: '베이스 전류로 컬렉터 전류를 제어합니다.' };
    case 'NMOS': case 'PMOS': return { title: 'MOSFET', text: '게이트 전압으로 드레인 전류를 제어합니다(게이트 전류 0).' };
    case 'NJF': case 'PJF': return { title: 'JFET', text: '역바이어스된 게이트 전압으로 채널 폭을 바꿔 드레인 전류를 제어합니다.' };
    case 'OPAMP': return { title: '연산증폭기', text: '두 입력 전압의 차를 크게 증폭합니다.' };
    default: return { title: COMPONENTS[e.type].label, text: '' };
  }
}
