import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = 'https://raw.githubusercontent.com/karolpiczak/ESC-50/master';
const SAMPLES_DIR = 'tools/samples';
const POSITIVE_CLASSES = ['snoring'];
const NEGATIVE_CLASSES = ['breathing', 'coughing', 'sneezing', 'mouse_click', 'keyboard_typing', 'door_wood_knock', 'dog', 'vacuum_cleaner', 'clock_tick'];
const PARALLEL_DOWNLOADS = 8;

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  mkdirSync(`${SAMPLES_DIR}/audio`, { recursive: true });
  const csv = (await download(`${BASE_URL}/meta/esc50.csv`)).toString('utf8');
  writeFileSync(`${SAMPLES_DIR}/esc50.csv`, csv);
  const wanted = new Set([...POSITIVE_CLASSES, ...NEGATIVE_CLASSES]);
  const rows = csv.trim().split('\n').slice(1).map((line) => line.split(','))
    .filter((cells) => wanted.has(cells[3]));
  const queue = rows.filter(([file]) => !existsSync(`${SAMPLES_DIR}/audio/${file}`));
  console.log(`Потрібно файлів: ${rows.length}, ще не завантажено: ${queue.length}`);
  let done = 0;
  async function worker() {
    while (queue.length > 0) {
      const [file] = queue.shift();
      writeFileSync(`${SAMPLES_DIR}/audio/${file}`, await download(`${BASE_URL}/audio/${file}`));
      done += 1;
      if (done % 50 === 0) console.log(`Завантажено ${done}`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
  console.log(`Готово: ${rows.length} файлів у ${SAMPLES_DIR}/audio`);
}

main().catch((err) => {
  console.error(`VIO: не вдалося завантажити ESC-50: ${err.message}`);
  process.exit(1);
});
