// 수정 절점 해석법(MNA) 기반 회로 시뮬레이터
//  - DC 동작점: 뉴턴–랩슨 + 접합 전압 제한(pnjlim) + 전원 스텝핑
//  - 과도 해석: 사다리꼴 적분(불연속 직후엔 후진 오일러)
//  - AC 해석: 동작점에서 선형화한 복소 MNA 주파수 스윕

import { COMPONENTS, isFet, num } from './components';
import type { Netlist, SimElement } from './netlist';
import { solveComplex, solveReal, type Cx } from './linalg';
import { bjtIV, BJT_IS, diodeIV, diodeParams, fetIV, fetParams, pnjlim, vcrit, VT, type DiodeParams } from './models';

/** JFET 게이트–채널 PN 접합 */
const JFET_GATE: DiodeParams = { is: 1e-14, n: 1, label: 'JFET 게이트 접합', vfNominal: 0.6 };

export const GMIN = 1e-12;
export const SW_RON = 1e-3;
export const SW_ROFF = 1e9;

type Mode = 'dc' | 'ic' | 'tran';

interface StampCtx {
  mode: Mode;
  t: number;
  h: number;
  method: 'be' | 'trap';
  scale: number; // 전원 스텝핑 배율
}

export interface ElemResult {
  id: string;
  pinCurrents: number[]; // 각 핀으로 "소자에 들어가는" 전류
  power: number;         // 흡수 전력 (음수 = 공급)
  state?: string;        // 'on' | 'off' | 'active' | 'saturation' | 'cutoff' | 'linear' | 'sat+' | 'sat-' | 'breakdown' | 'closed' | 'open'
}

export interface OpResult {
  ok: boolean;
  error?: string;
  v: number[];           // 노드 전압 (index = 노드 번호, v[0]=0)
  elements: ElemResult[];
  iterations: number;
  /** MNA 행렬 (선형 회로에서 해설용으로 사용) */
  matrix?: { A: number[][]; b: number[]; unknowns: string[] };
}

export interface TranFrame { t: number; v: number[]; ip: number[][]; states: (string | undefined)[] }
export interface TranResult {
  ok: boolean;
  error?: string;
  frames: TranFrame[];
  tStop: number;
  dt: number;
  initial: 'zero' | 'op';
  events: { t: number; elementId: string; text: string }[];
}

export interface AcResult {
  ok: boolean;
  error?: string;
  inputId: string;
  freqs: number[];
  v: Cx[][]; // v[k][node]
}

export interface SimOptions {
  tStop?: number;
  steps?: number;
  initial?: 'zero' | 'op';
  acInput?: string;
  fStart?: number;
  fStop?: number;
  acPoints?: number;
}

const isVsrc = (t: string) => t === 'V' || t === 'VAC' || t === 'VPULSE';

export function sourceValue(e: SimElement, t: number): number {
  const p = e.props;
  switch (e.type) {
    case 'V': return num(p, 'voltage');
    case 'VAC': {
      const f = num(p, 'frequency', 60);
      return num(p, 'offset') + num(p, 'amplitude') * Math.sin(2 * Math.PI * f * t + (num(p, 'phase') * Math.PI) / 180);
    }
    case 'VPULSE': {
      const f = Math.max(num(p, 'frequency', 100), 1e-12);
      const T = 1 / f;
      const duty = Math.min(Math.max(num(p, 'duty', 50), 0), 100) / 100;
      const lo = num(p, 'low'), hi = num(p, 'high', 5);
      const tr = T * 1e-3;
      const tm = ((t % T) + T) % T;
      const ton = duty * T;
      if (tm < tr && t >= tr) return lo + (hi - lo) * (tm / tr);
      if (tm < ton) return hi;
      if (tm < ton + tr) return hi + (lo - hi) * ((tm - ton) / tr);
      return lo;
    }
    case 'I': return num(p, 'current');
    case 'AM': return 0;
    default: return 0;
  }
}

export function switchClosed(e: SimElement, t: number): boolean {
  const closed0 = !!e.props.closed;
  const tt = e.props.toggleTime;
  const tog = typeof tt === 'number' ? tt : typeof tt === 'string' && tt.trim() !== '' ? parseFloat(tt) : NaN;
  return isFinite(tog) && t >= tog ? !closed0 : closed0;
}

export class Simulator {
  readonly net: Netlist;
  readonly nNodes: number;     // 접지 제외 노드 수
  readonly size: number;
  readonly branch = new Map<number, number>(); // 소자 index → 미지수 index
  readonly unknownNames: string[] = [];
  private diode = new Map<number, DiodeParams>();
  private junc = new Map<number, number[]>();
  // 과도 상태
  private capV: number[] = []; private capI: number[] = [];
  private indI: number[] = []; private indV: number[] = [];

  constructor(net: Netlist) {
    this.net = net;
    this.nNodes = net.nodeCount - 1;
    for (let i = 1; i < net.nodeCount; i++) this.unknownNames.push(`V_{${net.nodeNames[i]}}`);
    let k = this.nNodes;
    net.elements.forEach((e, i) => {
      if (isVsrc(e.type) || e.type === 'C' || e.type === 'L' || e.type === 'OPAMP' || e.type === 'AM') {
        this.branch.set(i, k++);
        this.unknownNames.push(`I_{${e.name}}`);
      }
      if (e.type === 'D' || e.type === 'LED' || e.type === 'ZD') this.diode.set(i, diodeParams(e.type, e.props));
    });
    this.size = k;
    const n = net.elements.length;
    this.capV = new Array(n).fill(0); this.capI = new Array(n).fill(0);
    this.indI = new Array(n).fill(0); this.indV = new Array(n).fill(0);
  }

  get isLinear(): boolean {
    return !this.net.elements.some(e => ['D', 'LED', 'ZD', 'NPN', 'PNP', 'OPAMP'].includes(e.type) || isFet(e.type));
  }

  private V(x: number[], node: number) { return node === 0 ? 0 : x[node - 1]; }

  // ------------------------------------------------------------ 행렬 조립
  private assemble(x: number[], ctx: StampCtx, limit: boolean): { A: number[][]; b: number[]; limited: boolean } {
    const N = this.size;
    const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    const b = new Array(N).fill(0);
    let limited = false;
    const row = (node: number) => node - 1;
    const addG = (a: number, c: number, g: number) => {
      if (a) A[row(a)][row(a)] += g;
      if (c) A[row(c)][row(c)] += g;
      if (a && c) { A[row(a)][row(c)] -= g; A[row(c)][row(a)] -= g; }
    };
    // 소자로 "들어가는" 전류 I = const + Σ coef·v  를 KCL 에 반영
    const addCurrent = (node: number, consts: number, coefs: [number, number][]) => {
      if (!node) return;
      const r = row(node);
      b[r] -= consts;
      for (const [q, g] of coefs) if (q) A[r][row(q)] += g;
    };
    // 노드 최소 컨덕턴스 (부유 노드 방지)
    for (let i = 1; i <= this.nNodes; i++) A[i - 1][i - 1] += GMIN;

    this.net.elements.forEach((e, idx) => {
      const nd = e.nodes;
      const k = this.branch.get(idx);
      switch (e.type) {
        case 'R': {
          const r = Math.max(Math.abs(num(e.props, 'resistance', 1000)), 1e-9);
          addG(nd[0], nd[1], 1 / r);
          break;
        }
        case 'SW': {
          addG(nd[0], nd[1], switchClosed(e, ctx.t) ? 1 / SW_RON : 1 / SW_ROFF);
          break;
        }
        case 'I': {
          const I = sourceValue(e, ctx.t) * ctx.scale;
          // 소자로 들어가는 전류: pin0 에 +I, pin1 에 −I
          addCurrent(nd[0], I, []);
          addCurrent(nd[1], -I, []);
          break;
        }
        case 'V': case 'VAC': case 'VPULSE': case 'AM': {
          this.stampBranch(A, nd[0], nd[1], k!);
          b[k!] = (e.type === 'AM' ? 0 : sourceValue(e, ctx.t)) * ctx.scale;
          break;
        }
        case 'C': {
          this.stampBranch(A, nd[0], nd[1], k!, false);
          const C = Math.max(num(e.props, 'capacitance', 1e-6), 1e-18);
          if (ctx.mode === 'dc') {
            A[k!][k!] = 1; b[k!] = 0; // 개방: i = 0
          } else if (ctx.mode === 'ic') {
            // 초기 전압을 가진 전압원 + 아주 작은 직렬 저항
            this.rowVdiff(A, k!, nd[0], nd[1], 1);
            A[k!][k!] = -1e-6;
            b[k!] = this.capV[idx];
          } else {
            const geq = (ctx.method === 'trap' ? 2 : 1) * C / ctx.h;
            // i − geq·(va − vb) = −geq·v_prev (− i_prev, 사다리꼴)
            A[k!][k!] = 1;
            this.rowVdiff(A, k!, nd[0], nd[1], -geq);
            b[k!] = -geq * this.capV[idx] - (ctx.method === 'trap' ? this.capI[idx] : 0);
          }
          break;
        }
        case 'L': {
          this.stampBranch(A, nd[0], nd[1], k!, false);
          const L = Math.max(num(e.props, 'inductance', 1e-3), 1e-15);
          if (ctx.mode === 'dc') {
            this.rowVdiff(A, k!, nd[0], nd[1], 1); b[k!] = 0; // 단락
          } else if (ctx.mode === 'ic') {
            A[k!][k!] = 1;
            this.rowVdiff(A, k!, nd[0], nd[1], -1e-9);
            b[k!] = this.indI[idx];
          } else {
            const req = (ctx.method === 'trap' ? 2 : 1) * L / ctx.h;
            this.rowVdiff(A, k!, nd[0], nd[1], 1);
            A[k!][k!] = -req;
            b[k!] = -req * this.indI[idx] - (ctx.method === 'trap' ? this.indV[idx] : 0);
          }
          break;
        }
        case 'D': case 'LED': case 'ZD': {
          const p = this.diode.get(idx)!;
          let vd = this.V(x, nd[0]) - this.V(x, nd[1]);
          if (limit) {
            const prev = this.junc.get(idx)?.[0] ?? 0;
            const nvt = p.n * VT;
            let vl = vd;
            if (vd > 0 || p.bv === undefined) vl = pnjlim(vd, prev, nvt, vcrit(p.is, nvt));
            else {
              const nz = 1.5 * VT;
              const u = pnjlim(-(vd + p.bv), -(prev + p.bv), nz, vcrit(0.01, nz));
              vl = -u - p.bv;
            }
            if (Math.abs(vl - vd) > 1e-12) limited = true;
            vd = vl;
            this.junc.set(idx, [vd]);
          }
          const { i, g } = diodeIV(vd, p);
          const gt = g + GMIN;
          const c0 = i + GMIN * vd - gt * vd;
          addCurrent(nd[0], c0, [[nd[0], gt], [nd[1], -gt]]);
          addCurrent(nd[1], -c0, [[nd[0], -gt], [nd[1], gt]]);
          break;
        }
        case 'NPN': case 'PNP': {
          const s = e.type === 'NPN' ? 1 : -1;
          const [nb, nc, ne] = nd;
          const vb = this.V(x, nb), vc = this.V(x, nc), ve = this.V(x, ne);
          let vbe = s * (vb - ve), vbc = s * (vb - vc);
          if (limit) {
            const prev = this.junc.get(idx) ?? [0, 0];
            const vcr = vcrit(BJT_IS, VT);
            const lbe = pnjlim(vbe, prev[0], VT, vcr), lbc = pnjlim(vbc, prev[1], VT, vcr);
            if (Math.abs(lbe - vbe) > 1e-12 || Math.abs(lbc - vbc) > 1e-12) limited = true;
            vbe = lbe; vbc = lbc;
            this.junc.set(idx, [vbe, vbc]);
          }
          const bf = Math.max(num(e.props, 'beta', 100), 1);
          const m = bjtIV(vbe, vbc, bf);
          // 들어가는 전류(단자 기준) = s·(i0 − a1·vbe_l − a2·vbc_l) + a1·(vb−ve) + a2·(vb−vc)
          const lin = (i0: number, a1: number, a2: number) => ({
            c: s * (i0 - a1 * vbe - a2 * vbc),
            coef: [[nb, a1 + a2], [ne, -a1], [nc, -a2]] as [number, number][],
          });
          const IC = lin(m.ic, m.dic_dvbe, m.dic_dvbc);
          const IB = lin(m.ib, m.dib_dvbe, m.dib_dvbc);
          addCurrent(nc, IC.c, IC.coef);
          addCurrent(nb, IB.c, IB.coef);
          const IEcoef: [number, number][] = IC.coef.map(([n2, g], j) => [n2, -(g + IB.coef[j][1])]);
          addCurrent(ne, -(IC.c + IB.c), IEcoef);
          // 접합 누설 최소 컨덕턴스
          addG(nb, ne, GMIN); addG(nb, nc, GMIN);
          break;
        }
        case 'NMOS': case 'PMOS': case 'NJF': case 'PJF': {
          const fp = fetParams(e.type, e.props);
          const s = fp.s;
          const [ng, ndr, nsrc] = nd;
          const vg = this.V(x, ng), vdr = this.V(x, ndr), vsr = this.V(x, nsrc);
          let vgs = s * (vg - vsr), vds = s * (vdr - vsr);
          let vj1 = s * (vg - vsr), vj2 = s * (vg - vdr); // JFET 게이트 접합 (G–S, G–D)
          const prev = this.junc.get(idx);
          if (limit && prev) {
            // 뉴턴 반복 한 번에 게이트·드레인 전압이 너무 크게 움직이지 않도록 제한
            const lim = (v: number, p: number, m: number) => (Math.abs(v - p) > m ? p + Math.sign(v - p) * m : v);
            const lg = lim(vgs, prev[0], 1), ld = lim(vds, prev[1], 4);
            if (lg !== vgs || ld !== vds) limited = true;
            vgs = lg; vds = ld;
            if (fp.jfet) {
              const vcr = vcrit(JFET_GATE.is, VT);
              const l1 = pnjlim(vj1, prev[2] ?? 0, VT, vcr), l2 = pnjlim(vj2, prev[3] ?? 0, VT, vcr);
              if (Math.abs(l1 - vj1) > 1e-12 || Math.abs(l2 - vj2) > 1e-12) limited = true;
              vj1 = l1; vj2 = l2;
            }
          }
          if (limit) this.junc.set(idx, [vgs, vds, vj1, vj2]);
          const m = fetIV(vgs, vds, fp.vt, fp.K, fp.lambda);
          // 드레인으로 들어가는 전류 = s·(id0 − gm·vgs_l − gds·vds_l) + gm·(vg − vs) + gds·(vd − vs)
          const c = s * (m.id - m.gm * vgs - m.gds * vds);
          const coef: [number, number][] = [[ng, m.gm], [ndr, m.gds], [nsrc, -(m.gm + m.gds)]];
          addCurrent(ndr, c, coef);
          addCurrent(nsrc, -c, coef.map(([n2, gg]) => [n2, -gg] as [number, number]));
          addG(ndr, nsrc, GMIN);
          if (fp.jfet) {
            // 게이트 접합 다이오드: N채널은 게이트→채널, P채널은 채널→게이트 방향이 순방향
            const junction = (vj: number, other: number) => {
              const { i, g } = diodeIV(vj, JFET_GATE);
              const gt = g + GMIN;
              const c0 = s * (i + GMIN * vj - gt * vj);
              addCurrent(ng, c0, [[ng, gt], [other, -gt]]);
              addCurrent(other, -c0, [[ng, -gt], [other, gt]]);
            };
            junction(vj1, nsrc);
            junction(vj2, ndr);
          } else {
            addG(ng, nsrc, GMIN); // 절연 게이트: 아주 작은 누설만
          }
          break;
        }
        case 'OPAMP': {
          const [nm, np, no] = nd;
          const Aol = Math.max(num(e.props, 'gain', 1e5), 1);
          const vs = Math.max(num(e.props, 'vsat', 15), 0.01);
          const vd = this.V(x, np) - this.V(x, nm);
          const th = Math.tanh((Aol * vd) / vs);
          const f = vs * th;
          const fp = Aol * (1 - th * th);
          // 출력 단자로 들어가는 전류 = 분기 전류
          if (no) A[row(no)][k!] += 1;
          // v_out − f'(vd)·(v+ − v−) = f(vd0) − f'·vd0
          if (no) A[k!][row(no)] += 1;
          if (np) A[k!][row(np)] -= fp;
          if (nm) A[k!][row(nm)] += fp;
          b[k!] = f - fp * vd;
          break;
        }
        case 'VM': default: break;
      }
    });
    return { A, b, limited };
  }

  /** 분기 전류 변수의 KCL 기여 (+ 단자에서 나가 소자로 들어감) 와 기본 제약식 */
  private stampBranch(A: number[][], p: number, n: number, k: number, constraint = true) {
    if (p) A[p - 1][k] += 1;
    if (n) A[n - 1][k] -= 1;
    if (constraint) this.rowVdiff(A, k, p, n, 1);
  }
  private rowVdiff(A: number[][], k: number, p: number, n: number, g: number) {
    if (p) A[k][p - 1] += g;
    if (n) A[k][n - 1] -= g;
  }

  // ------------------------------------------------------------ 뉴턴–랩슨
  private newton(x0: number[], ctx: StampCtx, maxIter = 150): { x: number[]; iter: number } | null {
    let x = x0.slice();
    const linear = this.isLinear;
    for (let it = 1; it <= maxIter; it++) {
      const { A, b, limited } = this.assemble(x, ctx, true);
      const xn = solveReal(A, b);
      if (!xn) return null;
      if (linear) return { x: xn, iter: 1 };
      let conv = !limited;
      for (let i = 0; i < xn.length; i++) {
        const tol = 1e-6 + 1e-4 * Math.max(Math.abs(xn[i]), Math.abs(x[i]));
        if (Math.abs(xn[i] - x[i]) > tol) { conv = false; break; }
      }
      // 큰 폭의 갱신은 감쇠 (연산증폭기 등 급격한 비선형 대비)
      if (!conv && it > 20) {
        const a = it > 60 ? 0.3 : 0.6;
        x = x.map((v, i) => v + a * (xn[i] - v));
      } else x = xn;
      if (conv && it > 1) return { x, iter: it };
    }
    return null;
  }

  private solvePoint(ctx: Omit<StampCtx, 'scale'>, guess?: number[]): { x: number[]; iter: number } | null {
    this.junc.clear();
    const g = guess ?? new Array(this.size).fill(0);
    const direct = this.newton(g, { ...ctx, scale: 1 });
    if (direct) return direct;
    // 전원 스텝핑: 0 → 100 % 로 서서히 올리며 수렴 유도
    this.junc.clear();
    let x = new Array(this.size).fill(0);
    let total = 0;
    for (let s = 1; s <= 20; s++) {
      const r = this.newton(x, { ...ctx, scale: s / 20 }, 300);
      if (!r) return null;
      x = r.x; total += r.iter;
    }
    return { x, iter: total };
  }

  // ------------------------------------------------------------ 결과 정리
  private elementResults(x: number[], t: number): ElemResult[] {
    return this.net.elements.map((e, idx) => {
      const nd = e.nodes;
      const v = nd.map(n => this.V(x, n));
      const k = this.branch.get(idx);
      let pin: number[] = nd.map(() => 0);
      let state: string | undefined;
      switch (e.type) {
        case 'R': { const i = (v[0] - v[1]) / Math.max(Math.abs(num(e.props, 'resistance', 1000)), 1e-9); pin = [i, -i]; break; }
        case 'SW': {
          const c = switchClosed(e, t);
          const i = (v[0] - v[1]) / (c ? SW_RON : SW_ROFF); pin = [i, -i]; state = c ? 'closed' : 'open'; break;
        }
        case 'I': { const I = sourceValue(e, t); pin = [I, -I]; break; }
        case 'V': case 'VAC': case 'VPULSE': case 'AM': case 'C': case 'L':
          pin = [x[k!], -x[k!]]; break;
        case 'OPAMP': {
          pin = [0, 0, x[k!]];
          const vs = num(e.props, 'vsat', 15);
          state = v[2] > 0.98 * vs ? 'sat+' : v[2] < -0.98 * vs ? 'sat-' : 'linear';
          break;
        }
        case 'D': case 'LED': case 'ZD': {
          const p = this.diode.get(idx)!;
          const vd = v[0] - v[1];
          const i = diodeIV(vd, p).i + GMIN * vd;
          pin = [i, -i];
          state = i > 1e-4 ? 'on' : (p.bv !== undefined && i < -1e-4) ? 'breakdown' : 'off';
          break;
        }
        case 'NPN': case 'PNP': {
          const s = e.type === 'NPN' ? 1 : -1;
          const vbe = s * (v[0] - v[2]), vbc = s * (v[0] - v[1]);
          const m = bjtIV(vbe, vbc, Math.max(num(e.props, 'beta', 100), 1));
          const ib = s * m.ib, ic = s * m.ic;
          pin = [ib, ic, -(ib + ic)];
          const onBE = vbe > 0.5, onBC = vbc > 0.4;
          state = !onBE ? 'cutoff' : onBC ? 'saturation' : 'active';
          if (Math.abs(m.ic) < 1e-7) state = 'cutoff';
          break;
        }
        case 'NMOS': case 'PMOS': case 'NJF': case 'PJF': {
          const fp = fetParams(e.type, e.props);
          const s = fp.s;
          const vgs = s * (v[0] - v[2]), vds = s * (v[1] - v[2]);
          const m = fetIV(vgs, vds, fp.vt, fp.K, fp.lambda);
          let ig = 0, idr = s * m.id;
          if (fp.jfet) {
            const igs = diodeIV(vgs, JFET_GATE).i, igd = diodeIV(s * (v[0] - v[1]), JFET_GATE).i;
            ig = s * (igs + igd);
            idr -= s * igd;
          }
          pin = [ig, idr, -(ig + idr)];
          state = Math.abs(m.id) < 1e-9 ? 'fet-cutoff' : m.region === 'triode' ? 'fet-triode' : m.region === 'sat' ? 'fet-sat' : 'fet-cutoff';
          if (fp.jfet && Math.abs(ig) > 1e-5) state = 'fet-gate';
          break;
        }
      }
      const power = v.reduce((s, vv, j) => s + vv * pin[j], 0);
      return { id: e.id, pinCurrents: pin, power, state };
    });
  }

  private nodeVoltages(x: number[]): number[] {
    const v = [0];
    for (let i = 0; i < this.nNodes; i++) v.push(x[i]);
    return v;
  }

  // ------------------------------------------------------------ DC 동작점
  dcOperatingPoint(): OpResult {
    if (this.net.elements.length === 0) return { ok: false, error: '회로에 소자가 없습니다.', v: [0], elements: [], iterations: 0 };
    const r = this.solvePoint({ mode: 'dc', t: 0, h: 1, method: 'be' });
    if (!r) {
      return {
        ok: false,
        error: '동작점이 수렴하지 않았습니다. 전압원끼리 병렬 연결(루프)이나 전류원만으로 이루어진 경로(컷셋)가 있는지 확인하세요.',
        v: new Array(this.net.nodeCount).fill(0), elements: [], iterations: 0,
      };
    }
    const res: OpResult = { ok: true, v: this.nodeVoltages(r.x), elements: this.elementResults(r.x, 0), iterations: r.iter };
    if (this.isLinear && this.size <= 10) {
      const { A, b } = this.assemble(r.x, { mode: 'dc', t: 0, h: 1, method: 'be', scale: 1 }, false);
      // 해설용: GMIN 을 제거한 깔끔한 행렬
      for (let i = 0; i < this.nNodes; i++) A[i][i] -= GMIN;
      res.matrix = { A, b, unknowns: this.unknownNames };
    }
    return res;
  }

  // ------------------------------------------------------------ 과도 해석
  transient(opts: SimOptions = {}): TranResult {
    const tStop = opts.tStop ?? suggestTStop(this.net);
    const steps = Math.max(50, Math.min(opts.steps ?? 1500, 20000));
    const dt = tStop / steps;
    const initial = opts.initial ?? 'zero';
    const els = this.net.elements;
    const frames: TranFrame[] = [];
    const events: TranResult['events'] = [];
    const fail = (msg: string): TranResult => ({ ok: false, error: msg, frames, tStop, dt, initial, events });

    // 초기 상태
    let x: number[];
    if (initial === 'op') {
      const r = this.solvePoint({ mode: 'dc', t: 0, h: dt, method: 'be' });
      if (!r) return fail('초기 동작점을 구하지 못했습니다.');
      x = r.x;
      els.forEach((e, i) => {
        const k = this.branch.get(i);
        if (e.type === 'C') { this.capV[i] = this.V(x, e.nodes[0]) - this.V(x, e.nodes[1]); this.capI[i] = 0; }
        if (e.type === 'L') { this.indI[i] = x[k!]; this.indV[i] = 0; }
      });
    } else {
      els.forEach((e, i) => {
        if (e.type === 'C') { this.capV[i] = num(e.props, 'ic', 0); this.capI[i] = 0; }
        if (e.type === 'L') { this.indI[i] = num(e.props, 'ic', 0); this.indV[i] = 0; }
      });
      const r = this.solvePoint({ mode: 'ic', t: 0, h: dt, method: 'be' });
      if (!r) return fail('t = 0 초기 상태를 구하지 못했습니다.');
      x = r.x;
      this.updateStates(x);
    }
    const record = (t: number, xx: number[]) => {
      const er = this.elementResults(xx, t);
      frames.push({ t, v: this.nodeVoltages(xx), ip: er.map(e => e.pinCurrents), states: er.map(e => e.state) });
    };
    record(0, x);

    // 불연속 시각 (스위치 전환)
    const toggles = els
      .filter(e => e.type === 'SW')
      .map(e => ({ e, t: switchClosed(e, 0) !== switchClosed(e, tStop + dt) ? findToggle(e) : NaN }))
      .filter(o => isFinite(o.t) && o.t > 0 && o.t < tStop);

    let t = 0;
    let useBE = true;
    for (let s = 1; s <= steps; s++) {
      const tNext = s * dt;
      if (toggles.some(o => o.t > t && o.t <= tNext + 1e-15)) {
        for (const o of toggles) if (o.t > t && o.t <= tNext + 1e-15) {
          events.push({ t: o.t, elementId: o.e.id, text: `${o.e.name} 스위치가 ${switchClosed(o.e, o.t) ? '닫힘' : '열림'}` });
        }
        useBE = true;
      }
      const r = this.stepWithRetry(x, t, dt, useBE ? 'be' : 'trap', 0);
      if (!r) return fail(`t = ${tNext.toExponential(3)} s 에서 수렴하지 않았습니다.`);
      x = r; t = tNext; useBE = false;
      record(t, x);
    }

    // 상태 변화 이벤트 (다이오드 도통, 트랜지스터 영역, 연산증폭기 포화)
    els.forEach((e, i) => {
      let prev = frames[0].states[i];
      for (const f of frames) {
        const st = f.states[i];
        if (st !== prev && st !== undefined && e.type !== 'SW') {
          events.push({ t: f.t, elementId: e.id, text: `${e.name}: ${stateKo(prev)} → ${stateKo(st)}` });
        }
        prev = st;
      }
    });
    events.sort((a, b) => a.t - b.t);
    return { ok: true, frames, tStop, dt, initial, events };
  }

  private stepWithRetry(x: number[], t: number, h: number, method: 'be' | 'trap', depth: number): number[] | null {
    const saved = this.saveStates();
    const r = this.newton(x, { mode: 'tran', t: t + h, h, method, scale: 1 }, 100);
    if (r) { this.updateStates(r.x, h, method); return r.x; }
    this.restoreStates(saved);
    if (depth >= 4) return null;
    let xx = x;
    for (let j = 0; j < 4; j++) {
      const r2 = this.stepWithRetry(xx, t + (j * h) / 4, h / 4, 'be', depth + 1);
      if (!r2) return null;
      xx = r2;
    }
    return xx;
  }

  private saveStates() { return [this.capV.slice(), this.capI.slice(), this.indI.slice(), this.indV.slice()]; }
  private restoreStates(s: number[][]) { [this.capV, this.capI, this.indI, this.indV] = s.map(a => a.slice()); }

  private updateStates(x: number[], _h?: number, _m?: string) {
    this.net.elements.forEach((e, i) => {
      const k = this.branch.get(i);
      if (e.type === 'C') { this.capV[i] = this.V(x, e.nodes[0]) - this.V(x, e.nodes[1]); this.capI[i] = x[k!]; }
      if (e.type === 'L') { this.indI[i] = x[k!]; this.indV[i] = this.V(x, e.nodes[0]) - this.V(x, e.nodes[1]); }
    });
  }

  // ------------------------------------------------------------ AC 해석
  ac(op: OpResult, opts: SimOptions = {}): AcResult {
    const els = this.net.elements;
    const input = els.find(e => e.id === opts.acInput && (isVsrc(e.type) || e.type === 'I'))
      ?? els.find(e => e.type === 'VAC') ?? els.find(e => isVsrc(e.type)) ?? els.find(e => e.type === 'I');
    const empty: AcResult = { ok: false, inputId: '', freqs: [], v: [] };
    if (!input) return { ...empty, error: '입력으로 쓸 전원이 없습니다.' };
    if (!op.ok) return { ...empty, error: '동작점이 없어 AC 해석을 할 수 없습니다.' };
    const range = suggestFreqRange(this.net);
    const f0 = opts.fStart ?? range[0], f1 = opts.fStop ?? range[1];
    const npts = opts.acPoints ?? 241;
    const freqs: number[] = [];
    for (let i = 0; i < npts; i++) freqs.push(f0 * Math.pow(f1 / f0, i / (npts - 1)));

    // 동작점에서의 선형화 행렬 (실수부: 컨덕턴스)
    const xop = op.v.slice(1);
    for (let i = this.nNodes; i < this.size; i++) xop.push(0);
    this.junc.clear();
    const { A: G } = this.assemble(xop, { mode: 'dc', t: 0, h: 1, method: 'be', scale: 1 }, false);
    const N = this.size;
    const out: Cx[][] = [];
    for (const f of freqs) {
      const w = 2 * Math.PI * f;
      const Ar = G.map(r => r.slice());
      const Ai: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
      const br = new Array(N).fill(0), bi = new Array(N).fill(0);
      els.forEach((e, idx) => {
        const k = this.branch.get(idx);
        const [p, n] = e.nodes;
        if (e.type === 'C') {
          // i − jωC·(va − vb) = 0
          Ar[k!].fill(0); Ar[k!][k!] = 1;
          if (p) Ai[k!][p - 1] -= w * Math.max(num(e.props, 'capacitance', 1e-6), 1e-18);
          if (n) Ai[k!][n - 1] += w * Math.max(num(e.props, 'capacitance', 1e-6), 1e-18);
        } else if (e.type === 'L') {
          // (va − vb) − jωL·i = 0
          Ar[k!].fill(0);
          if (p) Ar[k!][p - 1] = 1;
          if (n) Ar[k!][n - 1] = -1;
          Ai[k!][k!] = -w * Math.max(num(e.props, 'inductance', 1e-3), 1e-15);
        } else if (isVsrc(e.type) || e.type === 'AM') {
          br[k!] = e.id === input.id ? 1 : 0;
        }
      });
      // 직류 전원/전류원의 소신호 값 제거 (동작점 조립 시 들어간 b 는 사용하지 않음)
      if (input.type === 'I') {
        const [p, n] = input.nodes;
        if (p) br[p - 1] -= 1;
        if (n) br[n - 1] += 1;
      }
      // 연산증폭기 제약식의 상수항 제거
      els.forEach((e, idx) => { if (e.type === 'OPAMP') br[this.branch.get(idx)!] = 0; });
      const sol = solveComplex(Ar, Ai, br, bi);
      if (!sol) return { ...empty, inputId: input.id, error: `${f.toPrecision(3)} Hz 에서 해를 구하지 못했습니다.` };
      out.push([{ re: 0, im: 0 }, ...sol.slice(0, this.nNodes)]);
    }
    return { ok: true, inputId: input.id, freqs, v: out };
  }
}

function findToggle(e: SimElement): number {
  const tt = e.props.toggleTime;
  return typeof tt === 'number' ? tt : parseFloat(String(tt));
}

export function stateKo(s?: string): string {
  switch (s) {
    case 'on': return '도통(ON)';
    case 'off': return '차단(OFF)';
    case 'breakdown': return '역방향 항복';
    case 'active': return '활성 영역';
    case 'saturation': return '포화 영역';
    case 'cutoff': return '차단 영역';
    case 'linear': return '선형 동작';
    case 'fet-cutoff': return '차단 영역';
    case 'fet-triode': return '트라이오드(선형·옴) 영역';
    case 'fet-sat': return '포화(핀치오프) 영역';
    case 'fet-gate': return '게이트 접합 순방향 도통(비정상)';
    case 'sat+': return '+포화';
    case 'sat-': return '−포화';
    case 'closed': return '닫힘';
    case 'open': return '열림';
    default: return '—';
  }
}

/** 회로의 시정수·주기를 보고 적당한 과도 해석 시간을 추정 */
export function suggestTStop(net: Netlist): number {
  const els = net.elements;
  const cands: number[] = [];
  const periods = els.filter(e => e.type === 'VAC' || e.type === 'VPULSE').map(e => 1 / Math.max(num(e.props, 'frequency', 60), 1e-9));
  if (periods.length) cands.push(Math.max(...periods) * (els.some(e => e.type === 'C' || e.type === 'L') ? 5 : 3));
  const Rs = els.filter(e => e.type === 'R').map(e => num(e.props, 'resistance', 1000));
  const Rmax = Rs.length ? Math.max(...Rs) : 1000, Rmin = Rs.length ? Math.min(...Rs) : 1000;
  for (const c of els.filter(e => e.type === 'C')) cands.push(5 * Rmax * num(c.props, 'capacitance', 1e-6));
  for (const l of els.filter(e => e.type === 'L')) {
    cands.push(5 * num(l.props, 'inductance', 1e-3) / Math.max(Rmin, 1e-3));
    for (const c of els.filter(e => e.type === 'C')) cands.push(10 * 2 * Math.PI * Math.sqrt(num(l.props, 'inductance') * num(c.props, 'capacitance')));
  }
  for (const s of els.filter(e => e.type === 'SW')) {
    const t = findToggle(s);
    if (isFinite(t) && t > 0) cands.push(t * 2);
  }
  if (!cands.length) return 1e-3;
  let t = Math.max(...cands);
  // 주기 전원이 있으면 최대 20주기로 제한 (큰 커패시터의 긴 충전 시간은 생략)
  if (periods.length) t = Math.min(t, Math.max(...periods) * 20);
  // 보기 좋은 값으로 반올림 (1, 2, 5 × 10^n)
  const e = Math.pow(10, Math.floor(Math.log10(t)));
  for (const m of [1, 2, 5, 10]) if (t <= m * e) return m * e;
  return 10 * e;
}

export function suggestFreqRange(net: Netlist): [number, number] {
  const els = net.elements;
  const fc: number[] = [];
  const Rs = els.filter(e => e.type === 'R').map(e => num(e.props, 'resistance', 1000));
  const Rgeo = Rs.length ? Math.exp(Rs.reduce((s, r) => s + Math.log(r), 0) / Rs.length) : 1000;
  for (const c of els.filter(e => e.type === 'C')) fc.push(1 / (2 * Math.PI * Rgeo * num(c.props, 'capacitance', 1e-6)));
  for (const l of els.filter(e => e.type === 'L')) {
    fc.push(Rgeo / (2 * Math.PI * num(l.props, 'inductance', 1e-3)));
    for (const c of els.filter(e => e.type === 'C')) fc.push(1 / (2 * Math.PI * Math.sqrt(num(l.props, 'inductance') * num(c.props, 'capacitance'))));
  }
  for (const s of els.filter(e => e.type === 'VAC')) fc.push(num(s.props, 'frequency', 60));
  if (!fc.length) return [1, 1e6];
  const lo = Math.min(...fc) / 1000, hi = Math.max(...fc) * 1000;
  const r = (v: number, f: typeof Math.floor) => Math.pow(10, f(Math.log10(v)));
  return [Math.max(r(lo, Math.floor), 1e-3), Math.min(r(hi, Math.ceil), 1e10)];
}

export function pinName(e: SimElement, i: number) { return COMPONENTS[e.type].pins[i]?.name ?? String(i); }

/** 전체 해석 실행 */
export interface Analysis {
  net: Netlist;
  op: OpResult;
  tran?: TranResult;
  ac?: AcResult;
  sim: Simulator;
}

export function needsTransient(net: Netlist): boolean {
  return net.elements.some(e => ['C', 'L', 'VAC', 'VPULSE'].includes(e.type) || (e.type === 'SW' && isFinite(findToggle(e))));
}

export function runAll(net: Netlist, opts: SimOptions = {}): Analysis {
  const sim = new Simulator(net);
  const op = sim.dcOperatingPoint();
  let tran: TranResult | undefined;
  let ac: AcResult | undefined;
  if (needsTransient(net)) tran = new Simulator(net).transient(opts);
  if (op.ok && net.elements.some(e => e.type === 'C' || e.type === 'L' || e.type === 'VAC')) ac = sim.ac(op, opts);
  return { net, op, tran, ac, sim };
}
