// 회로도 이미지 인식 결과 형식 (서버의 JSON 스키마와 클라이언트 변환에서 공용)

import { parseSI, type CompType, type Props } from '../engine/components';
import type { AbstractCircuit, AbstractComponent } from './layout';

export const RECOGNIZABLE: CompType[] = ['R', 'C', 'L', 'V', 'VAC', 'VPULSE', 'I', 'D', 'LED', 'ZD', 'SW', 'NPN', 'PNP', 'NMOS', 'PMOS', 'NJF', 'PJF', 'OPAMP', 'AM', 'VM'];

/** 소자 종류별 핀 이름 (모델에게 알려주는 이름 → 내부 핀 순서) */
export const PIN_NAMES: Record<string, string[]> = {
  R: ['a', 'b'], L: ['a', 'b'], C: ['pos', 'neg'],
  V: ['pos', 'neg'], VAC: ['pos', 'neg'], VPULSE: ['pos', 'neg'],
  I: ['from', 'to'],
  D: ['anode', 'cathode'], LED: ['anode', 'cathode'], ZD: ['anode', 'cathode'],
  SW: ['a', 'b'], AM: ['pos', 'neg'], VM: ['pos', 'neg'],
  NPN: ['base', 'collector', 'emitter'], PNP: ['base', 'collector', 'emitter'],
  NMOS: ['gate', 'drain', 'source'], PMOS: ['gate', 'drain', 'source'],
  NJF: ['gate', 'drain', 'source'], PJF: ['gate', 'drain', 'source'],
  OPAMP: ['inv', 'noninv', 'out'],
};

export interface RecognizedComponent {
  type: string;
  name: string;
  value: string | null;
  frequency: string | null;
  variant: string | null;
  pins: { pin: string; net: string }[];
  x: number;
  y: number;
  orientation: 'horizontal' | 'vertical';
}

export interface RecognizedCircuit {
  title: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  ground_net: string;
  components: RecognizedComponent[];
  notes: string[];
}

const str = { type: 'string' };
const nullableStr = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const RECOGNITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'confidence', 'ground_net', 'components', 'notes'],
  properties: {
    title: str,
    description: str,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    ground_net: str,
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'name', 'value', 'frequency', 'variant', 'pins', 'x', 'y', 'orientation'],
        properties: {
          type: { type: 'string', enum: RECOGNIZABLE },
          name: str,
          value: nullableStr,
          frequency: nullableStr,
          variant: nullableStr,
          pins: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['pin', 'net'], properties: { pin: str, net: str } },
          },
          x: { type: 'number' },
          y: { type: 'number' },
          orientation: { type: 'string', enum: ['horizontal', 'vertical'] },
        },
      },
    },
    notes: { type: 'array', items: str },
  },
} as const;

function valueOf(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/^[A-Za-z_ ]*=\s*/, '').replace(/\s*(peak|pk|p-p|rms|dc|ac)\s*$/i, '');
  return parseSI(cleaned);
}

/** 인식 결과 → 추상 회로 (자동 배치 입력) */
export function recognizedToAbstract(r: RecognizedCircuit): { circuit: AbstractCircuit; warnings: string[] } {
  const warnings: string[] = [];
  const comps: AbstractComponent[] = [];
  const names = new Set<string>();
  for (const c of r.components) {
    const type = c.type as CompType;
    if (!RECOGNIZABLE.includes(type)) { warnings.push(`알 수 없는 소자 종류 "${c.type}" (${c.name}) 건너뜀`); continue; }
    const pinNames = PIN_NAMES[type];
    const nets = pinNames.map(pn => c.pins.find(p => p.pin.toLowerCase() === pn)?.net ?? '');
    // 핀 이름이 틀렸으면 순서대로 사용
    if (nets.some(n => !n) && c.pins.length >= pinNames.length) c.pins.slice(0, pinNames.length).forEach((p, i) => { if (!nets[i]) nets[i] = p.net; });
    if (nets.some(n => !n)) { warnings.push(`${c.name}: 핀 연결 정보가 부족해 건너뜀`); continue; }
    let name = c.name || type;
    while (names.has(name)) name += "'";
    names.add(name);
    const v = valueOf(c.value);
    const props: Props = {};
    const variant = (c.variant ?? '').toLowerCase();
    switch (type) {
      case 'R': if (v !== null) props.resistance = v; break;
      case 'C': if (v !== null) props.capacitance = v; break;
      case 'L': if (v !== null) props.inductance = v; break;
      case 'V': if (v !== null) props.voltage = v; break;
      case 'I': if (v !== null) props.current = v; break;
      case 'VAC': {
        if (v !== null) props.amplitude = /rms/i.test(c.value ?? '') ? v * Math.SQRT2 : v;
        const fr = valueOf(c.frequency); if (fr !== null) props.frequency = fr;
        break;
      }
      case 'VPULSE': {
        if (v !== null) props.high = v;
        const fr = valueOf(c.frequency); if (fr !== null) props.frequency = fr;
        break;
      }
      case 'ZD': if (v !== null) props.vz = v; break;
      case 'NPN': case 'PNP': if (v !== null && v > 1) props.beta = v; break;
      case 'NMOS': case 'PMOS': if (v !== null) props.vth = type === 'PMOS' ? -Math.abs(v) : Math.abs(v); break;
      case 'NJF': case 'PJF': if (v !== null) props.idss = Math.abs(v); break;
      case 'LED': {
        const col = ['red', 'yellow', 'green', 'blue', 'white'].find(k => variant.includes(k)) ?? (/빨|적/.test(variant) ? 'red' : /초록|녹/.test(variant) ? 'green' : /파랑|청/.test(variant) ? 'blue' : /노랑|황/.test(variant) ? 'yellow' : undefined);
        if (col) props.color = col;
        break;
      }
      case 'D': if (/schottky|쇼트키/.test(variant)) props.model = 'schottky'; else if (/400|rect|정류/.test(variant)) props.model = 'rect'; break;
      case 'SW': props.closed = !/open|열림|off/.test(variant); break;
    }
    if (c.value && v === null && !['D', 'LED', 'SW', 'OPAMP', 'AM', 'VM'].includes(type)) warnings.push(`${name}: 값 "${c.value}"를 해석하지 못해 기본값을 사용`);
    comps.push({
      type, name, props, nets,
      x: Math.min(1, Math.max(0, c.x > 1 ? c.x / 100 : c.x)),
      y: Math.min(1, Math.max(0, c.y > 1 ? c.y / 100 : c.y)),
      orientation: c.orientation,
    });
  }
  return { circuit: { components: comps, groundNets: r.ground_net ? [r.ground_net] : [] }, warnings };
}
