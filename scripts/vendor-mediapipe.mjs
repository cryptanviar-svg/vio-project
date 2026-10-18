import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const PACKAGE_DIR = 'node_modules/@mediapipe/tasks-vision';
const OUT_DIR = 'vendor/mediapipe';
const WASM_DIR = `${OUT_DIR}/wasm`;
const BUNDLE_FILE = 'vision_bundle.mjs';
// ES-модуль віддаємо з розширенням .js: вебсервери WebView не завжди знають MIME-тип .mjs, а для import() він обов'язковий
const BUNDLE_OUT_FILE = 'vision_bundle.esm.js';
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm'
];
const MODEL_FILE = `${OUT_DIR}/face_landmarker.task`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MIN_MODEL_BYTES = 1_000_000;

function fail(message) {
  console.error(`VIO: ${message}`);
  process.exit(1);
}

const sources = [BUNDLE_FILE, ...WASM_FILES.map((name) => `wasm/${name}`)].map((name) => `${PACKAGE_DIR}/${name}`);
const missing = sources.filter((file) => !existsSync(file));
if (missing.length > 0) fail(`бракує файлів MediaPipe: ${missing.join(', ')}. Виконайте: npm install`);

mkdirSync(WASM_DIR, { recursive: true });
cpSync(`${PACKAGE_DIR}/${BUNDLE_FILE}`, `${OUT_DIR}/${BUNDLE_OUT_FILE}`);
for (const name of WASM_FILES) cpSync(`${PACKAGE_DIR}/wasm/${name}`, `${WASM_DIR}/${name}`);

if (!existsSync(MODEL_FILE)) {
  const response = await fetch(MODEL_URL);
  if (!response.ok) fail(`не вдалося завантажити модель Face Landmarker: HTTP ${response.status}`);
  const model = Buffer.from(await response.arrayBuffer());
  if (model.length < MIN_MODEL_BYTES) fail(`модель Face Landmarker пошкоджена: ${model.length} байт`);
  writeFileSync(MODEL_FILE, model);
}
console.log(`VIO: MediaPipe скопійовано у ${OUT_DIR}/`);
