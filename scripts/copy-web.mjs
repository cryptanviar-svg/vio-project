import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const WEB_FILES = ['index.html', 'snore-core.js', 'tailwind.css', 'manifest.json', 'icon.svg'];
const VENDOR_DIR = 'vendor';
const OUT_DIR = 'www';
const CAPACITOR_RUNTIME = 'node_modules/@capacitor/core/dist/capacitor.js';

const missing = [...WEB_FILES, CAPACITOR_RUNTIME, VENDOR_DIR].filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`VIO: бракує файлів для збірки: ${missing.join(', ')}. Виконайте: npm install та npm run build:css`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR);
for (const file of WEB_FILES) cpSync(file, `${OUT_DIR}/${file}`);
cpSync(CAPACITOR_RUNTIME, `${OUT_DIR}/capacitor.js`);
cpSync(VENDOR_DIR, `${OUT_DIR}/${VENDOR_DIR}`, { recursive: true });
console.log(`VIO: скопійовано ${WEB_FILES.length + 1} файлів і ${VENDOR_DIR}/ у ${OUT_DIR}/`);
