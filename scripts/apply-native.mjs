import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SRC_DIR = 'native/android';
const JAVA_DIR = 'android/app/src/main/java/com/vio/app';
const MANIFEST_PATH = 'android/app/src/main/AndroidManifest.xml';
const JAVA_FILES = ['MainActivity.java', 'AudioRoutePlugin.java', 'VioSessionPlugin.java', 'VioForegroundService.java'];
const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.POST_NOTIFICATIONS'
];
// Без required="false" Google Play відсікає пристрої без камери, а камера потрібна лише для Face-Tracking-симуляції
const CAMERA_FEATURE_TAG = '<uses-feature android:name="android.hardware.camera" android:required="false" />';
const SERVICE_NAME ='.VioForegroundService';
const SERVICE_TAG = `<service android:name="${SERVICE_NAME}" android:exported="false" android:foregroundServiceType="microphone" />`;

function fail(message) {
  console.error(`VIO: ${message}`);
  process.exit(1);
}

if (!existsSync(MANIFEST_PATH)) fail('Android-проєкт не знайдено. Спершу виконайте: npx cap add android');

mkdirSync(JAVA_DIR, { recursive: true });
for (const file of JAVA_FILES) cpSync(`${SRC_DIR}/${file}`, `${JAVA_DIR}/${file}`);

let manifest = readFileSync(MANIFEST_PATH, 'utf8');
if (!manifest.includes('<application') || !manifest.includes('</application>')) {
  fail('AndroidManifest.xml має неочікувану структуру: немає тега <application>');
}

const missingPermissions = PERMISSIONS.filter((name) => !manifest.includes(`android:name="${name}"`));
if (missingPermissions.length > 0) {
  const block = missingPermissions.map((name) => `<uses-permission android:name="${name}" />`).join('\n    ');
  manifest = manifest.replace('<application', () => `${block}\n\n    <application`);
}
if (!manifest.includes('android:name="android.hardware.camera"')) {
  manifest = manifest.replace('<application', () => `${CAMERA_FEATURE_TAG}\n\n    <application`);
}
if (!manifest.includes(`android:name="${SERVICE_NAME}"`)) {
  manifest = manifest.replace('</application>', () => `${SERVICE_TAG}\n    </application>`);
}

writeFileSync(MANIFEST_PATH, manifest, 'utf8');
console.log(`VIO: Java-файли скопійовано, дозволи додано: ${missingPermissions.length}`);
