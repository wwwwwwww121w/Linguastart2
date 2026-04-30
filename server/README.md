# LinguaStart Auth Backend

A single Cloudflare Worker that handles email-OTP and Telegram login for the app.

## Endpoints

- `POST /auth/email/send`      → `{ email }` → sends 6-digit code via Resend, stores in KV
- `POST /auth/email/verify`    → `{ email, code }` → `{ token }` on success
- `POST /telegram/webhook`     → Telegram update; stores user info under the `start` sid
- `GET  /auth/tg/poll?sid=...` → returns 204 while pending, 200 + user JSON when paired

## Deploy

```bash
cd server
npm install -g wrangler
wrangler login                         # OR: export CLOUDFLARE_API_TOKEN=...
wrangler kv namespace create SESSIONS  # paste returned id into wrangler.toml
wrangler secret put RESEND_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put AUTH_SHARED_SECRET # any long random string
# optional:
# wrangler secret put FROM_EMAIL ALLOWED_ORIGIN
wrangler deploy
```

After deploy you'll get a URL like `https://linguastart-auth.your-name.workers.dev`.

Set the Telegram webhook so the bot delivers updates here:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://linguastart-auth.your-name.workers.dev/telegram/webhook"
```

In the LinguaStart APK build, set:
```
AUTH_BACKEND_URL=https://linguastart-auth.your-name.workers.dev
TELEGRAM_BOT_USERNAME=your_bot_name_without_at
TELEGRAM_BOT_ID=123456789
```
The build script will inject them into the HTML.
