// Inject env-var secrets into the synced Android assets at build time.
// Replaces __PLACEHOLDERS__ in index.html and capacitor.config.json.
const fs = require('fs');
const path = require('path');

const PUBLIC_HTML = 'android/app/src/main/assets/public/index.html';
const CAP_CONFIG = 'android/app/src/main/assets/capacitor.config.json';

// SECURITY: FIREWORKS_API_KEY is intentionally NOT injected into shipping APKs.
// AI calls are proxied through the Cloudflare Worker (AUTH_BACKEND_URL/ai/*),
// which holds the key as a server-side secret. To inject for local desktop dev
// only, set ALLOW_FIREWORKS_KEY_IN_APK=1 (never do this for prod builds).
const REPLACEMENTS = [
  { env: 'GOOGLE_OAUTH_CLIENT_ID', placeholder: '__GOOGLE_CLIENT_ID__', label: 'Google Client ID' },
  { env: 'TELEGRAM_BOT_ID', placeholder: '__TELEGRAM_BOT_ID__', label: 'Telegram Bot ID' },
  { env: 'TELEGRAM_BOT_USERNAME', placeholder: '__TELEGRAM_BOT_USERNAME__', label: 'Telegram Bot Username' },
  { env: 'AUTH_BACKEND_URL', placeholder: '__AUTH_BACKEND_URL__', label: 'Auth Backend URL' },
];
if (process.env.ALLOW_FIREWORKS_KEY_IN_APK === '1') {
  REPLACEMENTS.push({ env: 'FIREWORKS_API_KEY', placeholder: '__FIREWORKS_API_KEY__', label: 'Fireworks API Key (DEV ONLY)' });
}

function patch(file, allowMissing) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return;
    console.error('Missing file:', file);
    process.exit(1);
  }
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const r of REPLACEMENTS) {
    const v = process.env[r.env];
    if (!v) continue;
    if (s.includes(r.placeholder)) {
      s = s.split(r.placeholder).join(v);
      changed = true;
      console.log(`  ${file}: injected ${r.label} (${v.length} chars)`);
    }
  }
  if (changed) fs.writeFileSync(file, s);
}

console.log('Injecting build-time secrets...');
patch(PUBLIC_HTML, false);
patch(CAP_CONFIG, true);

for (const r of REPLACEMENTS) {
  if (!process.env[r.env]) {
    console.warn(`  (skipped) ${r.env} not set — feature relying on ${r.label} will be inactive`);
  }
}
console.log('Done.');
