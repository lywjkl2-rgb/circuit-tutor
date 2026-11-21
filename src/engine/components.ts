// 소자 정의: 핀 위치(격자 단위), 기본 속성, 속성 편집 스키마.
// 편집기·넷리스트 추출·시뮬레이터·해설 엔진이 모두 이 정의를 공유한다.

export type CompType =
  | 'R' | 'C' | 'L'
  | 'V' | 'VAC' | 'VPULSE' | 'I'
  | 'D' | 'LED' | 'ZD'
  | 'SW'
  | 'NPN' | 'PNP'
  | 'NMOS' | 'PMOS' | 'NJF' | 'PJF'
  | 'OPAMP'
  | 'AM' | 'VM'
  | 'GND' | 'LABEL';

export type PropValue = number | string | boolean;
export type Props = Record<string, PropValue>;

export interface PinDef { name: string; x: number; y: number }

export interface PropSchema {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'boolean' | 'text';
  unit?: string;
  options?: { value: string; label: string }[];
  optional?: boolean;
  hint?: string;
}

export interface CompDef {
  type: CompType;
  label: string;        // 한국어 이름
  prefix: string;       // 이름 접두사 (R1, C1 ...)
  pins: PinDef[];
  defaults: Props;
  schema: PropSchema[];
  category: '수동 소자' | '전원' | '반도체' | '능동 소자' | '스위치·계측' | '연결';
  shortcut?: string;
}

const two = (a: string, b: string): PinDef[] => [
  { name: a, x: -2, y: 0 },
  { name: b, x: 2, y: 0 },
];
const vertical = (a: string, b: string): PinDef[] => [
  { name: a, x: 0, y: -2 },
  { name: b, x: 0, y: 2 },
];

export const COMPONENTS: Record<CompType, CompDef> = {
  R: {
    type: 'R', label: '저항', prefix: 'R', pins: two('1', '2'), category: '수동 소자', shortcut: '1',
    defaults: { resistance: 1000 },
    schema: [{ key: 'resistance', label: '저항값', kind: 'number', unit: 'Ω' }],
  },
  C: {
    type: 'C', label: '커패시터', prefix: 'C', pins: two('+', '−'), category: '수동 소자', shortcut: '2',
    defaults: { capacitance: 1e-6, ic: 0 },
    schema: [
      { key: 'capacitance', label: '정전용량', kind: 'number', unit: 'F' },
      { key: 'ic', label: '초기 전압', kind: 'number', unit: 'V', hint: '과도 해석을 0에서 시작할 때 사용' },
    ],
  },
  L: {
    type: 'L', label: '인덕터', prefix: 'L', pins: two('1', '2'), category: '수동 소자', shortcut: '3',
    defaults: { inductance: 1e-3, ic: 0 },
    schema: [
      { key: 'inductance', label: '인덕턴스', kind: 'number', unit: 'H' },
      { key: 'ic', label: '초기 전류', kind: 'number', unit: 'A' },
    ],
  },
  V: {
    type: 'V', label: '직류 전압원', prefix: 'V', pins: vertical('+', '−'), category: '전원', shortcut: '4',
    defaults: { voltage: 5 },
    schema: [{ key: 'voltage', label: '전압', kind: 'number', unit: 'V' }],
  },
  VAC: {
    type: 'VAC', label: '교류 전압원(사인파)', prefix: 'V', pins: vertical('+', '−'), category: '전원',
    defaults: { amplitude: 5, frequency: 60, offset: 0, phase: 0 },
    schema: [
      { key: 'amplitude', label: '진폭(피크)', kind: 'number', unit: 'V' },
      { key: 'frequency', label: '주파수', kind: 'number', unit: 'Hz' },
      { key: 'offset', label: '직류 오프셋', kind: 'number', unit: 'V' },
      { key: 'phase', label: '위상', kind: 'number', unit: '°' },
    ],
  },
  VPULSE: {
    type: 'VPULSE', label: '구형파 전압원', prefix: 'V', pins: vertical('+', '−'), category: '전원',
    defaults: { low: 0, high: 5, frequency: 100, duty: 50 },
    schema: [
      { key: 'low', label: 'Low 전압', kind: 'number', unit: 'V' },
      { key: 'high', label: 'High 전압', kind: 'number', unit: 'V' },
      { key: 'frequency', label: '주파수', kind: 'number', unit: 'Hz' },
      { key: 'duty', label: '듀티비', kind: 'number', unit: '%' },
    ],
  },
  I: {
    type: 'I', label: '직류 전류원', prefix: 'I', pins: [{ name: 'in', x: 0, y: 2 }, { name: 'out', x: 0, y: -2 }],
    category: '전원', shortcut: '5',
    defaults: { current: 1e-3 },
    schema: [{ key: 'current', label: '전류 (화살표 방향)', kind: 'number', unit: 'A' }],
  },
  D: {
    type: 'D', label: '다이오드', prefix: 'D', pins: two('A', 'K'), category: '반도체', shortcut: '6',
    defaults: { model: 'si' },
    schema: [{
      key: 'model', label: '모델', kind: 'select', options: [
        { value: 'si', label: '소신호 실리콘 (1N4148 계열, ≈0.65V)' },
        { value: 'rect', label: '정류용 (1N4007 계열, ≈0.7V)' },
        { value: 'schottky', label: '쇼트키 (≈0.3V)' },
      ],
    }],
  },
  LED: {
    type: 'LED', label: 'LED', prefix: 'D', pins: two('A', 'K'), category: '반도체',
    defaults: { color: 'red' },
    schema: [{
      key: 'color', label: '색상', kind: 'select', options: [
        { value: 'red', label: '빨강 (≈1.8V)' },
        { value: 'yellow', label: '노랑 (≈2.0V)' },
        { value: 'green', label: '초록 (≈2.2V)' },
        { value: 'blue', label: '파랑 (≈3.0V)' },
        { value: 'white', label: '흰색 (≈3.1V)' },
      ],
    }],
  },
  ZD: {
    type: 'ZD', label: '제너 다이오드', prefix: 'D', pins: two('A', 'K'), category: '반도체',
    defaults: { vz: 5.1 },
    schema: [{ key: 'vz', label: '제너 전압', kind: 'number', unit: 'V' }],
  },
  SW: {
    type: 'SW', label: '스위치', prefix: 'S', pins: two('1', '2'), category: '스위치·계측', shortcut: '9',
    defaults: { closed: true, toggleTime: '' },
    schema: [
      { key: 'closed', label: '초기 상태: 닫힘', kind: 'boolean' },
      { key: 'toggleTime', label: '전환 시각', kind: 'number', unit: 's', optional: true, hint: '과도 해석 중 이 시각에 상태가 뒤바뀜 (비우면 고정)' },
    ],
  },
  NPN: {
    type: 'NPN', label: 'NPN 트랜지스터', prefix: 'Q',
    pins: [{ name: 'B', x: -2, y: 0 }, { name: 'C', x: 1, y: -2 }, { name: 'E', x: 1, y: 2 }],
    category: '반도체', shortcut: '7',
    defaults: { beta: 100 },
    schema: [{ key: 'beta', label: '전류 증폭률 β', kind: 'number' }],
  },
  PNP: {
    type: 'PNP', label: 'PNP 트랜지스터', prefix: 'Q',
    pins: [{ name: 'B', x: -2, y: 0 }, { name: 'C', x: 1, y: 2 }, { name: 'E', x: 1, y: -2 }],
    category: '반도체',
    defaults: { beta: 100 },
    schema: [{ key: 'beta', label: '전류 증폭률 β', kind: 'number' }],
  },
  NMOS: {
    type: 'NMOS', label: 'N채널 MOSFET', prefix: 'M',
    pins: [{ name: 'G', x: -2, y: 0 }, { name: 'D', x: 1, y: -2 }, { name: 'S', x: 1, y: 2 }],
    category: '반도체',
    defaults: { vth: 2, k: 0.01, lambda: 0.01 },
    schema: [
      { key: 'vth', label: '문턱 전압 V_th', kind: 'number', unit: 'V' },
      { key: 'k', label: '전도 계수 k = μCox·W/L', kind: 'number', unit: 'A/V²', hint: '포화 전류 I_D = ½k(V_GS − V_th)²' },
      { key: 'lambda', label: '채널 길이 변조 λ', kind: 'number', unit: '1/V' },
    ],
  },
  PMOS: {
    type: 'PMOS', label: 'P채널 MOSFET', prefix: 'M',
    pins: [{ name: 'G', x: -2, y: 0 }, { name: 'D', x: 1, y: 2 }, { name: 'S', x: 1, y: -2 }],
    category: '반도체',
    defaults: { vth: -2, k: 0.01, lambda: 0.01 },
    schema: [
      { key: 'vth', label: '문턱 전압 V_th (음수)', kind: 'number', unit: 'V' },
      { key: 'k', label: '전도 계수 k = μCox·W/L', kind: 'number', unit: 'A/V²', hint: '포화 전류 |I_D| = ½k(V_SG − |V_th|)²' },
      { key: 'lambda', label: '채널 길이 변조 λ', kind: 'number', unit: '1/V' },
    ],
  },
  NJF: {
    type: 'NJF', label: 'N채널 JFET', prefix: 'J',
    pins: [{ name: 'G', x: -2, y: 0 }, { name: 'D', x: 1, y: -2 }, { name: 'S', x: 1, y: 2 }],
    category: '반도체',
    defaults: { idss: 0.01, vp: -2, lambda: 0.01 },
    schema: [
      { key: 'idss', label: '포화 드레인 전류 I_DSS', kind: 'number', unit: 'A', hint: 'V_GS = 0 일 때의 포화 전류' },
      { key: 'vp', label: '핀치오프 전압 V_P (음수)', kind: 'number', unit: 'V' },
      { key: 'lambda', label: '채널 길이 변조 λ', kind: 'number', unit: '1/V' },
    ],
  },
  PJF: {
    type: 'PJF', label: 'P채널 JFET', prefix: 'J',
    pins: [{ name: 'G', x: -2, y: 0 }, { name: 'D', x: 1, y: 2 }, { name: 'S', x: 1, y: -2 }],
    category: '반도체',
    defaults: { idss: 0.01, vp: 2, lambda: 0.01 },
    schema: [
      { key: 'idss', label: '포화 드레인 전류 I_DSS', kind: 'number', unit: 'A', hint: 'V_GS = 0 일 때의 포화 전류 크기' },
      { key: 'vp', label: '핀치오프 전압 V_P (양수)', kind: 'number', unit: 'V' },
      { key: 'lambda', label: '채널 길이 변조 λ', kind: 'number', unit: '1/V' },
    ],
  },
  OPAMP: {
    type: 'OPAMP', label: '연산 증폭기', prefix: 'U',
    pins: [{ name: '−', x: -3, y: -1 }, { name: '+', x: -3, y: 1 }, { name: 'out', x: 3, y: 0 }],
    category: '능동 소자', shortcut: '8',
    defaults: { gain: 1e5, vsat: 15 },
    schema: [
      { key: 'gain', label: '개루프 이득 A', kind: 'number' },
      { key: 'vsat', label: '포화 전압 ±', kind: 'number', unit: 'V' },
    ],
  },
  AM: {
    type: 'AM', label: '전류계', prefix: 'A', pins: two('+', '−'), category: '스위치·계측',
    defaults: {}, schema: [],
  },
  VM: {
    type: 'VM', label: '전압계', prefix: 'VM', pins: two('+', '−'), category: '스위치·계측',
    defaults: {}, schema: [],
  },
  GND: {
    type: 'GND', label: '접지', prefix: 'GND', pins: [{ name: 'g', x: 0, y: 0 }], category: '연결', shortcut: '0',
    defaults: {}, schema: [],
  },
  LABEL: {
    type: 'LABEL', label: '넷 라벨', prefix: 'N', pins: [{ name: 'n', x: 0, y: 0 }], category: '연결',
    defaults: { net: 'OUT' },
    schema: [{ key: 'net', label: '넷 이름 (같은 이름끼리 연결)', kind: 'text' }],
  },
};

/** 3단자 트랜지스터 분류 */
export const BJT_TYPES: CompType[] = ['NPN', 'PNP'];
export const FET_TYPES: CompType[] = ['NMOS', 'PMOS', 'NJF', 'PJF'];
export const TRANSISTOR_TYPES: CompType[] = [...BJT_TYPES, ...FET_TYPES];
export const isFet = (t: string) => (FET_TYPES as string[]).includes(t);
export const isTransistor = (t: string) => (TRANSISTOR_TYPES as string[]).includes(t);

/** 회로를 구성하는 배치된 소자 */
export interface Component {
  id: string;
  type: CompType;
  name: string;
  x: number;
  y: number;
  rot: number;    // 0..3 (90° 단위, 시계방향)
  flip?: boolean; // 상하 반전 (회전 전에 적용)
  props: Props;
}

export interface Wire { id: string; x1: number; y1: number; x2: number; y2: number }

export interface Schematic { components: Component[]; wires: Wire[] }

export function transformPoint(px: number, py: number, rot: number, flip?: boolean): [number, number] {
  let x = px, y = flip ? -py : py;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) {
    const nx = -y, ny = x;
    x = nx; y = ny;
  }
  return [x + 0, y + 0];
}

export function pinPositions(c: Component): { name: string; x: number; y: number }[] {
  return COMPONENTS[c.type].pins.map(p => {
    const [dx, dy] = transformPoint(p.x, p.y, c.rot, c.flip);
    return { name: p.name, x: c.x + dx, y: c.y + dy };
  });
}

export function num(props: Props, key: string, fallback = 0): number {
  const v = props[key];
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const p = parseSI(v);
    if (p !== null) return p;
  }
  return fallback;
}

const SI_PREFIX: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, meg: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

/** "4.7k", "10u", "2.2MΩ", "100 nF", "1meg" 같은 문자열을 숫자로 */
export function parseSI(text: string): number | null {
  const s = text.trim().replace(/,/g, '');
  // RKM 표기: 4k7 = 4.7k, 2R2 = 2.2, 1M5 = 1.5M, 4u7 = 4.7µ
  const rkm = s.match(/^(\d+)([RrkKMmuµμnp])(\d+)\s*([a-zA-ZΩΩ]*)$/);
  if (rkm) {
    const base = parseFloat(`${rkm[1]}.${rkm[3]}`);
    const p = rkm[2] === 'R' || rkm[2] === 'r' ? 1 : SI_PREFIX[rkm[2]];
    return base * p;
  }
  const m = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(meg|MEG|Meg|[TGMkKmuµμnpf])?\s*([a-zA-ZΩΩ°%]*)$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2]) v *= SI_PREFIX[m[2].toLowerCase() === 'meg' ? 'meg' : m[2]];
  return isFinite(v) ? v : null;
}

const PREFIXES: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

/** 3자리 유효숫자 SI 표기: 0.0025 → "2.50 m" */
export function formatSI(v: number, unit = '', digits = 3): string {
  if (!isFinite(v)) return `${v} ${unit}`.trim();
  if (Math.abs(v) < 1e-15) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  for (const [scale, p] of PREFIXES) {
    if (a >= scale * 0.9995) {
      const x = v / scale;
      const s = Math.abs(x) >= Math.pow(10, digits) - 0.5 ? Math.round(x).toString() : x.toPrecision(digits);
      return `${trimZeros(s)} ${p}${unit}`.trim();
    }
  }
  return `${trimZeros((v / 1e-15).toPrecision(digits))} f${unit}`;
}

function trimZeros(s: string): string {
  if (s.includes('e')) return s;
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 소자 값 요약 문자열 (회로도 라벨용) */
export function valueLabel(c: Component): string {
  const p = c.props;
  switch (c.type) {
    case 'R': return formatSI(num(p, 'resistance'), 'Ω');
    case 'C': return formatSI(num(p, 'capacitance'), 'F');
    case 'L': return formatSI(num(p, 'inductance'), 'H');
    case 'V': return formatSI(num(p, 'voltage'), 'V');
    case 'VAC': return `${formatSI(num(p, 'amplitude'), 'V')} ${formatSI(num(p, 'frequency'), 'Hz')}`;
    case 'VPULSE': return `${formatSI(num(p, 'low'), 'V')}↔${formatSI(num(p, 'high'), 'V')} ${formatSI(num(p, 'frequency'), 'Hz')}`;
    case 'I': return formatSI(num(p, 'current'), 'A');
    case 'ZD': return `Vz=${formatSI(num(p, 'vz'), 'V')}`;
    case 'LED': return String(p.color ?? '');
    case 'NPN': case 'PNP': return `β=${num(p, 'beta', 100)}`;
    case 'NMOS': case 'PMOS': return `Vth=${formatSI(num(p, 'vth'), 'V')}`;
    case 'NJF': case 'PJF': return `IDSS=${formatSI(num(p, 'idss'), 'A')}`;
    case 'SW': return p.closed ? '닫힘' : '열림';
    case 'LABEL': return String(p.net ?? '');
    default: return '';
  }
}
