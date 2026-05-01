// LinguaStart auth + AI proxy backend (Cloudflare Worker)
//
// Endpoints:
//   POST /auth/email/send      { email }                  -> sends 6-digit code via Resend
//   POST /auth/email/verify    { email, code }            -> { token } on success
//   POST /telegram/webhook     (Telegram updates)         -> requires X-Telegram-Bot-Api-Secret-Token
//   GET  /auth/tg/poll?sid=... -> 204 if pending, 200 + user JSON when bot received /start
//   POST /ai/chat              -> Cloudflare Workers AI (Llama 3.3 70B)
//   POST /ai/transcribe        -> Cloudflare Workers AI (Whisper large v3 turbo)
//
// Env bindings (`wrangler secret put`):
//   RESEND_API_KEY               re_...
//   TELEGRAM_BOT_TOKEN           123456789:AAH...
//   TELEGRAM_WEBHOOK_SECRET      any random string (REQUIRED — set webhook with this secret_token)
//   AUTH_SHARED_SECRET           any random string used to sign tokens
//   FROM_EMAIL                   optional; default 'LinguaStart <onboarding@resend.dev>'
//   ALLOWED_ORIGIN               'https://localhost' for Capacitor; '*' for dev
// KV binding:  SESSIONS (rate-limit + OTP + Telegram pending logins)
// AI binding:  AI       (Cloudflare Workers AI for /ai/chat + /ai/transcribe)

const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const RESEND_URL = 'https://api.resend.com/emails';

// ---- helpers ----
const cors = (env, origin) => {
  const allow = env.ALLOWED_ORIGIN || '*';
  // If wildcard configured, echo the request origin to keep CORS workable across Capacitor schemes.
  // If a specific origin is configured, only allow that one.
  const allowOrigin = allow === '*' ? (origin || '*') : (origin === allow ? allow : allow);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
};

const json = (env, body, status = 200, origin) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env, origin) } });

const text = (env, body, status = 200, origin) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...cors(env, origin) } });

const rand6 = () => String(Math.floor(100000 + Math.random() * 900000));

// constant-time string equality (avoids early-return timing leak)
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// IP-based sliding-window rate limiter using KV.
// `bucket` is a string key prefix; `limit` requests per `windowSec` window per ip.
async function rateLimit(env, ip, bucket, limit, windowSec) {
  if (!ip) ip = 'anon';
  const k = `rl:${bucket}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const cur = await env.SESSIONS.get(k);
  let entry = cur ? JSON.parse(cur) : { c: 0, t: now };
  if (now - entry.t > windowSec) entry = { c: 0, t: now };
  entry.c += 1;
  // KV write back — TTL keeps the bucket from growing.
  await env.SESSIONS.put(k, JSON.stringify(entry), { expirationTtl: windowSec * 2 });
  return { ok: entry.c <= limit, count: entry.c, retryAfter: Math.max(1, windowSec - (now - entry.t)) };
}

// Track failed verify attempts per email to prevent brute-force of the 6-digit OTP.
async function bumpVerifyAttempts(env, email) {
  const k = `va:${email}`;
  const cur = await env.SESSIONS.get(k);
  const n = (cur ? parseInt(cur, 10) : 0) + 1;
  await env.SESSIONS.put(k, String(n), { expirationTtl: 900 });
  return n;
}
async function clearVerifyAttempts(env, email) { await env.SESSIONS.delete(`va:${email}`); }

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

const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validCode  = (c) => typeof c === 'string' && /^\d{6}$/.test(c);

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env, origin) });
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Real-IP') || 'unknown';

    try {
      // ---- Email OTP ----
      if (path === '/auth/email/send' && req.method === 'POST') {
        const rl = await rateLimit(env, ip, 'email_send', 5, 600); // 5 sends / 10 min / IP
        if (!rl.ok) return text(env, 'rate limited', 429, origin);
        const body = await req.json().catch(() => ({}));
        const email = (body.email || '').toLowerCase().trim();
        if (!validEmail(email)) return text(env, 'invalid email', 400, origin);
        const perEmail = await rateLimit(env, email, 'email_send_addr', 3, 600); // 3 / 10 min / addr
        if (!perEmail.ok) return text(env, 'rate limited', 429, origin);
        const code = rand6();
        await env.SESSIONS.put(`email:${email}`, code, { expirationTtl: 600 });
        await clearVerifyAttempts(env, email);
        await sendEmailCode(env, email, code);
        return json(env, { ok: true }, 200, origin);
      }

      if (path === '/auth/email/verify' && req.method === 'POST') {
        const rl = await rateLimit(env, ip, 'email_verify', 30, 600); // 30 attempts / 10 min / IP
        if (!rl.ok) return text(env, 'rate limited', 429, origin);
        const body = await req.json().catch(() => ({}));
        const email = (body.email || '').toLowerCase().trim();
        const code = String(body.code || '');
        if (!validEmail(email) || !validCode(code)) return text(env, 'invalid input', 400, origin);
        const attempts = await bumpVerifyAttempts(env, email);
        if (attempts > 8) {
          await env.SESSIONS.delete(`email:${email}`); // invalidate code on too many tries
          return text(env, 'too many attempts', 429, origin);
        }
        const stored = await env.SESSIONS.get(`email:${email}`);
        if (!stored || !safeEq(stored, code)) return text(env, 'wrong code', 400, origin);
        await env.SESSIONS.delete(`email:${email}`);
        await clearVerifyAttempts(env, email);
        const token = await sign(env, { email, iat: Date.now() });
        return json(env, { ok: true, email, token }, 200, origin);
      }

      // ---- Telegram webhook (must include secret token from Telegram bot setWebhook) ----
      if (path === '/telegram/webhook' && req.method === 'POST') {
        const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEq(got, env.TELEGRAM_WEBHOOK_SECRET)) {
          return text(env, 'forbidden', 403, origin);
        }
        const update = await req.json().catch(() => ({}));
        const msg = update.message;
        if (msg && msg.text && msg.text.startsWith('/start')) {
          const parts = msg.text.split(' ');
          const sid = parts[1];
          // sid must look like a uuid/short token to prevent KV key abuse
          if (sid && /^[a-zA-Z0-9_-]{6,64}$/.test(sid) && msg.from) {
            const data = {
              id: msg.from.id,
              first_name: String(msg.from.first_name || '').slice(0, 100),
              last_name: String(msg.from.last_name || '').slice(0, 100),
              username: String(msg.from.username || '').slice(0, 100),
              photo_url: '',
            };
            await env.SESSIONS.put(`tg:${sid}`, JSON.stringify(data), { expirationTtl: 600 });
            await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: msg.chat.id, text: 'Готово ✅ Возвращайся в приложение — оно само залогинит тебя.' }),
            });
          }
        }
        return json(env, { ok: true }, 200, origin);
      }

      if (path === '/auth/tg/poll' && req.method === 'GET') {
        const rl = await rateLimit(env, ip, 'tg_poll', 120, 60); // 2/sec
        if (!rl.ok) return text(env, 'rate limited', 429, origin);
        const sid = url.searchParams.get('sid') || '';
        if (!/^[a-zA-Z0-9_-]{6,64}$/.test(sid)) return text(env, 'missing sid', 400, origin);
        const v = await env.SESSIONS.get(`tg:${sid}`);
        if (!v) return new Response(null, { status: 204, headers: cors(env, origin) });
        await env.SESSIONS.delete(`tg:${sid}`);
        const data = JSON.parse(v);
        const token = await sign(env, { tg_id: data.id, iat: Date.now() });
        return json(env, { ...data, token }, 200, origin);
      }

      // ---- AI proxy (Cloudflare Workers AI — same Cloudflare account, no extra subscription) ----
      if (path === '/ai/chat' && req.method === 'POST') {
        if (!env.AI) return text(env, 'ai disabled', 503, origin);
        const rl = await rateLimit(env, ip, 'ai_chat', 30, 60); // 30/min/IP
        if (!rl.ok) return text(env, 'rate limited', 429, origin);
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.messages)) return text(env, 'invalid', 400, origin);
        const messages = body.messages.slice(-20).map((m) => ({
          role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
          content: String(m.content || '').slice(0, 4000),
        }));
        try {
          const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages,
            temperature: Math.min(1.5, Math.max(0, Number(body.temperature) || 0.7)),
            max_tokens: Math.min(1024, Math.max(16, parseInt(body.max_tokens, 10) || 320)),
          });
          // Workers AI returns { response: "..." } — wrap in OpenAI-style shape so the client doesn't change.
          const reply = (out && (out.response || out.result?.response)) || '';
          return json(env, {
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          }, 200, origin);
        } catch (e) {
          return text(env, 'ai error', 502, origin);
        }
      }

      if (path === '/ai/transcribe' && req.method === 'POST') {
        if (!env.AI) return text(env, 'ai disabled', 503, origin);
        const rl = await rateLimit(env, ip, 'ai_tx', 20, 60); // 20/min/IP
        if (!rl.ok) return text(env, 'rate limited', 429, origin);
        const ct = req.headers.get('Content-Type') || '';
        if (!ct.startsWith('multipart/form-data')) return text(env, 'expected multipart', 400, origin);
        try {
          const form = await req.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') return text(env, 'no file', 400, origin);
          const buf = await file.arrayBuffer();
          // 4 MB cap (Whisper input limit is small; this is also a DoS guard)
          if (buf.byteLength > 4 * 1024 * 1024) return text(env, 'file too large', 413, origin);
          const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
            audio: [...new Uint8Array(buf)],
          });
          return json(env, { text: (out && out.text) || '' }, 200, origin);
        } catch (e) {
          return text(env, 'ai error', 502, origin);
        }
      }

      if (path === '/' || path === '/health') return text(env, 'LinguaStart auth OK', 200, origin);
      return text(env, 'not found', 404, origin);
    } catch (e) {
      // Don't leak stack traces
      return text(env, 'error', 500, origin);
    }
  },
};
