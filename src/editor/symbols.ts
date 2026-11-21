// 회로 기호 SVG (로컬 좌표, 1 격자 = 20px). 회전/반전은 그룹 transform 으로 적용.

import { isTransistor, type Component, type CompType } from '../engine/components';

export const G = 20;

const LED_COLORS: Record<string, string> = { red: '#ef4444', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', white: '#e5e7eb' };

const line = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
const plus = (x: number, y: number, s = 4) => `<path class="sign" d="M${x - s} ${y}H${x + s}M${x} ${y - s}V${y + s}"/>`;
const minus = (x: number, y: number, s = 4) => `<path class="sign" d="M${x - s} ${y}H${x + s}"/>`;

/** 소자 몸체 (선 굵기·색은 CSS 로) */
export function symbolBody(c: Component, lit = 0): string {
  const t = c.type;
  switch (t) {
    case 'R': {
      let d = 'M-40 0H-24';
      const n = 6, w = 48 / n;
      for (let i = 0; i < n; i++) d += `L${-24 + w * (i + 0.5)} ${i % 2 ? 8 : -8}`;
      d += 'L24 0H40';
      return `<path d="${d}"/>`;
    }
    case 'C':
      return line(-40, 0, -5, 0) + line(5, 0, 40, 0) + `<path class="thick" d="M-5 -15V15M5 -15V15"/>` + plus(-14, -12, 3);
    case 'L': {
      let d = 'M-40 0H-24';
      for (let i = 0; i < 4; i++) d += `a6 6 0 0 1 12 0`;
      d += 'H40';
      return `<path d="${d}"/>`;
    }
    case 'V':
      return line(0, -40, 0, -4) + line(0, 5, 0, 40) + `<path class="thick" d="M-16 -4H16"/><path class="thick" d="M-8 5H8"/>` + plus(14, -14, 3.5) + minus(14, 14, 3.5);
    case 'VAC':
      return line(0, -40, 0, -18) + line(0, 18, 0, 40) + `<circle r="18" class="body"/><path d="M-10 0c3 -10 7 -10 10 0s7 10 10 0"/>` + plus(0, -26 + 2, 3) ;
    case 'VPULSE':
      return line(0, -40, 0, -18) + line(0, 18, 0, 40) + `<circle r="18" class="body"/><path d="M-11 6H-5V-6H3V6H9V-6"/>` + plus(0, -24, 3);
    case 'I':
      return line(0, -40, 0, -18) + line(0, 18, 0, 40) + `<circle r="18" class="body"/><path d="M0 11V-9M-5 -3L0 -10L5 -3"/>`;
    case 'D': case 'LED': case 'ZD': {
      let s = line(-40, 0, -10, 0) + line(10, 0, 40, 0);
      const fill = t === 'LED' ? `style="fill:${lit > 0 ? LED_COLORS[String(c.props.color)] ?? '#ef4444' : 'var(--bg)'}"` : 'class="solid"';
      s += `<path d="M-10 -11L10 0L-10 11Z" ${fill}/>`;
      s += t === 'ZD' ? `<path class="thick" d="M15 -14L10 -11V11L5 14"/>` : `<path class="thick" d="M10 -11V11"/>`;
      if (t === 'LED') s += `<path d="M2 -14l8 -9M6 -23h4v4M10 -11l8 -9M14 -20h4v4"/>`;
      return s;
    }
    case 'SW': {
      const closed = !!c.props.closed;
      return line(-40, 0, -14, 0) + line(14, 0, 40, 0) + `<circle cx="-14" r="2.5" class="solid"/><circle cx="14" r="2.5" class="solid"/>` +
        (closed ? line(-14, 0, 14, -1) : line(-14, 0, 12, -14));
    }
    case 'NPN': case 'PNP': {
      const npn = t === 'NPN';
      // 핀: B(-40,0), NPN: C(20,-40) E(20,40) / PNP: E(20,-40) C(20,40)
      let s = `<circle cx="4" r="22" class="body"/>` + line(-40, 0, -8, 0) + `<path class="thick" d="M-8 -13V13"/>`;
      s += `<path d="M-8 -6L20 -24V-40M-8 6L20 24V40"/>`;
      // 이미터 화살표
      s += npn ? `<path class="solid" d="M14 20.2L6 19.5L10 13Z"/>` : `<path class="solid" d="M-2 -12.3L6 -13.6L2 -19.5Z"/>`;
      return s;
    }
    case 'NMOS': case 'PMOS': {
      // 증가형 MOSFET: 절연된 게이트 판, 끊어진 채널 3조각, 바디는 소스에 연결
      const n = t === 'NMOS';
      // N: 드레인 위(20,-40), 소스 아래(20,40) / P: 소스 위, 드레인 아래
      let s = `<circle cx="4" r="24" class="body"/>` + line(-40, 0, -12, 0) + `<path class="thick" d="M-12 -12V12"/>`;
      s += `<path class="thick" d="M-5 -15V-7M-5 -4V4M-5 7V15"/>`;
      s += `<path d="M-5 -11H20V-40M-5 11H20V40M-5 0H20V${n ? 11 : -11}"/>`; // 바디–소스 연결
      // 바디 화살표: N채널은 채널 쪽(안쪽), P채널은 바깥쪽
      s += n ? `<path class="solid" d="M-4 0L4 -4.5V4.5Z"/>` : `<path class="solid" d="M14 0L6 -4.5V4.5Z"/>`;
      return s;
    }
    case 'NJF': case 'PJF': {
      const n = t === 'NJF';
      let s = `<circle cx="4" r="24" class="body"/>` + `<path class="thick" d="M-4 -15V15"/>`;
      s += `<path d="M-40 0H-4M-4 -10H20V-40M-4 10H20V40"/>`;
      // 게이트 화살표: N채널은 게이트→채널(안쪽), P채널은 바깥쪽
      s += n ? `<path class="solid" d="M-5 0L-14 -4.5V4.5Z"/>` : `<path class="solid" d="M-22 0L-13 -4.5V4.5Z"/>`;
      return s;
    }
    case 'OPAMP':
      return `<path class="body" d="M-40 -40L40 0L-40 40Z"/>` + line(-60, -20, -40, -20) + line(-60, 20, -40, 20) + line(40, 0, 60, 0) +
        minus(-30, -20, 4) + plus(-30, 20, 4);
    case 'AM': case 'VM':
      return line(-40, 0, -16, 0) + line(16, 0, 40, 0) + `<circle r="16" class="body"/>` + plus(-24, -9, 3);
    case 'GND':
      return `<path d="M0 0V10M-12 10H12M-7 15H7M-2.5 20H2.5"/>`;
    case 'LABEL':
      return `<path d="M0 0H6"/><path class="tag" d="M6 -8H46L54 0L46 8H6Z"/>`;
  }
}

/** 회전과 무관하게 똑바로 써야 하는 글자 (로컬 좌표) */
export function symbolTexts(c: Component): { x: number; y: number; text: string; cls?: string }[] {
  switch (c.type) {
    case 'AM': return [{ x: 0, y: 0, text: 'A', cls: 'sym-letter' }];
    case 'VM': return [{ x: 0, y: 0, text: 'V', cls: 'sym-letter' }];
    case 'LABEL': return [{ x: 28, y: 0, text: String(c.props.net ?? ''), cls: 'net-text' }];
    default: return [];
  }
}

/** 선택·클릭 판정용 영역 (로컬 좌표) */
export function hitBox(t: CompType): [number, number, number, number] {
  switch (t) {
    case 'V': case 'VAC': case 'VPULSE': case 'I': return [-20, -40, 40, 80];
    case 'NPN': case 'PNP': case 'NMOS': case 'PMOS': case 'NJF': case 'PJF': return [-40, -40, 70, 80];
    case 'OPAMP': return [-60, -40, 120, 80];
    case 'GND': return [-14, -4, 28, 28];
    case 'LABEL': return [-2, -10, 58, 20];
    default: return [-40, -16, 80, 32];
  }
}

/** 이름/값 라벨 위치 (화면 좌표 오프셋, 회전 고려) */
export function labelAnchor(c: Component): { name: [number, number, string]; value: [number, number, string] } {
  const vertical = ['V', 'VAC', 'VPULSE', 'I'].includes(c.type) ? c.rot % 2 === 0 : c.rot % 2 === 1;
  if (isTransistor(c.type)) return { name: [32, -4, 'start'], value: [32, 12, 'start'] };
  if (c.type === 'OPAMP') return { name: [0, -46, 'middle'], value: [0, 56, 'middle'] };
  if (vertical) return { name: [24, -4, 'start'], value: [24, 12, 'start'] };
  return { name: [0, -22, 'middle'], value: [0, 32, 'middle'] };
}
