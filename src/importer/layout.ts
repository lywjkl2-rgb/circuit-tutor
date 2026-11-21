// 추상 회로(소자 + 핀별 넷 이름 + 대략적 위치) → 편집 가능한 회로도(배치 + 배선)
// 이미지/PDF 인식 결과와 SPICE 넷리스트 가져오기에서 공통으로 사용한다.

import { COMPONENTS, pinPositions, type Component, type CompType, type Props, type Schematic, type Wire, isTransistor } from '../engine/components';
import { buildNetlist } from '../engine/netlist';
import { newId } from '../editor/store';

export interface AbstractComponent {
  type: CompType;
  name: string;
  props: Props;
  nets: string[];             // COMPONENTS[type].pins 순서
  x?: number; y?: number;     // 0..1 정규화 위치 (원본 그림 기준)
  orientation?: 'horizontal' | 'vertical';
}

export interface AbstractCircuit { components: AbstractComponent[]; groundNets?: string[] }

const GROUND_NAMES = /^(0|gnd|ground|vss|접지)$/i;

const key = (x: number, y: number) => `${x},${y}`;

function onSeg(px: number, py: number, w: { x1: number; y1: number; x2: number; y2: number }) {
  const cross = (w.x2 - w.x1) * (py - w.y1) - (w.y2 - w.y1) * (px - w.x1);
  if (Math.abs(cross) > 1e-9) return false;
  return px >= Math.min(w.x1, w.x2) && px <= Math.max(w.x1, w.x2) && py >= Math.min(w.y1, w.y2) && py <= Math.max(w.y1, w.y2);
}

/** 위치 정보가 없을 때: 넷 연결을 스프링으로 본 힘-기반 배치 */
function autoPositions(ac: AbstractCircuit, isGround: (n?: string) => boolean) {
  const comps = ac.components;
  const n = comps.length;
  if (!n) return;
  // 같은 (접지가 아닌) 넷을 공유하면 스프링으로 연결
  const edges: [number, number, number][] = [];
  const nets = new Map<string, number[]>();
  comps.forEach((c, i) => c.nets.forEach(nt => { if (!isGround(nt)) nets.set(nt, [...new Set([...(nets.get(nt) ?? []), i])]); }));
  for (const [, idx] of nets) for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) edges.push([idx[a], idx[b], 1 / (idx.length - 1)]);
  const isSrc = (c: AbstractComponent) => ['V', 'VAC', 'VPULSE', 'I'].includes(c.type);
  const grounded = comps.map(c => c.nets.some(isGround));
  // 초기 위치: 원형 (결정적)
  const pos = comps.map((c, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: Math.cos(a) * 3 + (isSrc(c) ? -3 : 0), y: Math.sin(a) * 3 + (grounded[i] ? 1 : 0) };
  });
  const k = 2.2;
  for (let it = 0; it < 400; it++) {
    const t = 0.35 * (1 - it / 400) + 0.02;
    const d = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      let dist = Math.hypot(dx, dy);
      if (dist < 1e-3) { dx = 0.01 * (i - j); dy = 0.01; dist = Math.hypot(dx, dy); }
      const f = (k * k) / dist;
      d[i].x += (dx / dist) * f; d[i].y += (dy / dist) * f;
      d[j].x -= (dx / dist) * f; d[j].y -= (dy / dist) * f;
    }
    for (const [a, b, w] of edges) {
      const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      const dist = Math.hypot(dx, dy) || 1e-3;
      const f = (dist * dist / k) * w;
      d[a].x -= (dx / dist) * f; d[a].y -= (dy / dist) * f;
      d[b].x += (dx / dist) * f; d[b].y += (dy / dist) * f;
    }
    comps.forEach((c, i) => {
      if (isSrc(c)) d[i].x -= 1.5;          // 전원은 왼쪽으로
      if (grounded[i]) d[i].y += 0.6;        // 접지 소자는 아래로
      d[i].x -= pos[i].x * 0.25; d[i].y -= pos[i].y * 0.25; // 중심으로 약한 인력 (떨어진 부분 회로가 멀어지지 않게)
      const m = Math.hypot(d[i].x, d[i].y) || 1;
      pos[i].x += (d[i].x / m) * Math.min(m, t * 3);
      pos[i].y += (d[i].y / m) * Math.min(m, t * 3);
    });
  }
  const xs = pos.map(p => p.x), ys = pos.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  comps.forEach((c, i) => {
    c.x = 0.08 + 0.84 * ((pos[i].x - x0) / (x1 - x0 || 1));
    c.y = 0.1 + 0.8 * ((pos[i].y - y0) / (y1 - y0 || 1));
  });
  // 방향: 접지에 닿는 2단자는 세로, 그 밖에는 양쪽 이웃이 놓인 방향을 따름
  comps.forEach((c, i) => {
    if (c.orientation !== undefined || c.nets.length !== 2) return;
    if (grounded[i]) { c.orientation = 'vertical'; return; }
    const cen = c.nets.map(nt => {
      const o = (nets.get(nt) ?? []).filter(j => j !== i);
      return o.length ? { x: o.reduce((s, j) => s + comps[j].x!, 0) / o.length, y: o.reduce((s, j) => s + comps[j].y!, 0) / o.length } : { x: c.x!, y: c.y! };
    });
    c.orientation = Math.abs(cen[0].x - cen[1].x) * 1.33 >= Math.abs(cen[0].y - cen[1].y) ? 'horizontal' : 'vertical';
  });
}

function rotationsFor(type: CompType, orientation?: 'horizontal' | 'vertical'): number[] {
  const nativeVertical = ['V', 'VAC', 'VPULSE', 'I'].includes(type);
  if (type === 'OPAMP' || isTransistor(type)) return [0, 2];
  if (!orientation) return [0, 1, 2, 3];
  const wantVertical = orientation === 'vertical';
  return wantVertical === nativeVertical ? [0, 2] : [1, 3];
}

function bbox(c: Component): [number, number, number, number] {
  const pts = pinPositions(c);
  let x0 = c.x - 1, y0 = c.y - 1, x1 = c.x + 1, y1 = c.y + 1;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  if (c.type === 'OPAMP' || isTransistor(c.type)) { y0 = Math.min(y0, c.y - 2); y1 = Math.max(y1, c.y + 2); }
  return [x0, y0, x1, y1];
}

export function layoutCircuit(ac: AbstractCircuit, opts: { width?: number } = {}): { sch: Schematic; labelNets: string[] } {
  const groundSet = new Set((ac.groundNets ?? []).map(s => s.toLowerCase()));
  const isGround = (n?: string) => !!n && (GROUND_NAMES.test(n.trim()) || groundSet.has(n.trim().toLowerCase()));
  const comps = ac.components.filter(c => c.type !== 'GND' && c.type !== 'LABEL' && COMPONENTS[c.type]);
  if (comps.some(c => c.x === undefined || c.y === undefined)) autoPositions({ components: comps }, isGround);

  // 1) 격자에 배치 (짝수 격자로 스냅해 정렬)
  const W = opts.width ?? Math.max(24, Math.min(60, comps.length * 7));
  const H = W * 0.75;
  const placed: { ac: AbstractComponent; c: Component }[] = comps.map(a => ({
    ac: a,
    c: {
      id: newId(), type: a.type, name: a.name, rot: rotationsFor(a.type, a.orientation)[0], flip: false,
      x: Math.round(((a.x ?? 0.5) * W) / 2) * 2, y: Math.round(((a.y ?? 0.5) * H) / 2) * 2,
      props: { ...COMPONENTS[a.type].defaults, ...a.props },
    },
  }));

  // 2) 회전 선택: 각 핀이 같은 넷의 다른 소자 중심과 가까워지도록
  const centers = (net: string, self: Component) => placed.filter(p => p.c !== self && p.ac.nets.includes(net)).map(p => [p.c.x, p.c.y]);
  for (let pass = 0; pass < 2; pass++) {
    for (const p of placed) {
      let best = p.c.rot, bestFlip = false, bestCost = Infinity;
      for (const rot of rotationsFor(p.ac.type, p.ac.orientation)) for (const flip of p.ac.type === 'OPAMP' || isTransistor(p.ac.type) ? [false, true] : [false]) {
        const pins = pinPositions({ ...p.c, rot, flip });
        let cost = 0;
        pins.forEach((pin, i) => {
          const net = p.ac.nets[i];
          if (!net) return;
          if (isGround(net)) { cost += pin.y < p.c.y ? 6 : pin.y > p.c.y ? -2 : 0; return; } // 접지 단자는 아래쪽 선호
          for (const [cx, cy] of centers(net, p.c)) cost += Math.abs(pin.x - cx) + Math.abs(pin.y - cy);
        });
        if (cost < bestCost - 1e-9) { bestCost = cost; best = rot; bestFlip = flip; }
      }
      p.c.rot = best; p.c.flip = bestFlip;
    }
  }

  // 3) 겹침 해소
  const overlaps = (a: Component, b: Component) => {
    const [ax0, ay0, ax1, ay1] = bbox(a), [bx0, by0, bx1, by1] = bbox(b);
    return ax0 < bx1 + 2 && bx0 < ax1 + 2 && ay0 < by1 + 2 && by0 < ay1 + 2;
  };
  for (let i = 0; i < placed.length; i++) {
    let guard = 0;
    while (placed.slice(0, i).some(o => overlaps(o.c, placed[i].c)) && guard++ < 200) {
      placed[i].c.x += 2;
      if (guard % 6 === 0) { placed[i].c.x -= 12; placed[i].c.y += 2; }
    }
  }

  const components: Component[] = placed.map(p => p.c);
  const wires: Wire[] = [];
  const labelNets: string[] = [];

  // 넷별 핀 좌표
  const netPins = new Map<string, { x: number; y: number }[]>();
  placed.forEach(p => pinPositions(p.c).forEach((pin, i) => {
    const n = p.ac.nets[i];
    if (!n) return;
    netPins.set(n, [...(netPins.get(n) ?? []), { x: pin.x, y: pin.y }]);
  }));

  // 4) 접지: 각 접지 핀에 GND 기호
  for (const [n, pins] of netPins) {
    if (!isGround(n)) continue;
    for (const p of pins) components.push({ id: newId(), type: 'GND', name: 'GND', x: p.x, y: p.y, rot: 0, props: {} });
  }

  // 5) 나머지 넷: 최소 신장 트리 + ㄱ자 배선, 충돌 시 넷 라벨로 대체
  const nets = [...netPins.entries()].filter(([n, pins]) => !isGround(n) && pins.length >= 2)
    .sort((a, b) => spread(a[1]) - spread(b[1]));
  const netOfPoint = new Map<string, string>();
  for (const [n, pins] of netPins) for (const p of pins) netOfPoint.set(key(p.x, p.y), n);
  const netWires = new Map<string, Wire[]>();

  const conflicts = (net: string, seg: { x1: number; y1: number; x2: number; y2: number }) => {
    for (const [k, other] of netOfPoint) {
      if (other === net) continue;
      const [x, y] = k.split(',').map(Number);
      if (onSeg(x, y, seg)) return true;
    }
    for (const [other, ws] of netWires) {
      if (other === net) continue;
      for (const w of ws) {
        if (onSeg(seg.x1, seg.y1, w) || onSeg(seg.x2, seg.y2, w) || onSeg(w.x1, w.y1, seg) || onSeg(w.x2, w.y2, seg)) return true;
      }
    }
    // 소자 몸체 관통 방지
    for (const c of components) {
      if (c.type === 'GND') continue;
      const [x0, y0, x1, y1] = bbox(c);
      const pins = pinPositions(c);
      const ownEnd = pins.some(p => (p.x === seg.x1 && p.y === seg.y1) || (p.x === seg.x2 && p.y === seg.y2));
      if (segThroughBox(seg, x0, y0, x1, y1) && !ownEnd) return true;
      if (ownEnd && segThroughBox(seg, x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5)) return true;
    }
    return false;
  };

  for (const [net, pins] of nets) {
    const edges = mst(pins);
    const ws: Wire[] = [];
    let ok = true;
    for (const [a, b] of edges) {
      const options = a.x === b.x || a.y === b.y
        ? [[a, b]]
        : [[a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b]];
      // Z자 우회 후보
      if (a.x !== b.x && a.y !== b.y) {
        const mx = Math.round((a.x + b.x) / 2), my = Math.round((a.y + b.y) / 2);
        options.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b], [a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
      }
      let chosen: typeof options[number] | null = null;
      for (const path of options) {
        const segs = path.slice(1).map((p, i) => ({ x1: path[i].x, y1: path[i].y, x2: p.x, y2: p.y }));
        if (segs.every(s => !conflicts(net, s))) { chosen = path; break; }
      }
      if (!chosen) { ok = false; break; }
      for (let i = 0; i + 1 < chosen.length; i++) {
        if (chosen[i].x === chosen[i + 1].x && chosen[i].y === chosen[i + 1].y) continue;
        ws.push({ id: newId('w'), x1: chosen[i].x, y1: chosen[i].y, x2: chosen[i + 1].x, y2: chosen[i + 1].y });
      }
      netWires.set(net, ws);
    }
    if (!ok) { netWires.delete(net); labelNets.push(net); }
  }
  for (const ws of netWires.values()) wires.push(...ws);
  for (const net of labelNets) addLabels(components, netPins.get(net)!, net, wires);

  // 6) 검증: 원래 넷 구조와 같은지 확인하고 틀린 넷은 라벨로 대체
  for (let iter = 0; iter < 5; iter++) {
    const bad = verify({ components, wires }, placed, isGround);
    if (!bad.size) break;
    for (const net of bad) {
      if (labelNets.includes(net)) continue;
      const ws = netWires.get(net) ?? [];
      for (const w of ws) { const i = wires.indexOf(w); if (i >= 0) wires.splice(i, 1); }
      netWires.delete(net);
      labelNets.push(net);
      addLabels(components, netPins.get(net) ?? [], net, wires);
    }
  }
  return { sch: { components, wires }, labelNets };
}

function addLabels(components: Component[], pins: { x: number; y: number }[], net: string, wires?: Wire[]) {
  for (const p of pins) {
    // 핀이 소자 중심의 어느 쪽에 있는지 보고 라벨이 바깥을 향하게
    const owner = components.find(c => c.type !== 'LABEL' && c.type !== 'GND' && pinPositions(c).some(q => q.x === p.x && q.y === p.y));
    const dx = owner ? p.x - owner.x : 1, dy = owner ? p.y - owner.y : 0;
    const sy0 = p.y + Math.sign(dy);
    const occupied = wires && (wires.some(w => onSeg(p.x, sy0, w)) || components.some(c => pinPositions(c).some(q => q.x === p.x && q.y === sy0)));
    if (Math.abs(dy) > Math.abs(dx) && wires && !occupied) {
      // 위/아래 핀: 짧은 배선을 뺀 뒤 가로 라벨
      const sy = p.y + Math.sign(dy);
      wires.push({ id: newId('w'), x1: p.x, y1: p.y, x2: p.x, y2: sy });
      components.push({ id: newId(), type: 'LABEL', name: 'LBL', x: p.x, y: sy, rot: 0, props: { net } });
    } else {
      components.push({ id: newId(), type: 'LABEL', name: 'LBL', x: p.x, y: p.y, rot: dx < 0 ? 2 : 0, props: { net } });
    }
  }
}

function spread(pts: { x: number; y: number }[]) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
}

function mst(pts: { x: number; y: number }[]): [{ x: number; y: number }, { x: number; y: number }][] {
  const uniq = pts.filter((p, i) => pts.findIndex(q => q.x === p.x && q.y === p.y) === i);
  const inTree = [uniq[0]];
  const rest = uniq.slice(1);
  const edges: [{ x: number; y: number }, { x: number; y: number }][] = [];
  while (rest.length) {
    let bi = 0, bj = 0, bd = Infinity;
    rest.forEach((r, i) => inTree.forEach((t, j) => {
      const d = Math.abs(r.x - t.x) + Math.abs(r.y - t.y);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }));
    edges.push([inTree[bj], rest[bi]]);
    inTree.push(rest[bi]);
    rest.splice(bi, 1);
  }
  return edges;
}

function segThroughBox(s: { x1: number; y1: number; x2: number; y2: number }, x0: number, y0: number, x1: number, y1: number) {
  // 축 정렬 선분과 사각형 내부의 교차
  const sx0 = Math.min(s.x1, s.x2), sx1 = Math.max(s.x1, s.x2), sy0 = Math.min(s.y1, s.y2), sy1 = Math.max(s.y1, s.y2);
  return sx0 < x1 && sx1 > x0 && sy0 < y1 && sy1 > y0;
}

function verify(sch: Schematic, placed: { ac: AbstractComponent; c: Component }[], isGround: (n: string) => boolean): Set<string> {
  const net = buildNetlist(sch);
  const byId = new Map(net.elements.map(e => [e.id, e]));
  const nodeToNets = new Map<number, Set<string>>();
  const netToNodes = new Map<string, Set<number>>();
  for (const p of placed) {
    const e = byId.get(p.c.id);
    if (!e) continue;
    e.nodes.forEach((nd, i) => {
      const n = isGround(p.ac.nets[i] ?? '') ? '__gnd' : p.ac.nets[i];
      if (!n) return;
      if (!nodeToNets.has(nd)) nodeToNets.set(nd, new Set());
      nodeToNets.get(nd)!.add(n);
      if (!netToNodes.has(n)) netToNodes.set(n, new Set());
      netToNodes.get(n)!.add(nd);
    });
  }
  const bad = new Set<string>();
  for (const [, nets] of nodeToNets) if (nets.size > 1) nets.forEach(n => n !== '__gnd' && bad.add(n));
  for (const [n, nodes] of netToNodes) if (nodes.size > 1 && n !== '__gnd') bad.add(n);
  return bad;
}
