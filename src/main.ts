import 'katex/dist/katex.min.css';
import './styles.css';

import { COMPONENTS, formatSI, num, parseSI, valueLabel, type Component, type CompType, type PropSchema, isFet, isTransistor } from './engine/components';
import { buildNetlist, type Netlist } from './engine/netlist';
import { runAll, stateKo, suggestTStop, type Analysis, type SimOptions } from './engine/simulator';
import { cabs, carg } from './engine/linalg';
import { explain, type Report } from './analysis/explain';
import { CircuitEditor, type Overlay } from './editor/editor';
import { Store } from './editor/store';
import { symbolBody } from './editor/symbols';
import { EXAMPLES } from './examples';
import { ImportDialog, type ImportResult } from './ui/importDialog';
import { escapeHtml, inline, markdown, renderRole, renderSection } from './ui/render';
import { PALETTE, plotBode, plotTime, type Trace } from './ui/plot';
import { toSpice } from './importer/spice';

// ------------------------------------------------------------------ 화면 골격
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="topbar">
  <div class="brand"><span class="logo">⚡</span><span>회로 튜터</span></div>
  <input class="title-input" aria-label="회로 이름" />
  <div class="menu-wrap">
    <button class="btn ghost" data-menu="file">파일 ▾</button>
    <div class="menu hidden" data-menu-list="file">
      <button data-act="new">새 회로</button>
      <button data-act="open">회로 파일 열기 (.json)</button>
      <button data-act="save">회로 파일 저장 (.json)</button>
      <hr/>
      <button data-act="export-spice">SPICE 넷리스트로 내보내기</button>
      <button data-act="export-svg">회로도 그림(SVG) 저장</button>
    </div>
  </div>
  <div class="menu-wrap">
    <button class="btn ghost" data-menu="examples">예제 ▾</button>
    <div class="menu wide hidden" data-menu-list="examples">
      ${EXAMPLES.map(e => `<button data-example="${e.id}"><b>${escapeHtml(e.title)}</b> <span class="lvl lvl-${e.level}">${e.level}</span><small>${escapeHtml(e.summary)}</small></button>`).join('')}
    </div>
  </div>
  <button class="btn accent" data-act="import">📷 이미지·PDF에서 가져오기</button>
  <span class="spacer"></span>
  <button class="icon-btn" data-act="undo" title="실행 취소 (Ctrl+Z)">↶</button>
  <button class="icon-btn" data-act="redo" title="다시 실행 (Ctrl+Y)">↷</button>
  <label class="toggle" title="회로를 바꿀 때마다 자동으로 다시 해석"><input type="checkbox" class="auto-run" checked> 자동 해석</label>
  <button class="btn primary" data-act="run">▶ 해석</button>
</header>
<main class="layout">
  <aside class="left">
    <div class="tools">
      <button class="tool active" data-tool="select" title="선택·이동 (Esc)">↖ 선택</button>
      <button class="tool" data-tool="wire" title="배선 (W) — 클릭으로 꺾고, 핀이나 배선에 닿으면 끝. Space: 꺾는 방향 전환">╱ 배선</button>
    </div>
    <div class="palette"></div>
    <details class="help"><summary>조작법</summary>
      <ul>
        <li>부품을 고른 뒤 캔버스를 클릭해 배치 (연속 배치, <kbd>Esc</kbd>/우클릭으로 종료)</li>
        <li><kbd>R</kbd> 회전 · <kbd>F</kbd> 뒤집기 · <kbd>Del</kbd> 삭제 · <kbd>Ctrl</kbd>+<kbd>D</kbd> 복제</li>
        <li>핀에서 드래그를 시작하면 배선 모드, 핀·배선에 닿으면 연결</li>
        <li>빈 곳 드래그: 화면 이동 · 휠 또는 두 손가락 벌리기: 확대/축소</li>
        <li>스위치를 더블클릭(두 번 탭)하면 열림/닫힘 전환</li>
        <li>태블릿: 부품을 탭하면 값과 역할이 표시되고, 왼쪽 속성 칸의 회전·삭제 버튼을 쓰면 됩니다</li>
        <li>부품 단축키: <kbd>1</kbd> 저항 <kbd>2</kbd> 커패시터 <kbd>3</kbd> 인덕터 <kbd>4</kbd> 전압원 <kbd>5</kbd> 전류원 <kbd>6</kbd> 다이오드 <kbd>7</kbd> NPN <kbd>8</kbd> 연산증폭기 <kbd>9</kbd> 스위치 <kbd>0</kbd> 접지, <kbd>W</kbd> 배선</li>
      </ul>
    </details>
  </aside>
  <section class="center">
    <div class="banner hidden"></div>
    <div class="canvas-host"></div>
    <div class="ref-image hidden"><div class="ref-head"><b>원본 그림</b><input type="range" min="20" max="100" value="100" class="ref-opacity" title="투명도"><button class="icon-btn ref-close">✕</button></div><img alt="원본 회로도"/></div>
    <div class="props"></div>
    <div class="canvas-tools">
      <button class="icon-btn" data-act="zoom-in" title="확대">＋</button>
      <button class="icon-btn" data-act="zoom-out" title="축소">－</button>
      <button class="icon-btn" data-act="fit" title="전체 보기">⤢</button>
      <button class="icon-btn" data-act="anim" title="전류 흐름 애니메이션 켜기/끄기">≋</button>
      <button class="icon-btn hidden" data-act="ref" title="원본 그림 보기">🖼</button>
    </div>
    <div class="status-line"></div>
    <div class="playbar hidden">
      <div class="seg"><button data-view="op">직류 동작점</button><button data-view="tran" class="active">시간 재생</button></div>
      <button class="icon-btn play" title="재생/일시정지">⏸</button>
      <input type="range" class="time-slider" min="0" max="1000" value="0">
      <span class="time-label">t = 0</span>
      <select class="speed" title="재생 속도"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
    </div>
    <div class="tooltip hidden"></div>
  </section>
  <aside class="right">
    <nav class="tabs">
      <button data-tab="report" class="active">해설</button>
      <button data-tab="roles">소자 역할</button>
      <button data-tab="scope">파형</button>
      <button data-tab="freq">주파수 응답</button>
      <button data-tab="tutor">AI 튜터</button>
    </nav>
    <div class="tab-body" data-tab-body="report"></div>
    <div class="tab-body hidden" data-tab-body="roles"></div>
    <div class="tab-body hidden" data-tab-body="scope">
      <div class="plot-box"><canvas class="scope-canvas"></canvas></div>
      <div class="scope-legend"></div>
      <div class="scope-pick"></div>
    </div>
    <div class="tab-body hidden" data-tab-body="freq">
      <div class="freq-head"></div>
      <div class="plot-box"><canvas class="bode-canvas"></canvas></div>
      <div class="freq-notes"></div>
    </div>
    <div class="tab-body hidden tutor" data-tab-body="tutor">
      <div class="chat"></div>
      <div class="chips"></div>
      <form class="ask"><textarea placeholder="이 회로에 대해 무엇이든 물어보세요 (Enter 전송, Shift+Enter 줄바꿈)" rows="2"></textarea><button class="btn primary">보내기</button></form>
    </div>
  </aside>
</main>
<input type="file" class="open-file" accept=".json,application/json" hidden>`;

const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];

// ------------------------------------------------------------------ 상태
const store = new Store();
const editor = new CircuitEditor($('.canvas-host'), store);
let aiAvailable: boolean | null = null;
let analysis: Analysis | null = null;
let report: Report | null = null;
let simOpts: SimOptions & { tStopText?: string } = {};
let view: 'op' | 'tran' = 'tran';
let frameIdx = 0;
let playing = true;
let playPos = 0; // 0..1
let scopeSel = new Set<string>();
let freqNode: number | undefined;
let currentExample: string | null = null;
let tutorHistory: { role: 'user' | 'assistant'; content: string }[] = [];
let refImage: string | null = null;

// 웹 배포판(GitHub Pages 등)은 서버가 없으므로 AI 기능을 끈다
const STATIC_BUILD = import.meta.env.VITE_STATIC === '1';
if (STATIC_BUILD) aiAvailable = null;
else fetch('api/status').then(r => r.json()).then(s => { aiAvailable = !!s.ai; }).catch(() => { aiAvailable = null; });

const importDialog = new ImportDialog(onImport, () => aiAvailable);

// ------------------------------------------------------------------ 팔레트
function renderPalette() {
  const cats = new Map<string, CompType[]>();
  for (const d of Object.values(COMPONENTS)) cats.set(d.category, [...(cats.get(d.category) ?? []), d.type]);
  $('.palette').innerHTML = [...cats].map(([cat, types]) => `
    <div class="cat"><div class="cat-title">${cat}</div><div class="cat-grid">
      ${types.map(t => {
        const d = COMPONENTS[t];
        const c: Component = { id: 'p', type: t, name: '', x: 0, y: 0, rot: 0, props: d.defaults };
        const vb = ['V', 'VAC', 'VPULSE', 'I'].includes(t) ? '-30 -45 60 90' : t === 'OPAMP' ? '-62 -45 124 90' : t === 'GND' ? '-20 -6 40 30' : t === 'LABEL' ? '-4 -14 62 28' : isTransistor(t) ? '-44 -44 72 88' : '-44 -26 88 52';
        return `<button class="part" data-part="${t}" title="${d.label}${d.shortcut ? ` (단축키 ${d.shortcut})` : ''}"><svg viewBox="${vb}" class="part-icon">${symbolBody(c)}</svg><span>${d.label}</span></button>`;
      }).join('')}
    </div></div>`).join('');
  $$('.part').forEach(b => b.addEventListener('click', () => editor.setTool({ kind: 'place', type: b.dataset.part as CompType })));
  $$('[data-tool]').forEach(b => b.addEventListener('click', () => editor.setTool({ kind: b.dataset.tool as 'select' | 'wire' })));
}
editor.onToolChange = t => {
  $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t.kind));
  $$('.part').forEach(b => b.classList.toggle('active', t.kind === 'place' && b.dataset.part === t.type));
  $('.status-line').textContent = t.kind === 'place' ? `${COMPONENTS[t.type].label} 배치 중 — 클릭(탭)해서 놓기 · R 회전 · F 뒤집기 · Esc 또는 '선택' 버튼으로 종료`
    : t.kind === 'wire' ? '배선 중 — 클릭(탭)해서 꺾기 · 핀/배선에 닿으면 연결 · Space 꺾는 방향 · Esc 또는 \'선택\' 버튼으로 종료' : '';
};

// ------------------------------------------------------------------ 속성 패널
function propInput(c: Component, s: PropSchema): string {
  const v = c.props[s.key];
  if (s.kind === 'boolean') return `<label class="check"><input type="checkbox" data-prop="${s.key}" ${v ? 'checked' : ''}> ${s.label}</label>`;
  if (s.kind === 'select') return `<label class="field"><span>${s.label}</span><select data-prop="${s.key}">${s.options!.map(o => `<option value="${o.value}" ${o.value === v ? 'selected' : ''}>${o.label}</option>`).join('')}</select></label>`;
  const shown = s.kind === 'number' ? (v === '' || v === undefined ? '' : formatSI(num(c.props, s.key), '').replace(' ', '')) : String(v ?? '');
  return `<label class="field"><span>${s.label}${s.unit ? ` <i>[${s.unit}]</i>` : ''}</span><input data-prop="${s.key}" data-kind="${s.kind}" value="${escapeHtml(shown)}" ${s.optional ? 'placeholder="(없음)"' : ''}>${s.hint ? `<small>${s.hint}</small>` : ''}</label>`;
}

function renderProps() {
  const box = $('.props');
  const ids = [...store.selection];
  const comps = ids.map(id => store.comp(id)).filter(Boolean) as Component[];
  if (!ids.length) { box.innerHTML = ''; return; }
  if (comps.length !== 1) {
    box.innerHTML = `<div class="props-card"><div class="props-head"><span class="props-title">${ids.length}개 선택됨</span><button class="icon-btn" data-pa="close" title="선택 해제">✕</button></div><div class="row"><button class="btn small" data-pa="rot">회전</button><button class="btn small danger" data-pa="del">삭제</button></div></div>`;
  } else {
    const c = comps[0];
    const d = COMPONENTS[c.type];
    const role = report?.roles.find(r => r.id === c.id);
    box.innerHTML = `<div class="props-card">
      <div class="props-head"><span class="props-title">${d.label}</span><button class="icon-btn" data-pa="close" title="선택 해제">✕</button></div>
      ${c.type === 'GND' ? '' : `<label class="field"><span>이름</span><input data-name value="${escapeHtml(c.name)}"></label>`}
      ${d.schema.map(s => propInput(c, s)).join('')}
      <div class="row"><button class="btn small" data-pa="rot">↻ 회전</button><button class="btn small" data-pa="flip">⇅ 뒤집기</button><button class="btn small danger" data-pa="del">삭제</button></div>
      ${role ? `<div class="props-role"><b>${inline(role.roles[0].title)}</b><div>${inline(role.roles[0].text)}</div></div>` : ''}
    </div>`;
    box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-prop]').forEach(inp => {
      inp.addEventListener('change', () => {
        const key = inp.dataset.prop!;
        const s = d.schema.find(x => x.key === key)!;
        let val: number | string | boolean;
        if (s.kind === 'boolean') val = (inp as HTMLInputElement).checked;
        else if (s.kind === 'number') {
          const t = inp.value.trim();
          if (t === '' && s.optional) val = '';
          else {
            const p = parseSI(t);
            if (p === null) { inp.classList.add('invalid'); return; }
            val = p;
          }
        } else val = inp.value;
        inp.classList.remove('invalid');
        store.checkpoint();
        c.props[key] = val;
        store.commit();
      });
    });
    const nameInp = box.querySelector<HTMLInputElement>('[data-name]');
    nameInp?.addEventListener('change', () => { store.checkpoint(); c.name = nameInp.value.trim() || c.name; store.commit(); });
  }
  box.querySelectorAll<HTMLButtonElement>('[data-pa]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.pa === 'rot') editor.rotateSelection();
    if (b.dataset.pa === 'flip') editor.flipSelection();
    if (b.dataset.pa === 'del') store.deleteSelection();
    if (b.dataset.pa === 'close') { store.selection.clear(); editor.render(); renderProps(); }
  }));
}

// ------------------------------------------------------------------ 해석
let runTimer: number | undefined;
function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = window.setTimeout(runAnalysis, 250);
}

function runAnalysis() {
  const net = buildNetlist(store.sch);
  if (!net.elements.length) {
    analysis = null; report = null;
    editor.overlay = null; editor.render();
    renderEmpty();
    $('.playbar').classList.add('hidden');
    return;
  }
  const t0 = performance.now();
  const opts: SimOptions = { ...simOpts };
  analysis = runAll(net, opts);
  report = explain(analysis);
  const ms = performance.now() - t0;
  if (report.outputNode !== undefined && (freqNode === undefined || freqNode >= net.nodeCount)) freqNode = report.outputNode;
  if (freqNode !== undefined && freqNode >= net.nodeCount) freqNode = undefined;
  // 기본 파형 선택
  const valid = new Set([...net.nodeNames.map((_, i) => `v:${i}`), ...net.elements.map(e => `i:${e.id}`)]);
  scopeSel = new Set([...scopeSel].filter(k => valid.has(k)));
  if (!scopeSel.size) defaultScope(net, report);
  const hasTran = !!analysis.tran?.ok;
  $('.playbar').classList.toggle('hidden', !hasTran);
  if (!hasTran) view = 'op';
  else if (view === 'op' && !$('.seg [data-view=op]').classList.contains('active')) view = 'tran';
  updateSeg();
  frameIdx = Math.min(frameIdx, (analysis.tran?.frames.length ?? 1) - 1);
  applyOverlay();
  renderReport(ms);
  renderRoles();
  renderScope();
  renderFreq();
  renderProps();
}

function defaultScope(net: Netlist, rep: Report) {
  const src = net.elements.find(e => ['VAC', 'VPULSE', 'V'].includes(e.type));
  if (src && src.nodes[0] !== 0) scopeSel.add(`v:${src.nodes[0]}`);
  if (rep.outputNode !== undefined) scopeSel.add(`v:${rep.outputNode}`);
  const store1 = net.elements.find(e => e.type === 'C' || e.type === 'L' || e.type === 'LED' || e.type === 'D');
  if (store1) scopeSel.add(`i:${store1.id}`);
  if (scopeSel.size < 2) for (let i = 1; i < Math.min(net.nodeCount, 4); i++) scopeSel.add(`v:${i}`);
}

function overlayFrom(v: number[], ip: number[][], states: (string | undefined)[], vmax: number, imax: number): Overlay {
  const net = analysis!.net;
  return {
    net, v, vmax, imax,
    pinCurrents: new Map(net.elements.map((e, i) => [e.id, ip[i]])),
    states: new Map(net.elements.map((e, i) => [e.id, states[i]])),
  };
}

function applyOverlay() {
  if (!analysis) return;
  const { op, tran } = analysis;
  if (view === 'tran' && tran?.ok) {
    let vmax = 0, imax = 0;
    for (const f of tran.frames) { for (const v of f.v) vmax = Math.max(vmax, Math.abs(v)); for (const p of f.ip) for (const i of p) imax = Math.max(imax, Math.abs(i)); }
    const f = tran.frames[frameIdx] ?? tran.frames[0];
    editor.overlay = overlayFrom(f.v, f.ip, f.states, vmax, imax);
    $('.time-label').textContent = `t = ${formatSI(f.t, 's')}`;
    ($('.time-slider') as HTMLInputElement).value = String(Math.round((frameIdx / Math.max(1, tran.frames.length - 1)) * 1000));
  } else if (op.ok) {
    const vmax = Math.max(...op.v.map(Math.abs), 1e-9);
    const imax = Math.max(...op.elements.flatMap(e => e.pinCurrents.map(Math.abs)), 0);
    editor.overlay = overlayFrom(op.v, op.elements.map(e => e.pinCurrents), op.elements.map(e => e.state), vmax, imax);
  } else editor.overlay = null;
  editor.render();
}

function updateSeg() {
  $$('.seg button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('.play').textContent = playing ? '⏸' : '▶';
}

// ------------------------------------------------------------------ 재생
let lastTs = 0;
function playLoop(ts: number) {
  const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000);
  lastTs = ts;
  const tran = analysis?.tran;
  if (playing && view === 'tran' && tran?.ok && tran.frames.length > 1) {
    const speed = parseFloat(($('.speed') as HTMLSelectElement).value);
    playPos += (dt * speed) / 8; // 전체 구간을 8초에 재생 (1×)
    if (playPos > 1) playPos = 0;
    const idx = Math.round(playPos * (tran.frames.length - 1));
    if (idx !== frameIdx) {
      frameIdx = idx;
      applyOverlay();
      if (!$('[data-tab-body=scope]').classList.contains('hidden')) renderScope();
    }
  }
  requestAnimationFrame(playLoop);
}
requestAnimationFrame(playLoop);

$('.play').addEventListener('click', () => { playing = !playing; updateSeg(); });
$('.time-slider').addEventListener('input', e => {
  const tran = analysis?.tran;
  if (!tran?.ok) return;
  playing = false; updateSeg();
  playPos = parseInt((e.target as HTMLInputElement).value) / 1000;
  frameIdx = Math.round(playPos * (tran.frames.length - 1));
  view = 'tran'; updateSeg();
  applyOverlay(); renderScope();
});
$$('.seg button').forEach(b => b.addEventListener('click', () => { view = b.dataset.view as 'op' | 'tran'; updateSeg(); applyOverlay(); }));

// ------------------------------------------------------------------ 오른쪽 패널
function renderEmpty() {
  $('[data-tab-body=report]').innerHTML = `
    <div class="welcome">
      <h2>회로를 만들어 원리를 배워 보세요</h2>
      <p>회로를 그리거나 불러오면, 시뮬레이터가 <b>회로가 어떤 원리와 순서로 동작하는지</b>, <b>각 소자가 어떤 역할을 하는지</b>를 수식과 함께 단계별로 풀어 줍니다.</p>
      <div class="welcome-actions">
        <button class="card-btn" data-welcome="example"><b>📚 예제로 시작</b><span>분압기, RC 충전, 정류기, 증폭기 등</span></button>
        <button class="card-btn" data-welcome="import"><b>📷 교재 그림 가져오기</b><span>회로 사진·PDF를 올리면 자동 인식</span></button>
        <button class="card-btn" data-welcome="draw"><b>✏️ 직접 설계</b><span>왼쪽 부품을 골라 캔버스에 배치</span></button>
      </div>
    </div>`;
  $$('[data-welcome]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.welcome === 'example') loadExample('divider');
    if (b.dataset.welcome === 'import') importDialog.open();
    if (b.dataset.welcome === 'draw') editor.setTool({ kind: 'place', type: 'V' });
  }));
  $('[data-tab-body=roles]').innerHTML = '<p class="muted pad">회로를 해석하면 소자별 역할이 여기에 표시됩니다.</p>';
  renderScope(); renderFreq();
}

function renderReport(ms: number) {
  if (!report || !analysis) return;
  const ex = EXAMPLES.find(e => e.id === currentExample);
  const autoT = suggestTStop(analysis.net);
  const settings = analysis.tran ? `
    <div class="sim-settings">
      <label>해석 시간 <input class="tstop" placeholder="${formatSI(autoT, 's').replace(' ', '')} (자동)" value="${escapeHtml(simOpts.tStopText ?? '')}"></label>
      <label>시작 상태 <select class="initial"><option value="zero" ${simOpts.initial !== 'op' ? 'selected' : ''}>전원을 켜는 순간 (0 V)</option><option value="op" ${simOpts.initial === 'op' ? 'selected' : ''}>직류 정상 상태</option></select></label>
    </div>` : '';
  $('[data-tab-body=report]').innerHTML = `
    ${ex ? `<div class="ex-intro"><b>${escapeHtml(ex.title)}</b> — ${escapeHtml(ex.summary)}</div>` : ''}
    ${settings}
    ${report.sections.map((s, i) => renderSection(s, i < 2 || s.id === 'flow' || s.id === 'time')).join('')}
    <p class="muted small pad">해석 시간 ${ms.toFixed(0)} ms · 노드 ${analysis.net.nodeCount}개 · 미지수 ${analysis.sim.size}개</p>`;
  const tstop = $('.tstop');
  tstop?.addEventListener('change', () => {
    const t = (tstop as HTMLInputElement).value.trim();
    const v = t ? parseSI(t) : null;
    simOpts.tStopText = t;
    simOpts.tStop = v && v > 0 ? v : undefined;
    runAnalysis();
  });
  $('.initial')?.addEventListener('change', e => { simOpts.initial = (e.target as HTMLSelectElement).value as 'zero' | 'op'; runAnalysis(); });
  bindHighlights($('[data-tab-body=report]'));
}

function renderRoles() {
  if (!report) return;
  const body = $('[data-tab-body=roles]');
  body.innerHTML = `<p class="muted small pad">각 소자가 회로에서 맡은 역할과 직류 동작점 값입니다. 카드에 마우스를 올리면 회로도에서 해당 소자가 강조됩니다.</p>${report.roles.map(renderRole).join('')}`;
  bindHighlights(body);
}

function bindHighlights(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-elements]').forEach(el => {
    el.addEventListener('mouseenter', () => { editor.highlight = new Set(el.dataset.elements!.split(',')); editor.render(); });
    el.addEventListener('mouseleave', () => { editor.highlight.clear(); editor.render(); });
  });
}

function traceList(net: Netlist) {
  const out: { key: string; label: string; unit: string }[] = [];
  for (let i = 1; i < net.nodeCount; i++) out.push({ key: `v:${i}`, label: `V(${net.nodeNames[i]})`, unit: 'V' });
  for (const e of net.elements) if (!['VM', 'OPAMP'].includes(e.type) && !isTransistor(e.type)) out.push({ key: `i:${e.id}`, label: `I(${e.name})`, unit: 'A' });
  for (const e of net.elements) if (isTransistor(e.type)) out.push({ key: `i:${e.id}`, label: `${isFet(e.type) ? 'Id' : 'Ic'}(${e.name})`, unit: 'A' });
  return out;
}

function renderScope() {
  const canvas = $('.scope-canvas') as HTMLCanvasElement;
  const pick = $('.scope-pick'), legend = $('.scope-legend');
  if (!analysis) { plotTime(canvas, []); pick.innerHTML = ''; legend.innerHTML = ''; return; }
  const net = analysis.net;
  const tran = analysis.tran;
  const list = traceList(net);
  if (!tran?.ok) {
    legend.innerHTML = '';
    pick.innerHTML = `<p class="muted pad">이 회로에는 시간에 따라 변하는 요소(커패시터, 인덕터, 교류·구형파 전원, 전환 스위치)가 없어 파형이 일정합니다. 직류 결과는 '해설' 탭을 보세요.</p>`;
    plotTime(canvas, []);
    return;
  }
  const ts = tran.frames.map(f => f.t);
  const traces: Trace[] = [];
  let k = 0;
  for (const item of list) {
    if (!scopeSel.has(item.key)) continue;
    const [kind, id] = item.key.split(':');
    let y: number[];
    if (kind === 'v') y = tran.frames.map(f => f.v[+id]);
    else {
      const idx = net.elements.findIndex(e => e.id === id);
      const pin = isTransistor(net.elements[idx].type) ? 1 : 0;
      y = tran.frames.map(f => f.ip[idx][pin]);
    }
    traces.push({ label: item.label, color: PALETTE[k++ % PALETTE.length], x: ts, y, unit: item.unit, axis: kind === 'v' ? 'left' : 'right' });
  }
  if (traces.length && traces.every(t => t.axis === 'right')) traces.forEach(t => (t.axis = 'left'));
  plotTime(canvas, traces, { cursorX: view === 'tran' ? tran.frames[frameIdx]?.t : undefined });
  const f = tran.frames[frameIdx];
  legend.innerHTML = traces.map(t => {
    const i = frameIdx;
    return `<span class="lg"><i style="background:${t.color}${t.axis === 'right' ? ';background:repeating-linear-gradient(90deg,' + t.color + ' 0 5px,transparent 5px 8px)' : ''}"></i>${escapeHtml(t.label)} = <b>${escapeHtml(formatSI(t.y[i], t.unit))}</b></span>`;
  }).join('') + (f ? `<span class="muted small"> @ t = ${formatSI(f.t, 's')} · 실선: 전압(왼쪽 축), 점선: 전류(오른쪽 축)</span>` : '');
  pick.innerHTML = `<div class="pick-title">표시할 신호</div><div class="pick-grid">${list.map(it => `<label class="check"><input type="checkbox" data-trace="${it.key}" ${scopeSel.has(it.key) ? 'checked' : ''}> ${escapeHtml(it.label)}</label>`).join('')}</div>`;
  pick.querySelectorAll<HTMLInputElement>('[data-trace]').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? scopeSel.add(cb.dataset.trace!) : scopeSel.delete(cb.dataset.trace!);
    renderScope();
  }));
}

function renderFreq() {
  const canvas = $('.bode-canvas') as HTMLCanvasElement;
  const head = $('.freq-head'), notes = $('.freq-notes');
  const ac = analysis?.ac;
  if (!analysis || !ac?.ok) {
    head.innerHTML = '';
    notes.innerHTML = `<p class="muted pad">${analysis ? '커패시터·인덕터·교류 전원이 있는 회로에서 주파수에 따른 출력 크기(보드 선도)를 보여 줍니다.' : ''}${ac?.error ? ` (${escapeHtml(ac.error)})` : ''}</p>`;
    const ctx = canvas.getContext('2d'); ctx?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const net = analysis.net;
  const node = freqNode ?? report?.outputNode ?? net.nodeCount - 1;
  const input = net.elements.find(e => e.id === ac.inputId);
  head.innerHTML = `<label class="field inline"><span>출력 노드</span><select class="freq-node">${net.nodeNames.slice(1).map((n, i) => `<option value="${i + 1}" ${i + 1 === node ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></label><span class="muted small">입력: ${escapeHtml(input?.name ?? '')} (크기 1, 0°)</span>`;
  $('.freq-node').addEventListener('change', e => { freqNode = parseInt((e.target as HTMLSelectElement).value); renderFreq(); });
  const mag = ac.v.map(r => 20 * Math.log10(Math.max(cabs(r[node]), 1e-15)));
  let prev = 0;
  const ph = ac.v.map(r => {
    let p = (carg(r[node]) * 180) / Math.PI;
    while (p - prev > 180) p -= 360;
    while (p - prev < -180) p += 360;
    prev = p; return p;
  });
  const max = Math.max(...mag);
  const marks: number[] = [];
  for (let i = 1; i < mag.length; i++) {
    const th = max - 3.0103;
    if ((mag[i - 1] - th) * (mag[i] - th) < 0) {
      const t = (th - mag[i - 1]) / (mag[i] - mag[i - 1]);
      marks.push(Math.exp(Math.log(ac.freqs[i - 1]) + t * (Math.log(ac.freqs[i]) - Math.log(ac.freqs[i - 1]))));
    }
  }
  plotBode(canvas, ac.freqs, mag, ph, PALETTE[0], marks);
  const sec = report?.sections.find(s => s.id === 'freq');
  notes.innerHTML = `<p class="muted small pad">실선: 크기 [dB], 점선: 위상 [°], 빨간 점선: −3 dB 지점</p>${sec ? renderSection(sec, true) : ''}`;
}

// ------------------------------------------------------------------ AI 튜터
function buildContext(): string {
  if (!analysis || !report) return '(회로 없음)';
  const { net, op, tran, ac } = analysis;
  const lines: string[] = [];
  lines.push(`회로 이름: ${store.title}`);
  lines.push('넷리스트 (SPICE 형식, 노드 0 = 접지):');
  lines.push(toSpice(net, store.title));
  if (op.ok) {
    lines.push('\n직류 동작점:');
    lines.push(net.nodeNames.slice(1).map((n, i) => `V(${n}) = ${formatSI(op.v[i + 1], 'V')}`).join(', '));
    net.elements.forEach((e, i) => {
      const r = op.elements[i];
      lines.push(`${e.name} (${COMPONENTS[e.type].label}, ${valueLabel({ ...e, x: 0, y: 0, rot: 0 } as Component)}): 핀 전류 ${r.pinCurrents.map(x => formatSI(x, 'A')).join(' / ')}, 전력 ${formatSI(r.power, 'W')}${r.state ? `, 상태 ${stateKo(r.state)}` : ''}`);
    });
  } else lines.push(`직류 해석 실패: ${op.error}`);
  if (report.patterns.length) {
    lines.push('\n인식된 회로 패턴:');
    for (const p of report.patterns) lines.push(`- ${p.title}${p.tau ? ` (τ=${formatSI(p.tau, 's')})` : ''}${p.f0 ? ` (f0=${formatSI(p.f0, 'Hz')})` : ''}${p.fc ? ` (fc=${formatSI(p.fc, 'Hz')})` : ''}: ${p.formulas.join(' ; ')}`);
    lines.push('소자 역할: ' + report.roles.map(r => `${r.name}=${r.roles.map(x => x.title).join('/')}`).join(', '));
  }
  if (tran?.ok) {
    lines.push(`\n과도 해석: 0 ~ ${formatSI(tran.tStop, 's')}, 시작 상태 ${tran.initial === 'zero' ? '전원 인가 순간(모든 C 방전)' : '직류 정상 상태'}`);
    for (let k = 1; k < net.nodeCount; k++) {
      const vs = tran.frames.map(f => f.v[k]);
      lines.push(`V(${net.nodeNames[k]}): 시작 ${formatSI(vs[0], 'V')}, 끝 ${formatSI(vs[vs.length - 1], 'V')}, 최소 ${formatSI(Math.min(...vs), 'V')}, 최대 ${formatSI(Math.max(...vs), 'V')}`);
    }
    if (tran.events.length) lines.push('사건: ' + tran.events.slice(0, 30).map(e => `${formatSI(e.t, 's')} ${e.text}`).join('; '));
  }
  if (ac?.ok && report.outputNode !== undefined) {
    const sec = report.sections.find(s => s.id === 'freq');
    if (sec) lines.push('\n주파수 응답: ' + sec.blocks.filter(b => b.kind === 'p').map(b => (b as { text: string }).text).join(' '));
  }
  return lines.join('\n');
}

const CHIPS = ['이 회로가 동작하는 순서를 처음부터 차근차근 설명해 줘', '각 소자의 역할을 시험 대비용으로 정리해 줘', '손으로 푸는 과정을 KCL/KVL로 보여 줘', '저항값을 두 배로 바꾸면 무엇이 어떻게 달라질까?'];

function renderTutor() {
  const chat = $('.chat');
  if (!tutorHistory.length) {
    chat.innerHTML = `<div class="chat-empty"><p><b>AI 튜터</b>는 지금 화면의 회로와 시뮬레이션 결과를 보고 질문에 답합니다.</p>${aiAvailable === false ? '<p class="note note-warn">서버에 Claude API 자격 증명이 없어 사용할 수 없습니다. README의 설정 방법을 참고하세요.</p>' : aiAvailable === null ? '<p class="note note-warn">AI 서버에 연결되지 않아 사용할 수 없습니다. 웹 배포판에는 서버가 없으며, 내 컴퓨터에서 <code>npm run dev</code>로 실행하고 API 키를 설정하면 사용할 수 있습니다. 회로 해설·소자 역할 탭은 그대로 이용하세요.</p>' : ''}</div>`;
  } else {
    chat.innerHTML = tutorHistory.map(m => `<div class="msg msg-${m.role}">${m.role === 'user' ? escapeHtml(m.content) : markdown(m.content) || '<span class="spinner"></span>'}</div>`).join('');
  }
  $('.chips').innerHTML = CHIPS.map(c => `<button class="chip">${escapeHtml(c)}</button>`).join('');
  $$('.chip').forEach(b => b.addEventListener('click', () => ask(b.textContent!)));
  chat.scrollTop = chat.scrollHeight;
}

let asking = false;
async function ask(q: string) {
  if (asking || !q.trim()) return;
  if (STATIC_BUILD) { tutorHistory.push({ role: 'user', content: q }, { role: 'assistant', content: '이 웹 배포판에는 AI 서버가 없어 답할 수 없습니다. 해설·소자 역할 탭을 참고하세요.' }); renderTutor(); return; }
  if (!analysis) { tutorHistory.push({ role: 'user', content: q }, { role: 'assistant', content: '먼저 회로를 그리거나 예제를 불러와 주세요.' }); renderTutor(); return; }
  asking = true;
  tutorHistory.push({ role: 'user', content: q }, { role: 'assistant', content: '' });
  renderTutor();
  const msg = tutorHistory[tutorHistory.length - 1];
  try {
    const res = await fetch('api/tutor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: buildContext(), messages: tutorHistory.slice(0, -1).slice(-20) }),
    });
    if (!res.ok || !res.body) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? `서버 오류 (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      msg.content += dec.decode(value, { stream: true });
      if (performance.now() - last > 120) { renderTutor(); last = performance.now(); }
    }
  } catch (e) {
    msg.content += `\n\n⚠️ ${(e as Error).message}`;
  } finally {
    asking = false;
    renderTutor();
  }
}
$('.ask').addEventListener('submit', e => {
  e.preventDefault();
  const ta = $('.ask textarea') as HTMLTextAreaElement;
  const q = ta.value; ta.value = '';
  ask(q);
});
$('.ask textarea').addEventListener('keydown', e => {
  const ke = e as KeyboardEvent;
  if (ke.key === 'Enter' && !ke.shiftKey && !ke.isComposing) { e.preventDefault(); $('.ask').dispatchEvent(new Event('submit')); }
});

// ------------------------------------------------------------------ 탭
$$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
  $$('.right .tabs [data-tab]').forEach(x => x.classList.toggle('active', x === b));
  $$('[data-tab-body]').forEach(x => x.classList.toggle('hidden', x.dataset.tabBody !== b.dataset.tab));
  if (b.dataset.tab === 'scope') renderScope();
  if (b.dataset.tab === 'freq') renderFreq();
  if (b.dataset.tab === 'tutor') renderTutor();
}));
function showTab(t: string) { ($(`.right .tabs [data-tab=${t}]`) as HTMLButtonElement).click(); }

// ------------------------------------------------------------------ 툴팁 · 선택
const tooltip = $('.tooltip');
editor.onHover = (id, ev) => {
  if (!id || !analysis?.op.ok || !report) { tooltip.classList.add('hidden'); return; }
  const role = report.roles.find(r => r.id === id);
  const c = store.comp(id);
  if (!role || !c) { tooltip.classList.add('hidden'); return; }
  let vals = role.values;
  if (view === 'tran' && analysis.tran?.ok && editor.overlay) {
    const idx = analysis.net.elements.findIndex(e => e.id === id);
    const e = analysis.net.elements[idx];
    const f = analysis.tran.frames[frameIdx];
    if (e && f) vals = e.nodes.length === 2
      ? [{ label: '양단 전압', value: formatSI(f.v[e.nodes[0]] - f.v[e.nodes[1]], 'V') }, { label: '전류', value: formatSI(f.ip[idx][0], 'A') }, { label: '시각', value: formatSI(f.t, 's') }]
      : e.nodes.map((n, j) => ({ label: COMPONENTS[e.type].pins[j].name, value: `${formatSI(f.v[n], 'V')} / ${formatSI(f.ip[idx][j], 'A')}` }));
  }
  tooltip.innerHTML = `<b>${escapeHtml(role.name)}</b> <span class="muted">${escapeHtml(role.typeLabel)}</span>${role.state ? ` <span class="badge">${escapeHtml(role.state)}</span>` : ''}
    <div class="tt-role">${inline(role.roles[0].title)}</div>
    <table>${vals.map(v => `<tr><td>${escapeHtml(v.label)}</td><td>${escapeHtml(v.value)}</td></tr>`).join('')}</table>`;
  const r = $('.center').getBoundingClientRect();
  tooltip.style.left = `${Math.min(ev.clientX - r.left + 16, r.width - 260)}px`;
  tooltip.style.top = `${ev.clientY - r.top + 16}px`;
  tooltip.classList.remove('hidden');
};
$('.canvas-host').addEventListener('mouseleave', () => tooltip.classList.add('hidden'));

editor.onSelect = ids => {
  renderProps();
  if (ids.length === 1 && !$('[data-tab-body=roles]').classList.contains('hidden')) {
    const card = document.getElementById(`role-${ids[0]}`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 900);
  }
};
editor.onToggleSwitch = id => {
  const c = store.comp(id);
  if (!c) return;
  store.checkpoint(); c.props.closed = !c.props.closed; store.commit();
};

// ------------------------------------------------------------------ 저장/불러오기/가져오기
function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = () => (store.title || 'circuit').replace(/[\\/:*?"<>|]/g, '_');

function loadExample(id: string) {
  const ex = EXAMPLES.find(e => e.id === id);
  if (!ex) return;
  currentExample = id;
  simOpts = { ...(ex.sim ?? {}), tStopText: ex.sim?.tStop ? formatSI(ex.sim.tStop, 's').replace(' ', '') : undefined };
  hideBanner(); setRefImage(null);
  store.load(ex.build(), ex.title);
  view = 'tran'; playing = true; playPos = 0; frameIdx = 0; scopeSel.clear(); freqNode = undefined; tutorHistory = [];
  requestAnimationFrame(() => editor.fit());
  showTab('report');
}

function onImport(r: ImportResult) {
  currentExample = null;
  simOpts = {};
  store.load(r.sch, r.title);
  view = 'tran'; playing = true; playPos = 0; frameIdx = 0; scopeSel.clear(); freqNode = undefined; tutorHistory = [];
  requestAnimationFrame(() => editor.fit());
  setRefImage(r.sourceImage ?? null);
  const conf = r.confidence ? { high: '높음', medium: '보통', low: '낮음' }[r.confidence] : null;
  showBanner(`<b>${escapeHtml(r.title)}</b>${r.description ? ` — ${escapeHtml(r.description)}` : ''}${conf ? ` · 인식 신뢰도 <b>${conf}</b>` : ''}
    <div class="muted small">자동 인식·배치 결과입니다. 원본과 비교해 값과 연결을 확인하고, 틀린 곳은 직접 고치세요.</div>
    ${r.notes.length ? `<details><summary>참고 사항 ${r.notes.length}건</summary><ul>${r.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details>` : ''}`);
  showTab('report');
}

function showBanner(html: string) {
  const b = $('.banner');
  b.innerHTML = `<div class="banner-body">${html}</div><button class="icon-btn banner-close">✕</button>`;
  b.classList.remove('hidden');
  $('.banner-close').addEventListener('click', hideBanner);
}
function hideBanner() { $('.banner').classList.add('hidden'); }

function setRefImage(url: string | null) {
  refImage = url;
  $('[data-act=ref]').classList.toggle('hidden', !url);
  $('.ref-image').classList.toggle('hidden', !url);
  if (url) ($('.ref-image img') as HTMLImageElement).src = url;
}
$('.ref-close').addEventListener('click', () => $('.ref-image').classList.add('hidden'));
$('.ref-opacity').addEventListener('input', e => { ($('.ref-image') as HTMLElement).style.opacity = String(parseInt((e.target as HTMLInputElement).value) / 100); });

function exportSvg() {
  const svg = editor.svg.cloneNode(true) as SVGSVGElement;
  svg.querySelector('.grid')?.remove();
  svg.querySelector('.anim')?.remove();
  svg.querySelector('.ghost')?.remove();
  const bbox = editor.svg.querySelector('.main') as SVGGElement;
  const b = bbox.getBBox();
  (svg.querySelector('.world') as SVGGElement).setAttribute('transform', '');
  svg.setAttribute('viewBox', `${b.x - 20} ${b.y - 20} ${b.width + 40} ${b.height + 40}`);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const style = `<style>line,path,polyline,circle,rect{fill:none;stroke:#111;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.hit,.wire-hit{stroke:none;fill:none}.solid,.junction{fill:#111}.thick{stroke-width:3}.sign{stroke-width:1.5}.body,.tag{fill:#fff}text{font:12px sans-serif;fill:#111;stroke:none}.comp-value{fill:#555}.sym-letter,.net-text{text-anchor:middle;dominant-baseline:central}.node-tag text{fill:#2563eb;font-size:11px}.open-pin{fill:#fff}.led-glow{display:none}</style>`;
  download(`${safeName()}.svg`, svg.outerHTML.replace('>', `>${style}`), 'image/svg+xml');
}

document.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const menuBtn = t.closest('[data-menu]') as HTMLElement | null;
  $$('[data-menu-list]').forEach(m => { if (!menuBtn || m.dataset.menuList !== menuBtn.dataset.menu) m.classList.add('hidden'); });
  if (menuBtn) { $(`[data-menu-list=${menuBtn.dataset.menu}]`).classList.toggle('hidden'); return; }
  const exBtn = t.closest('[data-example]') as HTMLElement | null;
  if (exBtn) { loadExample(exBtn.dataset.example!); return; }
  const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
  switch (act) {
    case 'new':
      currentExample = null; hideBanner(); setRefImage(null); simOpts = {}; tutorHistory = [];
      store.load({ components: [], wires: [] }, '새 회로'); editor.fit(); break;
    case 'open': ($('.open-file') as HTMLInputElement).click(); break;
    case 'save': download(`${safeName()}.json`, JSON.stringify({ format: 'circuit-tutor', version: 1, title: store.title, schematic: store.sch, sim: simOpts }, null, 2), 'application/json'); break;
    case 'export-spice': if (analysis) download(`${safeName()}.cir`, toSpice(analysis.net, store.title), 'text/plain'); break;
    case 'export-svg': exportSvg(); break;
    case 'import': importDialog.open(); break;
    case 'undo': store.undo(); break;
    case 'redo': store.redo(); break;
    case 'run': runAnalysis(); break;
    case 'zoom-in': editor.zoomBy(1.25); break;
    case 'zoom-out': editor.zoomBy(0.8); break;
    case 'fit': editor.fit(); break;
    case 'anim': editor.animate = !editor.animate; t.closest('button')!.classList.toggle('off', !editor.animate); break;
    case 'ref': if (refImage) $('.ref-image').classList.toggle('hidden'); break;
  }
});

$('.open-file').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    const sch = o.schematic ?? o.sch ?? o;
    if (!Array.isArray(sch.components) || !Array.isArray(sch.wires)) throw new Error('회로 파일 형식이 아닙니다.');
    currentExample = null; hideBanner(); setRefImage(null);
    simOpts = o.sim ?? {}; tutorHistory = [];
    store.load(sch, o.title ?? f.name.replace(/\.json$/, ''));
    requestAnimationFrame(() => editor.fit());
  } catch (err) {
    alert(`파일을 열 수 없습니다: ${(err as Error).message}`);
  }
  (e.target as HTMLInputElement).value = '';
});

const titleInput = $('.title-input') as HTMLInputElement;
titleInput.addEventListener('change', () => { store.title = titleInput.value.trim() || '새 회로'; store.persist(); });

// ------------------------------------------------------------------ 변경 감지
store.on(reason => {
  titleInput.value = store.title;
  editor.render();
  renderProps();
  if (reason === 'select') return;
  if (reason === 'edit') currentExample = currentExample && EXAMPLES.some(e => e.id === currentExample) ? currentExample : null;
  if (($('.auto-run') as HTMLInputElement).checked || reason === 'load') scheduleRun();
  else $('.status-line').textContent = '회로가 바뀌었습니다. ▶ 해석을 눌러 다시 계산하세요.';
});

window.addEventListener('resize', () => { renderScope(); renderFreq(); });

// ------------------------------------------------------------------ 시작
renderPalette();
if (store.restoreAutosave()) {
  titleInput.value = store.title;
  editor.render();
  requestAnimationFrame(() => { editor.fit(); runAnalysis(); });
} else {
  loadExample('divider');
}
