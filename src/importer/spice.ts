// 간단한 SPICE 넷리스트 파서 → 추상 회로

import type { CompType, Props } from '../engine/components';
import type { AbstractCircuit, AbstractComponent } from './layout';

/** SPICE 숫자: M/m = 밀리, MEG = 메가 */
export function spiceNum(tok: string): number | null {
  const m = tok.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([a-zA-Zµ]*)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  if (suf.startsWith('meg')) v *= 1e6;
  else if (suf.startsWith('mil')) v *= 25.4e-6;
  else {
    const scale: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, g: 1e9, t: 1e12 };
    if (suf && scale[suf[0]] !== undefined) v *= scale[suf[0]];
  }
  return isFinite(v) ? v : null;
}

export interface SpiceParseResult { circuit: AbstractCircuit; warnings: string[]; title?: string }

export function parseSpice(text: string): SpiceParseResult {
  const warnings: string[] = [];
  const comps: AbstractComponent[] = [];
  // 이어지는 줄(+) 합치기
  const raw = text.replace(/\r/g, '').split('\n');
  const lines: string[] = [];
  for (const l of raw) {
    if (/^\s*\+/.test(l) && lines.length) lines[lines.length - 1] += ' ' + l.replace(/^\s*\+/, '');
    else lines.push(l);
  }
  const models = new Map<string, string>(); // 모델 이름 → 모델 문장
  for (const l of lines) {
    const m = l.trim().match(/^\.model\s+(\S+)\s+(.*)$/i);
    if (m) models.set(m[1].toLowerCase(), m[2]);
  }
  let title: string | undefined;
  lines.forEach((line, idx) => {
    const l = line.replace(/[;$].*$/, '').trim();
    if (!l || l.startsWith('*') || l.startsWith('.')) return;
    const tok = l.split(/\s+/);
    const name = tok[0];
    const letter = name[0].toUpperCase();
    const push = (type: CompType, nets: string[], props: Props) => comps.push({ type, name, nets, props });
    const val = (t?: string) => (t === undefined ? null : spiceNum(t));
    try {
      if (tok.length < 3) throw new Error('too short');
      switch (letter) {
        case 'R': case 'C': case 'L': {
          const v = val(tok[3]);
          if (v === null) throw new Error();
          const key = letter === 'R' ? 'resistance' : letter === 'C' ? 'capacitance' : 'inductance';
          const ic = l.match(/ic\s*=\s*(\S+)/i);
          push(letter as CompType, [tok[1], tok[2]], { [key]: v, ...(ic ? { ic: spiceNum(ic[1]) ?? 0 } : {}) });
          break;
        }
        case 'V': case 'I': {
          const rest = tok.slice(3).join(' ');
          const sin = rest.match(/sin\s*\(([^)]*)\)/i);
          const pulse = rest.match(/pulse\s*\(([^)]*)\)/i);
          if (letter === 'V' && sin) {
            const a = sin[1].trim().split(/[\s,]+/).map(t => spiceNum(t) ?? 0);
            push('VAC', [tok[1], tok[2]], { offset: a[0] ?? 0, amplitude: a[1] ?? 1, frequency: a[2] ?? 60, phase: a[5] ?? 0 });
          } else if (letter === 'V' && pulse) {
            const a = pulse[1].trim().split(/[\s,]+/).map(t => spiceNum(t) ?? 0);
            const per = a[6] || 1e-3, pw = a[5] || per / 2;
            push('VPULSE', [tok[1], tok[2]], { low: a[0] ?? 0, high: a[1] ?? 5, frequency: 1 / per, duty: Math.round((pw / per) * 100) });
          } else {
            const dc = rest.match(/dc\s+(\S+)/i);
            const v = dc ? spiceNum(dc[1]) : val(tok[3]);
            if (v === null) throw new Error();
            push(letter === 'V' ? 'V' : 'I', [tok[1], tok[2]], letter === 'V' ? { voltage: v } : { current: v });
          }
          break;
        }
        case 'D': {
          const model = (tok[3] ?? '').toLowerCase();
          const stmt = models.get(model) ?? '';
          const bv = stmt.match(/bv\s*=\s*(\S+)/i);
          if (/led/.test(model) || /led/i.test(stmt)) {
            const color = /blue/.test(model) ? 'blue' : /green/.test(model) ? 'green' : /yellow/.test(model) ? 'yellow' : /white/.test(model) ? 'white' : 'red';
            push('LED', [tok[1], tok[2]], { color });
          } else if (bv || /zener|^z|bz/.test(model)) {
            push('ZD', [tok[1], tok[2]], { vz: bv ? spiceNum(bv[1]) ?? 5.1 : 5.1 });
          } else {
            push('D', [tok[1], tok[2]], { model: /schottky|bat|1n58/.test(model) ? 'schottky' : /1n400/.test(model) ? 'rect' : 'si' });
          }
          break;
        }
        case 'Q': {
          const model = (tok[4] ?? '').toLowerCase();
          const stmt = (models.get(model) ?? '').toLowerCase();
          const pnp = /pnp/.test(stmt) || /pnp|3906|bc55/.test(model);
          const bf = stmt.match(/bf\s*=\s*(\S+)/);
          // SPICE: Q c b e → 내부 핀 순서 [B, C, E]
          push(pnp ? 'PNP' : 'NPN', [tok[2], tok[1], tok[3]], { beta: bf ? spiceNum(bf[1]) ?? 100 : 100 });
          break;
        }
        case 'M': {
          // M이름 D G S [B] 모델 [W= L=] → 내부 핀 [G, D, S] (바디는 소스에 연결된 것으로 간주)
          const rest = tok.slice(4);
          const modelTok = (rest.find(t => !t.includes('=') && models.has(t.toLowerCase())) ?? rest.find(t => !t.includes('=') && !/^\d/.test(t)) ?? '').toLowerCase();
          const stmt = (models.get(modelTok) ?? '').toLowerCase();
          const pmos = /pmos/.test(stmt) || /^p|pmos/.test(modelTok);
          const par = (k: string, src: string) => { const mm = src.match(new RegExp(`\\b${k}\\s*=\\s*([^\\s)]+)`, 'i')); return mm ? spiceNum(mm[1]) : null; };
          const vto = par('vto', stmt), kp = par('kp', stmt), lam = par('lambda', stmt);
          const inst = tok.slice(4).join(' ');
          const w = par('w', inst) ?? 1, l = par('l', inst) ?? 1;
          const props: Props = {};
          if (vto !== null) props.vth = pmos ? -Math.abs(vto) : Math.abs(vto);
          if (kp !== null) props.k = (kp * w) / l;
          if (lam !== null) props.lambda = lam;
          push(pmos ? 'PMOS' : 'NMOS', [tok[2], tok[1], tok[3]], props);
          break;
        }
        case 'J': {
          // J이름 D G S 모델 → 내부 핀 [G, D, S]
          const modelTok = (tok[4] ?? '').toLowerCase();
          const stmt = (models.get(modelTok) ?? '').toLowerCase();
          const pjf = /pjf/.test(stmt) || /^p|pjf/.test(modelTok);
          const par = (k: string) => { const mm = stmt.match(new RegExp(`\\b${k}\\s*=\\s*([^\\s)]+)`, 'i')); return mm ? spiceNum(mm[1]) : null; };
          const vto = par('vto'), beta = par('beta'), lam = par('lambda');
          const props: Props = {};
          const vp = vto !== null ? Math.abs(vto) : 2;
          if (vto !== null) props.vp = pjf ? vp : -vp;
          if (beta !== null) props.idss = beta * vp * vp; // SPICE: Id = β(VGS − VTO)²
          if (lam !== null) props.lambda = lam;
          push(pjf ? 'PJF' : 'NJF', [tok[2], tok[1], tok[3]], props);
          break;
        }
        case 'X': case 'U': case 'E': {
          // X/U: in+ in- out  또는 in+ in- V+ V- out (741 계열)
          const nodes = tok.slice(1).filter(t => !/^(opamp|ua741|lm741|lm358|tl07\d|ideal.*)$/i.test(t) && !t.includes('='));
          if (letter === 'E') {
            push('OPAMP', [tok[4], tok[3], tok[1]], {});
          } else if (nodes.length >= 5) push('OPAMP', [nodes[1], nodes[0], nodes[4]], {});
          else if (nodes.length >= 3) push('OPAMP', [nodes[1], nodes[0], nodes[2]], {});
          else throw new Error();
          break;
        }
        case 'S': {
          const closed = !/off|open/i.test(tok.slice(3).join(' '));
          push('SW', [tok[1], tok[2]], { closed, toggleTime: '' });
          break;
        }
        default:
          if (idx === 0) { title = l; return; }
          warnings.push(`${idx + 1}행을 해석하지 못해 건너뜀: ${l}`);
      }
    } catch {
      if (idx === 0) { title = l; return; }
      warnings.push(`${idx + 1}행을 해석하지 못해 건너뜀: ${l}`);
    }
  });
  return { circuit: { components: comps }, warnings, title };
}

/** 회로도 → SPICE 넷리스트 텍스트 (내보내기) */
export function toSpice(net: { nodeNames: string[]; elements: { type: CompType; name: string; nodes: number[]; props: Props }[] }, title = 'circuit'): string {
  const nn = (i: number) => (i === 0 ? '0' : net.nodeNames[i]);
  const g = (p: Props, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : parseFloat(String(p[k] ?? d)) || d);
  const lines = [`* ${title}`];
  const models = new Set<string>();
  for (const e of net.elements) {
    const n = e.nodes.map(nn);
    const p = e.props;
    switch (e.type) {
      case 'R': lines.push(`${e.name} ${n[0]} ${n[1]} ${g(p, 'resistance')}`); break;
      case 'C': lines.push(`${e.name} ${n[0]} ${n[1]} ${g(p, 'capacitance')}${g(p, 'ic') ? ` IC=${g(p, 'ic')}` : ''}`); break;
      case 'L': lines.push(`${e.name} ${n[0]} ${n[1]} ${g(p, 'inductance')}`); break;
      case 'V': lines.push(`${e.name} ${n[0]} ${n[1]} DC ${g(p, 'voltage')}`); break;
      case 'VAC': lines.push(`${e.name} ${n[0]} ${n[1]} SIN(${g(p, 'offset')} ${g(p, 'amplitude')} ${g(p, 'frequency')} 0 0 ${g(p, 'phase')})`); break;
      case 'VPULSE': {
        const per = 1 / g(p, 'frequency', 100);
        lines.push(`${e.name} ${n[0]} ${n[1]} PULSE(${g(p, 'low')} ${g(p, 'high')} 0 ${per / 1000} ${per / 1000} ${per * g(p, 'duty', 50) / 100} ${per})`);
        break;
      }
      case 'I': lines.push(`${e.name} ${n[0]} ${n[1]} DC ${g(p, 'current')}`); break;
      case 'D': lines.push(`${e.name} ${n[0]} ${n[1]} D_${p.model ?? 'si'}`); models.add(`.model D_${p.model ?? 'si'} D`); break;
      case 'LED': lines.push(`${e.name} ${n[0]} ${n[1]} LED_${p.color}`); models.add(`.model LED_${p.color} D(N=2)`); break;
      case 'ZD': lines.push(`${e.name} ${n[0]} ${n[1]} DZ${g(p, 'vz')}`); models.add(`.model DZ${g(p, 'vz')} D(BV=${g(p, 'vz')})`); break;
      case 'NPN': case 'PNP': lines.push(`${e.name} ${n[1]} ${n[0]} ${n[2]} Q${e.type}`); models.add(`.model Q${e.type} ${e.type}(BF=${g(p, 'beta', 100)})`); break;
      case 'NMOS': case 'PMOS': {
        // 내부 핀 [G, D, S] → SPICE: M D G S B(=S) 모델
        const mn = `${e.type}_${e.name}`;
        lines.push(`${e.name.startsWith('M') ? '' : 'M'}${e.name} ${n[1]} ${n[0]} ${n[2]} ${n[2]} ${mn}`);
        models.add(`.model ${mn} ${e.type}(VTO=${g(p, 'vth', e.type === 'NMOS' ? 2 : -2)} KP=${g(p, 'k', 0.01)} LAMBDA=${g(p, 'lambda', 0.01)})`);
        break;
      }
      case 'NJF': case 'PJF': {
        const mn = `${e.type}_${e.name}`;
        const vp = Math.abs(g(p, 'vp', 2)) || 2;
        lines.push(`${e.name.startsWith('J') ? '' : 'J'}${e.name} ${n[1]} ${n[0]} ${n[2]} ${mn}`);
        models.add(`.model ${mn} ${e.type}(VTO=${e.type === 'NJF' ? -vp : vp} BETA=${Math.abs(g(p, 'idss', 0.01)) / (vp * vp)} LAMBDA=${g(p, 'lambda', 0.01)})`);
        break;
      }
      case 'OPAMP': lines.push(`X${e.name} ${n[1]} ${n[0]} ${n[2]} opamp`); break;
      case 'SW': lines.push(`${e.name} ${n[0]} ${n[1]} ${p.closed ? 'ON' : 'OFF'}`); break;
      case 'AM': lines.push(`V${e.name} ${n[0]} ${n[1]} DC 0 ; ammeter`); break;
      default: break;
    }
  }
  return [...lines, ...models, '.end'].join('\n');
}
