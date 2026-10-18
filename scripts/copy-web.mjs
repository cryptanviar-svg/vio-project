import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const WEB_FILES = ['index.html', 'tailwind.css', 'manifest.json', 'icon.svg'];
const OUT_DIR = 'www';

const missing = WEB_FILES.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`VIO: бракує файлів для збірки: ${missing.join(', ')}. Спершу виконайте: npm run build:css`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR);
for (const file of WEB_FILES) cpSync(file, `${OUT_DIR}/${file}`);
console.log(`VIO: скопійовано ${WEB_FILES.length} файлів у ${OUT_DIR}/`);
