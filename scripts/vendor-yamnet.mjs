import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const TFJS_SOURCE = 'node_modules/@tensorflow/tfjs/dist/tf.min.js';
const TFJS_DIR = 'vendor/tfjs';
const MODEL_DIR = 'vendor/yamnet';
const MODEL_BASE_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
const MODEL_QUERY = '?tfjs-format=file';
const MODEL_JSON = 'model.json';
const MIN_FILE_BYTES = 1000;

function fail(message) {
  console.error(`VIO: ${message}`);
  process.exit(1);
}

async function download(name) {
  const response = await fetch(`${MODEL_BASE_URL}/${name}${MODEL_QUERY}`);
  if (!response.ok) fail(`не вдалося завантажити ${name}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length < MIN_FILE_BYTES) fail(`файл ${name} пошкоджений: ${data.length} байт`);
  return data;
}

if (!existsSync(TFJS_SOURCE)) fail(`немає ${TFJS_SOURCE}. Виконайте: npm install`);
mkdirSync(TFJS_DIR, { recursive: true });
mkdirSync(MODEL_DIR, { recursive: true });
cpSync(TFJS_SOURCE, `${TFJS_DIR}/tf.min.js`);

const manifestData = await download(MODEL_JSON);
const manifest = JSON.parse(manifestData.toString('utf8'));
if (!Array.isArray(manifest.weightsManifest)) fail('model.json YAMNet має неочікувану структуру: немає weightsManifest');
writeFileSync(`${MODEL_DIR}/${MODEL_JSON}`, manifestData);

const shards = manifest.weightsManifest.flatMap((group) => group.paths);
for (const shard of shards) {
  if (existsSync(`${MODEL_DIR}/${shard}`)) continue;
  writeFileSync(`${MODEL_DIR}/${shard}`, await download(shard));
}
console.log(`VIO: tf.min.js і YAMNet (${shards.length} шардів) скопійовано у vendor/`);
