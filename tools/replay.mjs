import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

/* Прогін зразків ESC-50 через ту саму підготовку, модель YAMNet і логіку підтвердження/тригерів, що й нічна сесія, минаючи мікрофон.
   ENGINE_CONFIG, scoreWindow і topClasses беруться з index.html, підтвердження й тригери — зі snore-core.js.
   Запуск з кореня проєкту: node tools/replay.mjs [--limit N] */

const require = createRequire(import.meta.url);
const tf = require('@tensorflow/tfjs');
const Core = require('../snore-core.js');

const SAMPLES_DIR = 'tools/samples';
const POSITIVE_CLASS = 'snoring';
const NEGATIVE_CLASSES = ['breathing', 'coughing', 'sneezing', 'mouse_click', 'keyboard_typing', 'door_wood_knock', 'dog', 'vacuum_cleaner', 'clock_tick'];
const RULES = Object.freeze([
  { name: 'Нове: 2 с вище 0.20 за 30 с або одна секунда ≥ 0.50, із забороною Speech', hits: 2, windowMs: 30000, single: 0.5, isSpeechBanned: true },
  { name: 'Було: 2 с вище 0.20 за 30 с або одна секунда ≥ 0.70, із забороною Speech', hits: 2, windowMs: 30000, single: 0.7, isSpeechBanned: true }
]);
const CURRENT_RULE_INDEX = 0;
const PAIR_GAP_S = 12;
const NEGATIVE_PAIRS_PER_CLASS = 10;
const FAKE_DAY_START_MS = new Date('2000-01-01T00:00:00').getTime();
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/* ---------- Код з index.html ---------- */

function extractBlock(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`в index.html не знайдено блок «${startMarker}»`);
  return html.slice(start, end + endMarker.length);
}

function loadEngineParts() {
  const html = readFileSync('index.html', 'utf8');
  const configSource = extractBlock(html, 'const ENGINE_CONFIG = Object.freeze({', '\n});');
  const C = new Function(`${configSource}\nreturn ENGINE_CONFIG;`)();
  const scoreSource = extractBlock(html, 'async function scoreWindow', '\n}\n');
  const topSource = extractBlock(html, 'function topClasses', '\n}\n');
  const scoreWindow = new Function('tf', 'ENGINE_CONFIG', `${scoreSource}\nreturn scoreWindow;`)(tf, C);
  const topClasses = new Function(`${topSource}\nreturn topClasses;`)();
  return { C, scoreWindow, topClasses, threshold: C.AI_SNORE_MIN_SCORE };
}

async function loadModel() {
  const dir = 'vendor/yamnet/';
  const json = JSON.parse(readFileSync(`${dir}model.json`, 'utf8'));
  const shards = Buffer.concat(json.weightsManifest.flatMap((group) => group.paths).map((path) => readFileSync(dir + path)));
  const handler = {
    load: async () => ({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights),
      weightData: shards.buffer.slice(shards.byteOffset, shards.byteOffset + shards.byteLength),
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy
    })
  };
  return tf.loadGraphModel(handler);
}

function loadClassNames() {
  const lines = readFileSync('vendor/yamnet/yamnet_class_map.csv', 'utf8').split('\n').slice(1);
  const names = [];
  for (const line of lines) {
    const match = /^(\d+),[^,]*,(.*)$/.exec(line.trim());
    if (match) names[Number(match[1])] = match[2].replace(/^"|"$/g, '');
  }
  return names;
}

/* ---------- Звук ---------- */

function readWav(path) {
  const buf = readFileSync(path);
  let offset = 12;
  let format = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') format = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!format || format.bits !== 16 || format.channels !== 1) throw new Error(`${path}: потрібен 16-бітний моно WAV`);
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      return { rate: format.rate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: немає блока data`);
}

// Біквад за формулами Web Audio (для lowpass/highpass добротність задана в дБ), як у ланцюжку мікрофона двигуна
function biquad(samples, rate, type, hz, qDb) {
  const w0 = (2 * Math.PI * hz) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const isLow = type === 'lowpass';
  const b0 = (isLow ? 1 - cos : 1 + cos) / 2;
  const b1 = isLow ? 1 - cos : -(1 + cos);
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float64Array(samples.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

function bandpass(samples, rate, C) {
  const qDb = 20 * Math.log10(C.FILTER_Q);
  return biquad(biquad(samples, rate, 'highpass', C.HIGHPASS_HZ, qDb), rate, 'lowpass', C.LOWPASS_HZ, qDb);
}

function windowHash(window) {
  const words = new Int32Array(window.buffer, window.byteOffset, window.length);
  let hash = FNV_OFFSET;
  for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], FNV_PRIME);
  return hash >>> 0;
}

function concatSignals(first, second, gapSeconds) {
  const gap = Math.round(gapSeconds * first.rate);
  const samples = new Float32Array(first.samples.length + gap + second.samples.length);
  samples.set(first.samples, 0);
  samples.set(second.samples, first.samples.length + gap);
  return { rate: first.rate, samples };
}

/* ---------- Трасування: усе, що не залежить від правила підтвердження ---------- */

// Повторює цикл двигуна: щосекунди спершу класифікація (якщо нейромережа прокинута), потім аналіз RMS
async function buildTrace(signal, env, cache) {
  const { C, scoreWindow, topClasses } = env;
  const filtered = bandpass(signal.samples, signal.rate, C);
  const aiBuffer = Core.createAiBuffer(C, signal.rate);
  const ai = Core.createAiState();
  const ticks = Math.floor(signal.samples.length / signal.rate);
  const trace = [];
  let pushedUntil = 0;
  let envelope = 0;
  let lastRms = 0;
  for (let t = 1; t <= ticks; t++) {
    const end = Math.round(t * signal.rate);
    aiBuffer.push(signal.samples.subarray(pushedUntil, end));
    pushedUntil = end;
    const tick = { t, lastRms, isScored: false, snoring: 0, top: [] };
    if (aiBuffer.isFull() && ai.isAwake) {
      const window = aiBuffer.latestWindow();
      const key = windowHash(window);
      if (!cache.has(key)) cache.set(key, await scoreWindow(env.model, window));
      const scores = cache.get(key);
      tick.isScored = true;
      tick.snoring = scores[C.AI_SNORING_CLASS];
      tick.speech = scores[C.AI_SPEECH_CLASS];
      tick.top = topClasses(scores, C.DIAG_TOP_CLASSES);
    }
    tick.isFull = aiBuffer.isFull();
    const from = Math.max(0, end - C.FFT_SIZE);
    let sum = 0;
    for (let i = from; i < end; i++) sum += filtered[i] * filtered[i];
    lastRms = Math.sqrt(sum / C.FFT_SIZE);
    tick.rms = lastRms;
    envelope += C.ENVELOPE_SMOOTHING * (lastRms - envelope);
    Core.updateAiWakefulness(ai, envelope, C, t * 1000);
    trace.push(tick);
  }
  return trace;
}

/* ---------- Правило підтвердження ---------- */

function kindOf(reason) {
  if (reason.startsWith('причина: гучність')) return 'loud';
  return reason.includes('швидкий тригер') ? 'fast' : 'score';
}

function simulateRule(trace, env, rule) {
  const C = { ...env.C, AI_CONFIRM_HITS: rule.hits, AI_CONFIRM_WINDOW_MS: rule.windowMs, AI_SINGLE_SCORE: rule.single,
    ...(rule.isSpeechBanned ? {} : { AI_SPEECH_MIN_SCORE: Infinity, AI_SPEECH_TOP_RANK: 0 }) };
  const ai = Core.createAiState();
  ai.isReady = true;
  const st = { ai, episode: null, lockoutUntil: 0, isActive: false };
  for (const tick of trace) {
    const now = tick.t * 1000;
    if (tick.isFull && !tick.isScored) {
      Core.idleScore(ai, C, now);
    } else if (tick.isScored) {
      const verdict = Core.registerScore(ai, C, {
        now, wall: FAKE_DAY_START_MS + now, snoring: tick.snoring, speech: tick.speech, rms: tick.lastRms, top: tick.top,
        threshold: env.threshold, classLabel: env.classLabel
      });
      if (verdict.isFastConfirmed && Core.canStartEpisode(st, now)) return { seconds: tick.t, kind: 'fast', reason: verdict.fastReason };
    }
    const reason = Core.evaluateTriggers(st, C, now, tick.rms);
    if (reason) return { seconds: tick.t, kind: kindOf(reason), reason };
  }
  return null;
}

/* ---------- Прогін і підсумок ---------- */

function describeTop(top, classLabel) {
  return top.map((item) => `${classLabel(item.index)} ${item.score.toFixed(2)}`).join(', ');
}

function summarizeTrace(trace, classLabel) {
  const scored = trace.filter((tick) => tick.isScored);
  if (scored.length === 0) return { maxSnoring: 0, top3: '—' };
  const best = scored.reduce((max, tick) => (tick.snoring > max.snoring ? tick : max));
  return { maxSnoring: best.snoring, top3: describeTop(best.top, classLabel) };
}

async function runTrial(label, category, signal, env, cache) {
  const trace = await buildTrace(signal, env, cache);
  const summary = summarizeTrace(trace, env.classLabel);
  const rules = RULES.map((rule) => simulateRule(trace, env, rule));
  const speechSeconds = trace.filter((tick) => tick.isScored && tick.snoring > env.C.AI_HOLD_SCORE && Core.isSpeechSecond(env.C, tick.speech, tick.top)).length;
  return { label, category, ...summary, rules, speechSeconds };
}

function listFiles(category) {
  const rows = readFileSync(`${SAMPLES_DIR}/esc50.csv`, 'utf8').trim().split('\n').slice(1).map((line) => line.split(','));
  return rows.filter((cells) => cells[3] === category).map((cells) => cells[0]).sort();
}

function parseLimit() {
  const index = process.argv.indexOf('--limit');
  return index >= 0 ? Number.parseInt(process.argv[index + 1], 10) : Infinity;
}

function percent(count, total) {
  return total === 0 ? '—' : `${Math.round((count / total) * 100)}%`;
}

function describeRuleResult(result) {
  return result ? `${result.seconds} с (${result.kind})` : 'ні';
}

function formatFileRow(trial) {
  const current = trial.rules[CURRENT_RULE_INDEX];
  const others = RULES.map((rule, i) => `правило ${i + 1}: ${describeRuleResult(trial.rules[i])}`).join('; ');
  return `${trial.category.padEnd(16)} ${trial.label.padEnd(20)} макс Snoring ${trial.maxSnoring.toFixed(2)} | рефлекс ${current ? `так, через ${current.seconds} с, ${current.kind}` : 'ні'} | топ-3: ${trial.top3} | ${others}`;
}

function countOutcomes(trials, ruleIndex) {
  return { total: trials.length, any: trials.filter((trial) => trial.rules[ruleIndex]).length };
}

function summaryLines(title, positives, negatives, negativeClasses) {
  const lines = [`
=== ${title} ===`];
  RULES.forEach((rule, i) => {
    const pos = countOutcomes(positives, i);
    const neg = countOutcomes(negatives, i);
    lines.push(`${rule.name}:`);
    lines.push(`  хропіння: рефлекс у ${pos.any} з ${pos.total} (${percent(pos.any, pos.total)})`);
    lines.push(`  негативи: хибних спрацювань ${neg.any} з ${neg.total} (${percent(neg.any, neg.total)})`);
    const perClass = negativeClasses.map((name) => {
      const c = countOutcomes(negatives.filter((trial) => trial.category === name), i);
      return `${name} ${c.any}/${c.total}`;
    });
    lines.push(`  по класах: ${perClass.join('; ')}`);
  });
  const blockedPositives = positives.filter((trial) => trial.speechSeconds > 0).length;
  const blockedNegatives = negatives.filter((trial) => trial.speechSeconds > 0).length;
  lines.push(`Заборона Speech відсіяла секунди зі Snoring > 0.10: у ${blockedPositives} з ${positives.length} зразків хропіння, у ${blockedNegatives} з ${negatives.length} негативів`);
  return lines;
}

async function main() {
  const limit = parseLimit();
  const classNames = loadClassNames();
  const env = { ...loadEngineParts(), model: await loadModel(), classLabel: (index) => classNames[index] || `клас ${index}` };
  const cache = new Map();
  const startedAt = Date.now();
  const singles = [];
  const categories = [POSITIVE_CLASS, ...NEGATIVE_CLASSES];
  for (const category of categories) {
    const files = listFiles(category).slice(0, limit);
    for (const file of files) {
      singles.push(await runTrial(file, category, readWav(`${SAMPLES_DIR}/audio/${file}`), env, cache));
    }
    console.error(`${category}: ${files.length} файлів, ${Math.round((Date.now() - startedAt) / 1000)} с`);
  }

  const pairs = [];
  for (const category of categories) {
    const files = listFiles(category).slice(0, limit);
    const maxPairs = category === POSITIVE_CLASS ? Infinity : NEGATIVE_PAIRS_PER_CLASS;
    for (let i = 0; i + 1 < files.length && pairs.filter((p) => p.category === category).length < maxPairs; i += 2) {
      const signal = concatSignals(readWav(`${SAMPLES_DIR}/audio/${files[i]}`), readWav(`${SAMPLES_DIR}/audio/${files[i + 1]}`), PAIR_GAP_S);
      pairs.push(await runTrial(`${files[i]}+${files[i + 1]}`, category, signal, env, cache));
    }
  }

  const split = (trials) => ({
    positives: trials.filter((trial) => trial.category === POSITIVE_CLASS),
    negatives: trials.filter((trial) => trial.category !== POSITIVE_CLASS)
  });
  const lines = [
    `Поріг Snoring ${env.threshold}, утримання сигналу ${env.C.AI_HOLD_QUIET_MS / 1000} с без Snoring понад ${env.C.AI_HOLD_SCORE}.`,
    'Гучність сама рефлекс не запускає: лише правила за моделлю.',
    '\n=== Окремі файли (5 с), поточне правило і порівняння правил ===',
    ...singles.map(formatFileRow),
    ...summaryLines('Підсумок: окремі файли по 5 с', split(singles).positives, split(singles).negatives, NEGATIVE_CLASSES),
    `\n=== Пари файлів з паузою ${PAIR_GAP_S} с тиші між ними (рідкісне хропіння) ===`,
    ...pairs.map(formatFileRow),
    ...summaryLines(`Підсумок: пари з паузою ${PAIR_GAP_S} с`, split(pairs).positives, split(pairs).negatives, NEGATIVE_CLASSES)
  ];
  writeFileSync(`${SAMPLES_DIR}/replay-report.txt`, lines.join('\n'));
  writeFileSync(`${SAMPLES_DIR}/replay-results.json`, JSON.stringify({ singles, pairs }, null, 2));
  console.log(lines.filter((line) => !/^(snoring|breathing|coughing|sneezing|mouse_click|keyboard_typing|door_wood_knock|dog|vacuum_cleaner|clock_tick) /.test(line)).join('\n'));
  console.error(`Повний звіт: ${SAMPLES_DIR}/replay-report.txt (${Math.round((Date.now() - startedAt) / 1000)} с)`);
}

main().catch((err) => {
  console.error(`VIO: прогін не вдався: ${err.stack || err.message}`);
  process.exit(1);
});
