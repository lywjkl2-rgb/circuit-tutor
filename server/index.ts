// 회로 튜터 API 서버
//  POST /api/recognize : 회로도 이미지 → 넷리스트(JSON)  [Claude 비전]
//  POST /api/tutor     : 회로 해석 결과를 바탕으로 질의응답 (스트리밍 텍스트)
//  GET  /api/status    : AI 기능 사용 가능 여부
// 운영 모드(NODE_ENV=production)에서는 dist/ 정적 파일도 제공한다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { PIN_NAMES, RECOGNITION_JSON_SCHEMA, RECOGNIZABLE } from '../src/importer/recognition';

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const MAX_BODY = 25 * 1024 * 1024;

let client: Anthropic | null = null;
function getClient() {
  // 자격 증명은 SDK 기본 규칙으로 해석 (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login` 프로필 등)
  if (!client) client = new Anthropic();
  return client;
}
const hasCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || fs.existsSync(path.join(process.env.HOME ?? '', '.config/anthropic')));

// ------------------------------------------------------------------ 회로 인식
const RECOGNIZE_SYSTEM = `You convert schematic diagrams (photos, scans, textbook figures, PDF pages) into an exact netlist for an educational circuit simulator.

How to read the drawing:
- Trace every wire. Wires that touch at a dot, or form a T, are the same net. Wires that merely cross without a dot are NOT connected (unless the figure's own convention says otherwise).
- Give each electrically distinct net a short name: "0" for ground/reference, otherwise use the label printed in the figure (Vin, Vout, Vcc, A, B ...) or N1, N2, ...
- A ground symbol, the negative terminal of the main supply in a figure without a ground symbol, or a rail labelled 0 V / GND / COM is the reference net. Put its name in ground_net. Supply rails shown only as labels (e.g. "+12 V" at the top of a resistor) must become an explicit DC voltage source "V" from that net to ground, named after the label.
- Components and the pin names you must use:
${Object.entries(PIN_NAMES).map(([t, p]) => `  ${t}: ${p.join(', ')}`).join('\n')}
  Types: R resistor, C capacitor, L inductor, V DC voltage source/battery (pos = longer plate or + sign), VAC sinusoidal source, VPULSE square/pulse source, I DC current source (arrow points from "from" to "to"), D diode, LED, ZD zener diode, SW switch, NPN/PNP bipolar transistor, NMOS/PMOS enhancement MOSFET (body tied to source), NJF/PJF junction FET, OPAMP op-amp (inv = − input, noninv = + input; supply pins are omitted), AM ammeter, VM voltmeter.
  Transformers, potentiometers, ICs and other parts that are not in this list: approximate if a faithful equivalent exists (e.g. a potentiometer as two resistors), otherwise omit them and explain in notes.
- value: the printed value with its unit and SI prefix exactly as a number the simulator can parse, e.g. "4.7k", "220", "10u", "100n", "12", "1m". European notation like 4k7 must be converted to "4.7k". For VAC use the peak amplitude (append " rms" if the figure gives RMS). For ZD put the zener voltage. For NPN/PNP put β if printed. For NMOS/PMOS put the threshold voltage if printed; for NJF/PJF put IDSS if printed. Depletion-mode MOSFETs: use NJF/PJF and say so in notes. Use null if no value is printed — then choose nothing; the simulator will use a default.
- frequency: for VAC/VPULSE only (e.g. "60", "1k"), else null. variant: LED colour, diode part number (1N4148, 1N4007, schottky), switch state ("open"/"closed"), else null.
- x, y: the component's centre in the image, as fractions 0..1 of image width/height. orientation: the direction the component body runs in the drawing.
- name: the reference designator printed in the figure (R1, C2, Q1 ...). If none is printed, invent one in the standard style.
- confidence: how sure you are that the netlist is complete and correct. In notes, list (in Korean) anything ambiguous, assumed, unreadable or omitted.
- title and description: in Korean. description briefly says what this circuit is for (e.g. "반파 정류 회로").
If the image contains no circuit schematic, return an empty components list and explain in notes.`;

const RecognizedSchema = z.object({
  title: z.string(),
  description: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  ground_net: z.string(),
  components: z.array(z.object({
    type: z.enum(RECOGNIZABLE as [string, ...string[]]),
    name: z.string(),
    value: z.string().nullable(),
    frequency: z.string().nullable(),
    variant: z.string().nullable(),
    pins: z.array(z.object({ pin: z.string(), net: z.string() })),
    x: z.number(),
    y: z.number(),
    orientation: z.enum(['horizontal', 'vertical']),
  })),
  notes: z.array(z.string()),
});

const ImageBody = z.object({
  image: z.string().min(16),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  hint: z.string().max(2000).optional(),
});

async function recognize(body: unknown) {
  const { image, mediaType, hint } = ImageBody.parse(body);
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: RECOGNITION_JSON_SCHEMA as unknown as Record<string, unknown> } },
    system: RECOGNIZE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: `Convert this schematic into the netlist JSON.${hint ? `\nUser note about the figure: ${hint}` : ''}` },
      ],
    }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new HttpError(422, '모델이 이 이미지 처리를 거절했습니다. 다른 이미지로 시도해 주세요.');
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, '응답이 너무 길어 잘렸습니다. 회로 부분만 잘라서 다시 시도해 주세요.');
  const text = msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(502, '모델 응답을 JSON으로 해석하지 못했습니다.'); }
  const result = RecognizedSchema.safeParse(parsed);
  if (!result.success) throw new HttpError(502, `인식 결과 형식이 올바르지 않습니다: ${result.error.issues[0]?.message ?? ''}`);
  return result.data;
}

// ------------------------------------------------------------------ AI 튜터
const TUTOR_SYSTEM = `당신은 전기공학을 공부하는 학생을 돕는 친절하고 정확한 회로 튜터입니다.
- 사용자가 보고 있는 회로의 넷리스트와 시뮬레이션 결과(노드 전압, 소자 전류, 소자 상태, 시정수 등)가 함께 제공됩니다. 숫자를 말할 때는 이 결과를 근거로 삼고, 결과와 이론값이 다르면 그 이유(부하 효과, 다이오드 비선형성 등)를 설명하세요.
- 회로가 "어떤 원리로, 어떤 순서로" 동작하는지, 각 소자가 "왜" 거기 있는지를 단계별로 설명하세요. 필요하면 KCL/KVL, 테브난 등가, 소신호 모델 같은 표준 해석 도구를 써서 손으로 푸는 과정을 보여 주세요.
- 수식은 LaTeX로 쓰고 인라인은 $...$, 독립 수식은 $$...$$ 로 감싸세요.
- 한국어로 답하고, 학생이 다음에 직접 해 볼 만한 실험(값 바꿔 보기 등)을 한두 가지 제안하세요.
- 시뮬레이션 모델의 한계(이상적인 연산증폭기, 단순화된 다이오드/트랜지스터 모델)를 넘어서는 질문이면 그 점을 밝혀 주세요.`;

const TutorBody = z.object({
  context: z.string().max(200_000),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20_000) })).min(1).max(40),
});

async function tutor(body: unknown, res: http.ServerResponse) {
  const { context, messages } = TutorBody.parse(body);
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: [
      { type: 'text', text: TUTOR_SYSTEM },
      { type: 'text', text: `현재 회로와 시뮬레이션 결과:\n${context}`, cache_control: { type: 'ephemeral' } },
    ],
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  stream.on('text', delta => { res.write(delta); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') res.write('\n\n(모델이 이 질문에 대한 답변을 거절했습니다.)');
  res.end();
}

// ------------------------------------------------------------------ HTTP
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '파일이 너무 큽니다 (최대 25MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, '잘못된 JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function apiError(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof z.ZodError) return { status: 400, message: `요청 형식 오류: ${e.issues[0]?.message}` };
  if (e instanceof Anthropic.AuthenticationError) return { status: 401, message: 'Claude API 인증에 실패했습니다. 서버의 ANTHROPIC_API_KEY를 확인하세요.' };
  if (e instanceof Anthropic.RateLimitError) return { status: 429, message: '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도하세요.' };
  if (e instanceof Anthropic.BadRequestError) return { status: 400, message: `Claude API 요청 오류: ${e.message}` };
  if (e instanceof Anthropic.APIConnectionError) return { status: 502, message: 'Claude API에 연결하지 못했습니다.' };
  if (e instanceof Anthropic.APIError) return { status: 502, message: `Claude API 오류: ${e.message}` };
  if (e instanceof Error && /credentials|api key|apiKey|authToken/i.test(e.message)) return { status: 401, message: 'Claude API 자격 증명이 없습니다. 서버를 실행할 때 ANTHROPIC_API_KEY 환경 변수를 설정하세요.' };
  return { status: 500, message: e instanceof Error ? e.message : String(e) };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('빌드 파일이 없습니다. 먼저 npm run build 를 실행하세요.'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  try {
    if (url === '/api/status' && req.method === 'GET') return sendJson(res, 200, { ai: hasCredentials(), model: MODEL });
    if (url === '/api/recognize' && req.method === 'POST') return sendJson(res, 200, await recognize(await readJson(req)));
    if (url === '/api/tutor' && req.method === 'POST') return await tutor(await readJson(req), res);
    if (url.startsWith('/api/')) return sendJson(res, 404, { error: '없는 API' });
    if (process.env.NODE_ENV === 'production') return serveStatic(req, res);
    res.writeHead(404); res.end('개발 모드에서는 Vite 개발 서버(기본 5173 포트)로 접속하세요.');
  } catch (e) {
    const { status, message } = apiError(e);
    console.error(`[${req.method} ${url}]`, e);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else { res.write(`\n\n⚠️ ${message}`); res.end(); }
  }
});

server.listen(PORT, () => {
  console.log(`회로 튜터 API 서버: http://localhost:${PORT}  (모델 ${MODEL}, AI ${hasCredentials() ? '사용 가능' : '자격 증명 없음 — 이미지 인식/튜터 비활성'})`);
});
