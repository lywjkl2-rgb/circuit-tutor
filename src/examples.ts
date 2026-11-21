// 교과서 예제 회로 모음 (격자 좌표로 직접 그린 회로도)

import { COMPONENTS, type Component, type CompType, type Props, type Schematic, type Wire } from './engine/components';
import type { SimOptions } from './engine/simulator';

export interface Example {
  id: string;
  title: string;
  level: '기초' | '중급' | '응용';
  summary: string;
  build: () => Schematic;
  sim?: SimOptions;
}

let seq = 0;
function comp(type: CompType, name: string, x: number, y: number, rot = 0, props: Props = {}, flip = false): Component {
  return { id: `ex${seq++}`, type, name, x, y, rot, flip, props: { ...structuredClone(COMPONENTS[type].defaults), ...props } };
}
const gnd = (x: number, y: number) => comp('GND', 'GND', x, y);
const label = (x: number, y: number, net: string) => comp('LABEL', 'LBL', x, y, 0, { net });
/** 꺾은선 배선: wire(x1,y1, x2,y2, x3,y3, ...) */
function wire(...p: number[]): Wire[] {
  const out: Wire[] = [];
  for (let i = 0; i + 3 < p.length; i += 2) out.push({ id: `exw${seq++}`, x1: p[i], y1: p[i + 1], x2: p[i + 2], y2: p[i + 3] });
  return out;
}

/** 전원(0,0) – 위쪽 직렬 소자(4,-4) – 오른쪽 세로 소자(8,0) 구조 */
function seriesShunt(src: Component, series: Component, shunt: Component, out = true): Schematic {
  return {
    components: [src, series, shunt, gnd(4, 4), ...(out ? [label(11, -4, 'OUT')] : [])],
    wires: [...wire(0, -2, 0, -4, 2, -4), ...wire(6, -4, 8, -4, 8, -2), ...wire(0, 2, 0, 4, 8, 4, 8, 2), ...(out ? wire(8, -4, 11, -4) : [])],
  };
}

export const EXAMPLES: Example[] = [
  {
    id: 'divider', title: '전압 분배기', level: '기초',
    summary: '직렬 저항 두 개로 전압을 원하는 비율로 나누는 가장 기본적인 회로',
    build: () => seriesShunt(comp('V', 'V1', 0, 0, 0, { voltage: 9 }), comp('R', 'R1', 4, -4, 0, { resistance: 2000 }), comp('R', 'R2', 8, 0, 1, { resistance: 1000 })),
  },
  {
    id: 'led', title: 'LED와 전류 제한 저항', level: '기초',
    summary: '저항이 LED 전류를 안전한 값으로 제한하는 원리',
    build: () => seriesShunt(comp('V', 'V1', 0, 0, 0, { voltage: 5 }), comp('R', 'R1', 4, -4, 0, { resistance: 330 }), comp('LED', 'D1', 8, 0, 1, { color: 'red' }), false),
  },
  {
    id: 'rc', title: 'RC 충·방전 (구형파 입력)', level: '기초',
    summary: '커패시터가 시정수 τ = RC 에 따라 충전·방전되는 과정',
    build: () => seriesShunt(comp('VPULSE', 'V1', 0, 0, 0, { low: 0, high: 5, frequency: 100, duty: 50 }), comp('R', 'R1', 4, -4, 0, { resistance: 1000 }), comp('C', 'C1', 8, 0, 1, { capacitance: 1e-6 })),
    sim: { tStop: 0.02 },
  },
  {
    id: 'rl', title: 'RL 회로 (전류의 지연)', level: '기초',
    summary: '인덕터가 전류의 급격한 변화를 막아 전류가 천천히 증가하는 모습',
    build: () => seriesShunt(comp('V', 'V1', 0, 0, 0, { voltage: 10 }), comp('R', 'R1', 4, -4, 0, { resistance: 100 }), comp('L', 'L1', 8, 0, 1, { inductance: 0.1 })),
    sim: { tStop: 0.005 },
  },
  {
    id: 'lpf', title: 'RC 저역통과 필터', level: '중급',
    summary: '주파수가 높을수록 출력이 줄어드는 필터와 차단 주파수',
    build: () => seriesShunt(comp('VAC', 'V1', 0, 0, 0, { amplitude: 1, frequency: 1000 }), comp('R', 'R1', 4, -4, 0, { resistance: 1000 }), comp('C', 'C1', 8, 0, 1, { capacitance: 100e-9 })),
  },
  {
    id: 'rlc', title: '직렬 RLC 공진 (감쇠 진동)', level: '중급',
    summary: '에너지가 L과 C 사이를 오가며 진동하고 저항이 이를 감쇠시키는 과정',
    build: () => ({
      components: [
        comp('V', 'V1', 0, 0, 0, { voltage: 5 }), comp('R', 'R1', 4, -4, 0, { resistance: 10 }),
        comp('L', 'L1', 10, -4, 0, { inductance: 1e-3 }), comp('C', 'C1', 14, 0, 1, { capacitance: 1e-6 }),
        gnd(7, 4), label(17, -4, 'OUT'),
      ],
      wires: [...wire(0, -2, 0, -4, 2, -4), ...wire(6, -4, 8, -4), ...wire(12, -4, 14, -4, 14, -2), ...wire(0, 2, 0, 4, 14, 4, 14, 2), ...wire(14, -4, 17, -4)],
    }),
    sim: { tStop: 0.002 },
  },
  {
    id: 'halfwave', title: '반파 정류 + 평활 커패시터', level: '중급',
    summary: '교류를 직류로 바꾸는 전원 회로의 첫 단계와 리플',
    build: () => ({
      components: [
        comp('VAC', 'V1', 0, 0, 0, { amplitude: 10, frequency: 60 }), comp('D', 'D1', 4, -4, 0, { model: 'rect' }),
        comp('C', 'C1', 8, 0, 1, { capacitance: 100e-6 }), comp('R', 'RL', 12, 0, 1, { resistance: 1000 }),
        gnd(4, 4), label(15, -4, 'OUT'),
      ],
      wires: [...wire(0, -2, 0, -4, 2, -4), ...wire(6, -4, 12, -4, 12, -2), ...wire(8, -4, 8, -2), ...wire(0, 2, 0, 4, 12, 4, 12, 2), ...wire(8, 2, 8, 4), ...wire(12, -4, 15, -4)],
    }),
    sim: { tStop: 0.1 },
  },
  {
    id: 'bridge', title: '전파 브리지 정류기', level: '응용',
    summary: '다이오드 4개가 반주기마다 짝을 바꿔 도통하며 음의 반파를 뒤집는 원리',
    build: () => ({
      components: [
        comp('VAC', 'V1', 2, 0, 0, { amplitude: 12, frequency: 60 }),
        comp('D', 'D1', 8, -4, 3, { model: 'rect' }), comp('D', 'D3', 8, 4, 3, { model: 'rect' }),
        comp('D', 'D2', 14, -4, 3, { model: 'rect' }), comp('D', 'D4', 14, 4, 3, { model: 'rect' }),
        comp('C', 'C1', 20, 0, 1, { capacitance: 220e-6 }), comp('R', 'RL', 24, 0, 1, { resistance: 1000 }),
        gnd(17, 8), label(27, -8, 'OUT'),
      ],
      wires: [
        ...wire(8, -2, 8, 2), ...wire(14, -2, 14, 2),
        ...wire(8, -6, 8, -8, 24, -8, 24, -2), ...wire(14, -8, 14, -6), ...wire(20, -8, 20, -2),
        ...wire(8, 6, 8, 8, 24, 8, 24, 2), ...wire(14, 8, 14, 6), ...wire(20, 8, 20, 2),
        ...wire(2, -2, 2, -3, 5, -3, 5, 0, 8, 0), ...wire(2, 2, 2, 10, 11, 10, 11, 0, 14, 0), ...wire(24, -8, 27, -8),
      ],
    }),
    sim: { tStop: 0.1 },
  },
  {
    id: 'zener', title: '제너 다이오드 전압 레귤레이터', level: '중급',
    summary: '역방향 항복을 이용해 입력이 변해도 출력 전압을 일정하게 유지',
    build: () => ({
      components: [
        comp('V', 'V1', 0, 0, 0, { voltage: 12 }), comp('R', 'R1', 4, -4, 0, { resistance: 470 }),
        comp('ZD', 'DZ1', 8, 0, 3, { vz: 5.1 }), comp('R', 'RL', 12, 0, 1, { resistance: 2000 }),
        gnd(4, 4), label(15, -4, 'OUT'),
      ],
      wires: [...wire(0, -2, 0, -4, 2, -4), ...wire(6, -4, 12, -4, 12, -2), ...wire(8, -4, 8, -2), ...wire(0, 2, 0, 4, 12, 4, 12, 2), ...wire(8, 2, 8, 4), ...wire(12, -4, 15, -4)],
    }),
  },
  {
    id: 'inverting', title: '반전 증폭기 (연산증폭기)', level: '중급',
    summary: '가상 접지와 음의 귀환으로 이득 −Rf/Rin 을 얻는 원리',
    build: () => ({
      components: [
        comp('VAC', 'VIN', 0, 1, 0, { amplitude: 0.5, frequency: 1000 }), comp('R', 'R1', 4, -1, 0, { resistance: 1000 }),
        comp('R', 'RF', 12, -5, 0, { resistance: 10000 }), comp('OPAMP', 'U1', 12, 0),
        gnd(0, 3), gnd(8, 3), label(18, 0, 'OUT'),
      ],
      wires: [...wire(0, -1, 2, -1), ...wire(6, -1, 9, -1), ...wire(8, -1, 8, -5, 10, -5), ...wire(14, -5, 16, -5, 16, 0), ...wire(15, 0, 18, 0), ...wire(9, 1, 8, 1, 8, 3)],
    }),
    sim: { tStop: 0.003 },
  },
  {
    id: 'noninverting', title: '비반전 증폭기 (연산증폭기)', level: '중급',
    summary: '귀환 분압기로 이득 1 + Rf/Rg 를 얻는 원리',
    build: () => ({
      components: [
        comp('VAC', 'VIN', 4, 3, 0, { amplitude: 0.5, frequency: 1000 }), comp('R', 'RG', 2, -1, 0, { resistance: 1000 }),
        comp('R', 'RF', 12, -5, 0, { resistance: 10000 }), comp('OPAMP', 'U1', 12, 0),
        gnd(4, 5), gnd(0, -1), label(18, 0, 'OUT'),
      ],
      wires: [...wire(4, 1, 9, 1), ...wire(4, -1, 9, -1), ...wire(8, -1, 8, -5, 10, -5), ...wire(14, -5, 16, -5, 16, 0), ...wire(15, 0, 18, 0)],
    }),
    sim: { tStop: 0.003 },
  },
  {
    id: 'integrator', title: '적분기 (구형파 → 삼각파)', level: '응용',
    summary: '연산증폭기와 커패시터로 입력을 시간 적분하는 회로',
    build: () => ({
      components: [
        comp('VPULSE', 'VIN', 0, 1, 0, { low: -1, high: 1, frequency: 500, duty: 50 }), comp('R', 'R1', 4, -1, 0, { resistance: 10000 }),
        comp('C', 'CF', 12, -5, 0, { capacitance: 100e-9 }), comp('OPAMP', 'U1', 12, 0),
        gnd(0, 3), gnd(8, 3), label(18, 0, 'OUT'),
      ],
      wires: [...wire(0, -1, 2, -1), ...wire(6, -1, 9, -1), ...wire(8, -1, 8, -5, 10, -5), ...wire(14, -5, 16, -5, 16, 0), ...wire(15, 0, 18, 0), ...wire(9, 1, 8, 1, 8, 3)],
    }),
    sim: { tStop: 0.008 },
  },
  {
    id: 'ce-amp', title: '공통 이미터 증폭기 (BJT)', level: '응용',
    summary: '바이어스·결합·바이패스 커패시터가 있는 트랜지스터 소신호 증폭기',
    build: () => ({
      components: [
        comp('V', 'VCC', -6, 2, 0, { voltage: 12 }), gnd(-6, 4),
        comp('VAC', 'VIN', -2, 3, 0, { amplitude: 0.005, frequency: 1000 }), gnd(-2, 5),
        comp('C', 'CIN', 0, 0, 0, { capacitance: 10e-6 }),
        comp('R', 'R1', 4, -5, 1, { resistance: 47000 }), comp('R', 'R2', 4, 5, 1, { resistance: 10000 }), gnd(4, 7),
        comp('NPN', 'Q1', 8, 0, 0, { beta: 150 }),
        comp('R', 'RC', 9, -5, 1, { resistance: 2200 }), comp('R', 'RE', 9, 5, 1, { resistance: 470 }), gnd(9, 7),
        comp('C', 'CE', 12, 5, 1, { capacitance: 100e-6 }), gnd(12, 7),
        label(14, -3, 'OUT'),
      ],
      wires: [
        ...wire(-6, 0, -6, -8, 9, -8), ...wire(4, -8, 4, -7), ...wire(9, -8, 9, -7),
        ...wire(-2, 1, -2, 0), ...wire(2, 0, 4, 0, 6, 0), ...wire(4, -3, 4, 3),
        ...wire(9, -3, 9, -2), ...wire(9, 2, 9, 3, 12, 3), ...wire(9, -3, 14, -3),
      ],
    }),
    sim: { tStop: 0.004, initial: 'op' },
  },
  {
    id: 'bjt-switch', title: '트랜지스터 스위치로 LED 켜기', level: '중급',
    summary: '작은 베이스 전류로 큰 컬렉터 전류(LED)를 켜고 끄는 포화/차단 동작',
    build: () => ({
      components: [
        comp('V', 'VCC', 0, 0, 0, { voltage: 5 }), gnd(0, 2),
        comp('SW', 'S1', 4, -5, 1, { closed: false, toggleTime: 0.001 }),
        comp('R', 'RB', 6, -1, 0, { resistance: 10000 }),
        comp('NPN', 'Q1', 10, -1, 0, { beta: 100 }), gnd(11, 1),
        comp('LED', 'D1', 11, -5, 1, { color: 'green' }), comp('R', 'RC', 11, -9, 1, { resistance: 220 }),
      ],
      wires: [...wire(0, -2, 0, -12, 11, -12, 11, -11), ...wire(4, -12, 4, -7), ...wire(4, -3, 4, -1)],
    }),
    sim: { tStop: 0.002 },
  },
  {
    id: 'mosfet-switch', title: 'MOSFET 스위치로 LED 켜기', level: '중급',
    summary: '게이트 전압만으로(게이트 전류 없이) 큰 드레인 전류를 켜고 끄는 로우사이드 스위치',
    build: () => ({
      components: [
        comp('V', 'VDD', 0, 0, 0, { voltage: 5 }), gnd(0, 2),
        comp('VPULSE', 'VG', 2, 3, 0, { low: 0, high: 5, frequency: 200, duty: 50 }), gnd(2, 5),
        comp('R', 'RG', 5, -1, 0, { resistance: 100 }),
        comp('R', 'RPD', 7, 2, 1, { resistance: 100000 }), gnd(7, 4),
        comp('NMOS', 'M1', 10, -1, 0, { vth: 2, k: 0.1, lambda: 0.01 }), gnd(11, 1),
        comp('LED', 'D1', 11, -5, 1, { color: 'green' }), comp('R', 'RL', 11, -9, 1, { resistance: 150 }),
      ],
      wires: [...wire(0, -2, 0, -12, 11, -12, 11, -11), ...wire(2, 1, 2, -1, 3, -1), ...wire(7, -1, 8, -1), ...wire(7, -1, 7, 0)],
    }),
    sim: { tStop: 0.01 },
  },
  {
    id: 'cmos-inverter', title: 'CMOS 인버터 (NOT 게이트)', level: '중급',
    summary: 'PMOS와 NMOS가 번갈아 켜지며 입력을 뒤집는 디지털 회로의 기본 단위',
    build: () => ({
      components: [
        comp('V', 'VDD', -4, -6, 0, { voltage: 5 }), gnd(-4, -4),
        comp('VPULSE', 'VIN', 2, 2, 0, { low: 0, high: 5, frequency: 1000, duty: 50 }), gnd(2, 4),
        comp('PMOS', 'M1', 8, -4, 0, { vth: -1, k: 0.002, lambda: 0.01 }),
        comp('NMOS', 'M2', 8, 4, 0, { vth: 1, k: 0.002, lambda: 0.01 }), gnd(9, 6),
        comp('C', 'CL', 13, 3, 1, { capacitance: 10e-9 }), gnd(13, 5),
        label(16, 0, 'OUT'),
      ],
      wires: [
        ...wire(-4, -8, 9, -8, 9, -6), ...wire(6, -4, 6, 4), ...wire(2, 0, 6, 0),
        ...wire(9, -2, 9, 2), ...wire(9, 0, 13, 0, 16, 0), ...wire(13, 0, 13, 1),
      ],
    }),
    sim: { tStop: 0.003 },
  },
  {
    id: 'nmos-cs-amp', title: '공통 소스 증폭기 (MOSFET)', level: '응용',
    summary: '분압 바이어스로 포화 영역에 둔 MOSFET이 게이트 전압 변화를 증폭하는 원리',
    build: () => ({
      components: [
        comp('V', 'VDD', -6, 2, 0, { voltage: 12 }), gnd(-6, 4),
        comp('VAC', 'VIN', -2, 3, 0, { amplitude: 0.05, frequency: 1000 }), gnd(-2, 5),
        comp('C', 'CIN', 0, 0, 0, { capacitance: 1e-6 }),
        comp('R', 'R1', 4, -5, 1, { resistance: 1e6 }), comp('R', 'R2', 4, 5, 1, { resistance: 470000 }), gnd(4, 7),
        comp('NMOS', 'M1', 8, 0, 0, { vth: 2, k: 0.004, lambda: 0.01 }),
        comp('R', 'RD', 9, -5, 1, { resistance: 4700 }), comp('R', 'RS', 9, 5, 1, { resistance: 1000 }), gnd(9, 7),
        comp('C', 'CS', 12, 5, 1, { capacitance: 100e-6 }), gnd(12, 7),
        label(14, -3, 'OUT'),
      ],
      wires: [
        ...wire(-6, 0, -6, -8, 9, -8), ...wire(4, -8, 4, -7), ...wire(9, -8, 9, -7),
        ...wire(-2, 1, -2, 0), ...wire(2, 0, 4, 0, 6, 0), ...wire(4, -3, 4, 3),
        ...wire(9, -3, 9, -2), ...wire(9, 2, 9, 3, 12, 3), ...wire(9, -3, 14, -3),
      ],
    }),
    sim: { tStop: 0.004, initial: 'op' },
  },
  {
    id: 'jfet-amp', title: 'JFET 자기 바이어스 증폭기', level: '응용',
    summary: '소스 저항의 전압 강하로 게이트를 음(−)으로 만드는 자기 바이어스와 JFET 공통 소스 증폭',
    build: () => ({
      components: [
        comp('V', 'VDD', -6, 2, 0, { voltage: 15 }), gnd(-6, 4),
        comp('VAC', 'VIN', -2, 3, 0, { amplitude: 0.05, frequency: 1000 }), gnd(-2, 5),
        comp('C', 'CIN', 0, 0, 0, { capacitance: 1e-6 }),
        comp('R', 'RG', 4, 5, 1, { resistance: 1e6 }), gnd(4, 7),
        comp('NJF', 'J1', 8, 0, 0, { idss: 0.01, vp: -4, lambda: 0.01 }),
        comp('R', 'RD', 9, -5, 1, { resistance: 2200 }), comp('R', 'RS', 9, 5, 1, { resistance: 470 }), gnd(9, 7),
        comp('C', 'CS', 12, 5, 1, { capacitance: 100e-6 }), gnd(12, 7),
        label(14, -3, 'OUT'),
      ],
      wires: [
        ...wire(-6, 0, -6, -8, 9, -8, 9, -7),
        ...wire(-2, 1, -2, 0), ...wire(2, 0, 4, 0, 6, 0), ...wire(4, 0, 4, 3),
        ...wire(9, -3, 9, -2), ...wire(9, 2, 9, 3, 12, 3), ...wire(9, -3, 14, -3),
      ],
    }),
    sim: { tStop: 0.004, initial: 'op' },
  },
  {
    id: 'wheatstone', title: '휘트스톤 브리지', level: '중급',
    summary: '두 분압기의 차 전압으로 미지 저항을 측정하는 브리지 회로',
    build: () => ({
      components: [
        comp('V', 'V1', 0, 0, 0, { voltage: 10 }),
        comp('R', 'R1', 6, -5, 1, { resistance: 1000 }), comp('R', 'R2', 6, 3, 1, { resistance: 1000 }),
        comp('R', 'R3', 12, -5, 1, { resistance: 1000 }), comp('R', 'RX', 12, 3, 1, { resistance: 1200 }),
        comp('VM', 'VM1', 9, -1), gnd(3, 7),
      ],
      wires: [
        ...wire(0, -2, 0, -8, 12, -8, 12, -7), ...wire(6, -8, 6, -7),
        ...wire(6, -3, 6, 1), ...wire(12, -3, 12, 1), ...wire(6, -1, 7, -1), ...wire(11, -1, 12, -1),
        ...wire(0, 2, 0, 7, 12, 7, 12, 5), ...wire(6, 5, 6, 7),
      ],
    }),
  },
];
