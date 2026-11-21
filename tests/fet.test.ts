import { describe, expect, it } from 'vitest';
import { Simulator, runAll } from '../src/engine/simulator';
import { fetIV } from '../src/engine/models';
import { mkNet } from './helpers';

describe('FET 모델', () => {
  it('정사각 법칙 영역과 미분', () => {
    const sat = fetIV(4, 5, 2, 0.01, 0);
    expect(sat.region).toBe('sat');
    expect(sat.id).toBeCloseTo(0.5 * 0.01 * 4, 9);
    expect(sat.gm).toBeCloseTo(0.01 * 2, 9);
    const tri = fetIV(4, 1, 2, 0.01, 0);
    expect(tri.region).toBe('triode');
    expect(tri.id).toBeCloseTo(0.01 * (2 * 1 - 0.5), 9);
    expect(fetIV(1, 5, 2, 0.01, 0).region).toBe('cutoff');
    // 수치 미분과 비교 (λ 포함, 역방향 포함)
    for (const [vgs, vds] of [[3.2, 0.7], [3.2, 4], [3.2, -0.6], [3, -3]]) {
      const h = 1e-6, f = fetIV(vgs, vds, 2, 0.01, 0.02);
      expect(f.gm).toBeCloseTo((fetIV(vgs + h, vds, 2, 0.01, 0.02).id - fetIV(vgs - h, vds, 2, 0.01, 0.02).id) / (2 * h), 6);
      expect(f.gds).toBeCloseTo((fetIV(vgs, vds + h, 2, 0.01, 0.02).id - fetIV(vgs, vds - h, 2, 0.01, 0.02).id) / (2 * h), 6);
    }
  });
});

describe('MOSFET 회로', () => {
  it('NMOS 공통 소스: 포화 영역 드레인 전류', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 12 }],
      ['V', 'VG', [2, 0], { voltage: 3 }],
      ['R', 'RD', [1, 3], { resistance: 1000 }],
      ['NMOS', 'M1', [2, 3, 0], { vth: 2, k: 0.01, lambda: 0 }],
    ]);
    const op = new Simulator(net).dcOperatingPoint();
    expect(op.ok).toBe(true);
    // Id = ½·0.01·(3−2)² = 5 mA → VD = 12 − 5 = 7 V
    expect(op.elements[3].pinCurrents[1]).toBeCloseTo(0.005, 6);
    expect(op.v[3]).toBeCloseTo(7, 4);
    expect(op.elements[3].state).toBe('fet-sat');
    expect(op.elements[3].pinCurrents[0]).toBeCloseTo(0, 9); // 절연 게이트
  });

  it('NMOS 스위치: 트라이오드 영역', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 5 }],
      ['V', 'VG', [2, 0], { voltage: 10 }],
      ['R', 'RD', [1, 3], { resistance: 100 }],
      ['NMOS', 'M1', [2, 3, 0], { vth: 2, k: 0.1, lambda: 0 }],
    ]);
    const op = new Simulator(net).dcOperatingPoint();
    expect(op.ok).toBe(true);
    expect(op.v[3]).toBeLessThan(0.1);
    expect(op.elements[3].state).toBe('fet-triode');
  });

  it('PMOS 하이사이드 스위치와 CMOS 인버터', () => {
    const inv = (vin: number) => {
      const net = mkNet([
        ['V', 'VDD', [1, 0], { voltage: 5 }],
        ['V', 'VIN', [2, 0], { voltage: vin }],
        ['PMOS', 'M1', [2, 3, 1], { vth: -1, k: 0.002 }],
        ['NMOS', 'M2', [2, 3, 0], { vth: 1, k: 0.002 }],
        ['R', 'RL', [3, 0], { resistance: 1e6 }],
      ]);
      const op = new Simulator(net).dcOperatingPoint();
      expect(op.ok).toBe(true);
      return op;
    };
    expect(inv(0).v[3]).toBeGreaterThan(4.95);
    expect(inv(5).v[3]).toBeLessThan(0.05);
    const mid = inv(2.5);
    expect(mid.v[3]).toBeGreaterThan(0.5);
    expect(mid.v[3]).toBeLessThan(4.5);
    expect(inv(0).elements[2].state).toBe('fet-triode');
    expect(inv(0).elements[3].state).toBe('fet-cutoff');
  });
});

describe('JFET 회로', () => {
  it('N채널 자기 바이어스: Id = IDSS(1 − VGS/VP)², VGS = −Id·RS', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 15 }],
      ['R', 'RD', [1, 2], { resistance: 1000 }],
      ['NJF', 'J1', [0, 2, 3], { idss: 0.01, vp: -4, lambda: 0 }],
      ['R', 'RS', [3, 0], { resistance: 500 }],
    ]);
    const op = new Simulator(net).dcOperatingPoint();
    expect(op.ok).toBe(true);
    // 해석해: Id = 0.01(1 − 125·Id)² → 156.25·Id² − 3.5·Id + 0.01 = 0, 핀치오프 전 근(1 − 125·Id > 0)
    const id = (3.5 - Math.sqrt(3.5 ** 2 - 4 * 156.25 * 0.01)) / (2 * 156.25);
    expect(op.elements[2].pinCurrents[1]).toBeCloseTo(id, 6);
    expect(op.v[3]).toBeCloseTo(id * 500, 4);
    expect(op.elements[2].state).toBe('fet-sat');
    expect(Math.abs(op.elements[2].pinCurrents[0])).toBeLessThan(1e-9);
  });

  it('P채널 JFET: VGS = 0 이면 IDSS 가 소스→드레인으로', () => {
    const net = mkNet([
      ['V', 'VSS', [1, 0], { voltage: 10 }],
      ['PJF', 'J1', [1, 2, 1], { idss: 0.005, vp: 3, lambda: 0 }],
      ['R', 'RD', [2, 0], { resistance: 1000 }],
    ]);
    const op = new Simulator(net).dcOperatingPoint();
    expect(op.ok).toBe(true);
    expect(op.v[2]).toBeCloseTo(5, 3);
    expect(op.elements[1].pinCurrents[1]).toBeCloseTo(-0.005, 6); // 드레인에서 나감
  });

  it('JFET 게이트에 순방향 전압을 걸면 게이트 전류가 흐름', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 10 }],
      ['V', 'VG', [2, 0], { voltage: 2 }],
      ['R', 'RG', [2, 3], { resistance: 1000 }],
      ['R', 'RD', [1, 4], { resistance: 500 }],
      ['NJF', 'J1', [3, 4, 0], { idss: 0.01, vp: -2 }],
    ]);
    const op = new Simulator(net).dcOperatingPoint();
    expect(op.ok).toBe(true);
    expect(op.elements[4].pinCurrents[0]).toBeGreaterThan(1e-3);
    expect(op.elements[4].state).toBe('fet-gate');
  });
});

describe('FET 과도·AC', () => {
  it('공통 소스 증폭기 소신호 이득 ≈ −gm·RD', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 15 }],
      ['V', 'VB', [4, 0], { voltage: 3 }],
      ['VAC', 'VIN', [2, 4], { amplitude: 0.01, frequency: 1000 }],
      ['R', 'RD', [1, 3], { resistance: 2000 }],
      ['NMOS', 'M1', [2, 3, 0], { vth: 2, k: 0.004, lambda: 0 }],
      ['C', 'CL', [3, 0], { capacitance: 1e-12 }],
    ]);
    const a = runAll(net);
    expect(a.ac?.ok).toBe(true);
    // gm = k·Vov = 0.004 → |Av| = 8
    const z = a.ac!.v[0][3];
    expect(Math.hypot(z.re, z.im)).toBeCloseTo(8, 2);
    expect(a.tran?.ok).toBe(true);
  });

  it('구형파로 구동하는 MOSFET 스위치 과도 해석', () => {
    const net = mkNet([
      ['V', 'VDD', [1, 0], { voltage: 12 }],
      ['VPULSE', 'VG', [2, 0], { low: 0, high: 10, frequency: 1000 }],
      ['R', 'RL', [1, 3], { resistance: 100 }],
      ['NMOS', 'M1', [2, 3, 0], { vth: 2, k: 0.5 }],
      ['C', 'C1', [3, 0], { capacitance: 1e-7 }],
    ]);
    const tr = new Simulator(net).transient({ tStop: 3e-3, steps: 1500 });
    expect(tr.ok).toBe(true);
    const vs = tr.frames.map(f => f.v[3]);
    expect(Math.min(...vs)).toBeLessThan(0.1);
    expect(Math.max(...vs)).toBeGreaterThan(11.5);
  });
});

import { EXAMPLES } from '../src/examples';
import { buildNetlist } from '../src/engine/netlist';
import { explain } from '../src/analysis/explain';
import { parseSpice, toSpice } from '../src/importer/spice';

describe('FET 예제와 해설', () => {
  const run = (id: string) => {
    const ex = EXAMPLES.find(e => e.id === id)!;
    const net = buildNetlist(ex.build());
    const a = runAll(net, ex.sim);
    return { net, a, rep: explain(a) };
  };
  it('MOSFET 스위치: 펄스에 따라 LED 켜짐/꺼짐', () => {
    const { a, rep, net } = run('mosfet-switch');
    expect(net.warnings).toEqual([]);
    expect(a.tran?.ok).toBe(true);
    const m = net.elements.findIndex(e => e.name === 'M1');
    const states = new Set(a.tran!.frames.map(f => f.states[m]));
    expect(states.has('fet-triode') && states.has('fet-cutoff')).toBe(true);
    expect(rep.patterns.some(p => p.kind === 'fet-switch')).toBe(true);
  });
  it('CMOS 인버터 인식', () => {
    const { rep, net } = run('cmos-inverter');
    expect(net.warnings).toEqual([]);
    expect(rep.patterns.some(p => p.kind === 'cmos-inverter')).toBe(true);
    expect(net.nodeNames[rep.outputNode!]).toBe('OUT');
  });
  it('MOSFET 공통 소스 증폭기: 동작점과 이득', () => {
    const { a, rep, net } = run('nmos-cs-amp');
    expect(net.warnings).toEqual([]);
    const m = net.elements.findIndex(e => e.name === 'M1');
    expect(a.op.elements[m].state).toBe('fet-sat');
    expect(a.op.elements[m].pinCurrents[1]).toBeGreaterThan(0.9e-3);
    expect(a.op.elements[m].pinCurrents[1]).toBeLessThan(1.3e-3);
    expect(rep.patterns.some(p => p.kind === 'common-source')).toBe(true);
    // 출력 진폭 ≈ gm·RD·Vin ≈ 13·0.05
    const out = rep.outputNode!;
    const tail = a.tran!.frames.filter(f => f.t > 0.002).map(f => f.v[out]);
    const pp = Math.max(...tail) - Math.min(...tail);
    expect(pp).toBeGreaterThan(1.0);
    expect(pp).toBeLessThan(1.8);
  });
  it('JFET 자기 바이어스: VGS < 0, 포화 영역', () => {
    const { a, rep, net } = run('jfet-amp');
    expect(net.warnings).toEqual([]);
    const j = net.elements.findIndex(e => e.name === 'J1');
    const [g, , s] = net.elements[j].nodes;
    expect(a.op.v[g] - a.op.v[s]).toBeCloseTo(-1.64, 1);
    expect(a.op.elements[j].state).toBe('fet-sat');
    const cs = rep.patterns.find(p => p.kind === 'common-source')!;
    expect(cs.text.join(' ')).toContain('자기 바이어스');
  });
  it('SPICE 왕복 (M, J 소자)', () => {
    const { net } = run('nmos-cs-amp');
    const text = toSpice(net, 't');
    const back = parseSpice(text).circuit.components;
    const m = back.find(c => c.type === 'NMOS')!;
    expect(m.props.vth).toBe(2);
    expect(m.props.k).toBeCloseTo(0.004);
    const j = parseSpice('t\nJ1 d g s JN\n.model JN NJF(VTO=-4 BETA=6.25m)\n').circuit.components[0];
    expect(j.type).toBe('NJF');
    expect(j.nets).toEqual(['g', 'd', 's']);
    expect(j.props.idss).toBeCloseTo(0.1);
  });
});
