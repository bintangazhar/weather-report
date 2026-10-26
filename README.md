# Weather Monitor - Pontianak

Monitors weather for Pontianak hourly via cron and sends Telegram alert if rain probability ≥ threshold in next 3 hours.

**Data sources (priority):**
1. **OpenWeatherMap** - requires API key (free tier)
2. **Open-Meteo** - free, no key needed
3. **wttr.in** - free, no key needed

## Setup

```bash
cd /home/bintang/scripts/weather-pontianak
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys
```

## Configuration (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENWEATHER_API_KEY` | No | — | OpenWeatherMap API key (primary source) |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | **Yes** | — | Your user/group ID |
| `RAIN_THRESHOLD` | No | 0.5 | Rain probability threshold (0.0–1.0) |
| `CHECK_INTERVAL` | No | 3600 | Unused (cron handles scheduling) |

## Test Run

```bash
source venv/bin/activate
python weather_monitor.py
```

## Cron Job (Installed)

Runs **every hour at minute 5** (avoids top-of-hour API spikes):

```bash
5 * * * * cd /home/bintang/scripts/weather-pontianak && venv/bin/python weather_monitor.py >> cron.log 2>&1
```

**Manage cron:**
- View: `crontab -l`
- Logs: `tail -f /home/bintang/scripts/weather-pontianak/cron.log`
- Edit: `crontab -e`
- Remove: `crontab -r`

## Manual Cron Setup

```bash
./setup_cron.sh
```

## Get API Keys

1. **OpenWeatherMap** (optional, but recommended): https://openweathermap.org/api → "My API keys"
2. **Telegram Bot**: Message @BotFather → `/newbot` → copy token
3. **Chat ID** (easiest methods):
   - Message **@userinfobot** → replies with your ID
   - Message **@getmyid_bot** → replies with your ID
   - Or: message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` (find `"chat":{"id":...}`)

## Alert Format

```
🌧️ PERINGATAN HUJAN - PONTIANAK
⏰ Cek: 27/10/2026 05:13 WIB
📡 Sumber: Open-Meteo

• 06:00 WIB - Kemungkinan: 75%
  🌡️ 27.5°C | 💧 85% | 🌧️ 2.3mm
  📝 Hujan sedang

• 07:00 WIB - Kemungkinan: 60%
  🌡️ 28.0°C | 💧 82% | 🌧️ 1.1mm
  📝 Hujan ringan

⚠️ Bawa payung/jas hujan!
```

## Files

- `weather_monitor.py` - Main script (runs once, exits)
- `setup_cron.sh` - Installs cron job
- `.env.example` - Config template
- `requirements.txt` - Python deps
- `cron.log` - Cron output (gitignored)
- `weather_monitor.log` - Script logs (gitignored)