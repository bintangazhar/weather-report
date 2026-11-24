# Weather Pontianak - Cloudflare Workers

Cloudflare Workers version of the Python weather monitor for Pontianak. Runs hourly via Cron Trigger, checks rain probability from multiple sources (OpenWeatherMap → Open-Meteo → wttr.in), and sends Telegram alerts with deduplication using KV storage.

## Quick Start

```bash
cd cloudflare-worker
npm install -g wrangler@latest
wrangler login

# Create KV namespace for persistent state (optional but recommended)
wrangler kv namespace create WEATHER_STATE
# Copy the binding ID to wrangler.toml [[kv_namespaces]] section

# Copy example env file and fill in your secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys

# Test locally
wrangler dev

# Test manual trigger
curl http://localhost:8787/run

# Deploy to Cloudflare
wrangler deploy

# Set production secrets (not in .dev.vars)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put OPENWEATHER_API_KEY
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Chat ID to send alerts to |
| `OPENWEATHER_API_KEY` | No | OpenWeatherMap API key (primary source) |
| `RAIN_THRESHOLD` | No | Rain probability threshold 0-1 (default: 0.5) |
| `MIN_RAIN_MM` | No | Minimum expected rain in mm per 3 hours to alert (default: 1.0; scaled for hourly sources) |
| `LATITUDE` | No | Location latitude (default: -0.03194) |
| `LONGITUDE` | No | Location longitude (default: 109.325) |
| `TIMEZONE` | No | IANA timezone (default: Asia/Pontianak) |

## How It Works

- **Cron Trigger**: Runs at minute 0 every hour (`0 * * * *`)
- **Weather Sources** (fallback order):
  1. OpenWeatherMap (requires API key, most detailed)
  2. Open-Meteo (free, no key needed)
  3. wttr.in (free, no key needed)
- **Alert Window**: Next 3 hours from current time
- **Deduplication**: Tracks notified forecast hours in KV, cleans up entries >24h old
- **Telegram**: Sends formatted Markdown message with rain details

## KV Storage

The `WEATHER_STATE` KV namespace stores `notified_hours` to prevent duplicate alerts across Worker invocations. Without KV, deduplication only works within a single run (in-memory).

## Local Development

```bash
wrangler dev --local  # Uses Miniflare for local simulation
```

Note: Cron triggers don't run in local dev. Use `GET /run` endpoint to test manually.

## Files

- `wrangler.toml` - Worker config, cron schedule, env vars
- `src/index.js` - Main worker logic
- `.dev.vars.example` - Template for local secrets