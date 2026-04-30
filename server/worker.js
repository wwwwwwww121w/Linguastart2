// LinguaStart auth backend — single Cloudflare Worker handling:
//   POST /auth/email/send      { email }                  -> sends 6-digit code via Resend
//   POST /auth/email/verify    { email, code }            -> { token } on success
//   POST /telegram/webhook     (Telegram updates)         -> stashes /start sid -> user pairing
//   GET  /auth/tg/poll?sid=... -> 204 if pending, 200 + user JSON when bot received /start
//
// Env bindings required (set via `wrangler secret put` or dashboard):
//   RESEND_API_KEY        re_...
//   TELEGRAM_BOT_TOKEN    123456789:AAH...
//   AUTH_SHARED_SECRET    any random string used to sign tokens
//   FROM_EMAIL            optional; default 'LinguaStart <onboarding@resend.dev>'
//   ALLOWED_ORIGIN        '*' for dev; set to your domain in prod
// KV binding: SESSIONS (namespace)

const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const RESEND_URL = 'https://api.resend.com/emails';

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });

const text = (env, body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...cors(env) } });

const rand6 = () => String(Math.floor(100000 + Math.random() * 900000));

async function sendEmailCode(env, email, code) {
  const from = env.FROM_EMAIL || 'LinguaStart <onboarding@resend.dev>';
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: email,
      subject: `LinguaStart · код входа: ${code}`,
      html: `<div style="font-family:system-ui,Arial;background:#0a1409;color:#dbf1d4;padding:30px;border-radius:14px;max-width:520px;margin:24px auto">
        <h1 style="color:#4cff64;margin:0 0 14px;font-size:22px">LinguaStart</h1>
        <p style="margin:0 0 18px">Привет! Твой одноразовый код для входа в приложение:</p>
        <div style="font-size:38px;letter-spacing:8px;color:#4cff64;background:#0e1d0c;padding:18px 22px;border-radius:12px;text-align:center;border:1px solid #1d3818;font-weight:700">${code}</div>
        <p style="margin:18px 0 0;font-size:13px;color:#88a780">Код действует 10 минут. Если ты не запрашивал вход — просто проигнорируй.</p>
      </div>`,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ' ' + (await r.text()));
}

async function sign(env, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.AUTH_SHARED_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(JSON.stringify(payload)));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(JSON.stringify(payload)) + '.' + b64;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/auth/email/send' && req.method === 'POST') {
        const { email } = await req.json();
        if (!email || !/.+@.+\..+/.test(email)) return text(env, 'invalid email', 400);
        const code = rand6();
        await env.SESSIONS.put(`email:${email}`, code, { expirationTtl: 600 });
        await sendEmailCode(env, email, code);
        return json(env, { ok: true });
      }

      if (path === '/auth/email/verify' && req.method === 'POST') {
        const { email, code } = await req.json();
        const stored = await env.SESSIONS.get(`email:${email}`);
        if (!stored || stored !== String(code)) return text(env, 'wrong code', 400);
        await env.SESSIONS.delete(`email:${email}`);
        const token = await sign(env, { email, iat: Date.now() });
        return json(env, { ok: true, email, token });
      }

      if (path === '/telegram/webhook' && req.method === 'POST') {
        const update = await req.json();
        const msg = update.message;
        if (msg && msg.text && msg.text.startsWith('/start')) {
          const parts = msg.text.split(' ');
          const sid = parts[1];
          if (sid && msg.from) {
            const data = {
              id: msg.from.id,
              first_name: msg.from.first_name || '',
              last_name: msg.from.last_name || '',
              username: msg.from.username || '',
              photo_url: '',
            };
            await env.SESSIONS.put(`tg:${sid}`, JSON.stringify(data), { expirationTtl: 600 });
            // Acknowledge to user
            await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: msg.chat.id, text: 'Готово ✅ Возвращайся в приложение — оно само залогинит тебя.' }),
            });
          }
        }
        return json(env, { ok: true });
      }

      if (path === '/auth/tg/poll' && req.method === 'GET') {
        const sid = url.searchParams.get('sid');
        if (!sid) return text(env, 'missing sid', 400);
        const v = await env.SESSIONS.get(`tg:${sid}`);
        if (!v) return new Response(null, { status: 204, headers: cors(env) });
        await env.SESSIONS.delete(`tg:${sid}`);
        const data = JSON.parse(v);
        const token = await sign(env, { tg_id: data.id, iat: Date.now() });
        return json(env, { ...data, token });
      }

      if (path === '/' || path === '/health') return text(env, 'LinguaStart auth OK');

      return text(env, 'not found', 404);
    } catch (e) {
      return text(env, 'error: ' + (e && e.message), 500);
    }
  },
};
