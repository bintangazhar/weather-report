#!/usr/bin/env python3
"""
Weather monitor for Pontianak - Primary: OpenWeatherMap, Fallback: Open-Meteo, wttr.in
Runs once per cron job, sends Telegram alert if rain probability is high in next 3 hours.
"""

import os
import sys
import logging
from datetime import datetime, timedelta, UTC
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("weather_monitor.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


class WeatherMonitor:
    def __init__(self):
        self.openweather_key = os.getenv("OPENWEATHER_API_KEY")
        self.telegram_token = os.getenv("TELEGRAM_BOT_TOKEN")
        self.telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID")
        # Pontianak coordinates (precise: 0°01′14″S, 109°20′29″E)
        self.latitude = -0.03194
        self.longitude = 109.325
        self.timezone = "Asia/Pontianak"
        self.rain_threshold = float(os.getenv("RAIN_THRESHOLD", "0.5"))

        if not all([self.telegram_token, self.telegram_chat_id]):
            raise ValueError("Missing Telegram environment variables")

    def fetch_weather_openweather(self) -> Optional[dict]:
        """Fetch from OpenWeatherMap - requires API key, most detailed."""
        if not self.openweather_key:
            logger.warning("OpenWeatherMap API key not set, skipping")
            return None
        url = "https://api.openweathermap.org/data/2.5/forecast"
        params = {
            "lat": self.latitude,
            "lon": self.longitude,
            "appid": self.openweather_key,
            "units": "metric",
            "lang": "id",
        }
        try:
            resp = requests.get(url, params=params, timeout=10)
            resp.raise_for_status()
            logger.info("Weather fetched from OpenWeatherMap")
            return resp.json()
        except requests.RequestException as e:
            logger.error(f"OpenWeatherMap fetch failed: {e}")
            return None

    def fetch_weather_open_meteo(self) -> Optional[dict]:
        """Fetch from Open-Meteo - free, no API key needed."""
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "hourly": "precipitation_probability,precipitation,weathercode,temperature_2m,relativehumidity_2m",
            "timezone": self.timezone,
            "forecast_hours": 24,
        }
        try:
            resp = requests.get(url, params=params, timeout=10)
            resp.raise_for_status()
            logger.info("Weather fetched from Open-Meteo")
            return resp.json()
        except requests.RequestException as e:
            logger.error(f"Open-Meteo fetch failed: {e}")
            return None

    def fetch_weather_wttr(self) -> Optional[dict]:
        """Fetch from wttr.in - free, no API key needed."""
        url = f"https://wttr.in/Pontianak?format=j1"
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            logger.info("Weather fetched from wttr.in")
            return resp.json()
        except requests.RequestException as e:
            logger.error(f"wttr.in fetch failed: {e}")
            return None

    def check_rain_risk_openweather(self, data: dict) -> list[dict]:
        """Parse OpenWeatherMap response for rain risk in next 3 hours."""
        wib = ZoneInfo(self.timezone)
        now = datetime.now(wib)
        cutoff = now + timedelta(hours=3)
        alerts = []

        for entry in data.get("list", []):
            dt_utc = datetime.fromtimestamp(entry["dt"], UTC)
            dt = dt_utc.astimezone(wib)
            logger.debug(f"OWM entry: dt_utc={dt_utc.isoformat()}, dt_wib={dt.isoformat()}, pop={entry.get('pop', 0)}")
            if now <= dt <= cutoff:
                pop = entry.get("pop", 0)
                if pop >= self.rain_threshold:
                    weather = entry["weather"][0]
                    rain_volume = entry.get("rain", {}).get("3h", 0)
                    alerts.append(
                        {
                            "time": dt.strftime("%H:%M"),
                            "pop": pop,
                            "description": weather["description"].capitalize(),
                            "rain_volume": rain_volume,
                            "temp": entry["main"]["temp"],
                            "humidity": entry["main"]["humidity"],
                        }
                    )
        return alerts

    def check_rain_risk_open_meteo(self, data: dict) -> list[dict]:
        """Parse Open-Meteo response for rain risk in next 3 hours."""
        wib = ZoneInfo(self.timezone)
        now = datetime.now(wib)
        cutoff = now + timedelta(hours=3)
        alerts = []

        hourly = data.get("hourly", {})
        times = hourly.get("time", [])
        pops = hourly.get("precipitation_probability", [])
        precip = hourly.get("precipitation", [])
        weather_codes = hourly.get("weathercode", [])
        temps = hourly.get("temperature_2m", [])
        humidity = hourly.get("relativehumidity_2m", [])

        for i, t_str in enumerate(times):
            dt = datetime.fromisoformat(t_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=wib)
            else:
                dt = dt.astimezone(wib)
            logger.debug(f"OM entry: t_str={t_str}, dt_wib={dt.isoformat()}, pop={pops[i] if i < len(pops) else 'N/A'}")
            if now <= dt <= cutoff:
                pop = pops[i] / 100.0 if pops[i] is not None else 0
                if pop >= self.rain_threshold:
                    alerts.append(
                        {
                            "time": dt.strftime("%H:%M"),
                            "pop": pop,
                            "description": self._weather_code_to_text(weather_codes[i]),
                            "rain_volume": precip[i] if precip[i] else 0,
                            "temp": temps[i] if temps[i] else 0,
                            "humidity": humidity[i] if humidity[i] else 0,
                        }
                    )
        return alerts

    def check_rain_risk_wttr(self, data: dict) -> list[dict]:
        """Parse wttr.in response for rain risk in next 3 hours."""
        wib = ZoneInfo(self.timezone)
        now = datetime.now(wib)
        cutoff = now + timedelta(hours=3)
        alerts = []

        for day in data.get("weather", []):
            for hour in day.get("hourly", []):
                dt_str = f"{day['date']} {hour['time'].zfill(4)}"
                dt = datetime.strptime(dt_str, "%Y-%m-%d %H%M").replace(tzinfo=wib)
                logger.debug(f"wttr entry: dt_str={dt_str}, dt_wib={dt.isoformat()}, pop={hour.get('chanceofrain', 0)}")
                if now <= dt <= cutoff:
                    pop = int(hour.get("chanceofrain", 0)) / 100.0
                    if pop >= self.rain_threshold:
                        desc = hour.get("weatherDesc", [{}])[0].get("value", "Unknown")
                        alerts.append(
                            {
                                "time": dt.strftime("%H:%M"),
                                "pop": pop,
                                "description": desc,
                                "rain_volume": float(hour.get("precipMM", 0)),
                                "temp": float(hour.get("tempC", 0)),
                                "humidity": int(hour.get("humidity", 0)),
                            }
                        )
        return alerts

    def _weather_code_to_text(self, code: int) -> str:
        """WMO weather code descriptions."""
        codes = {
            0: "Cerah",
            1: "Cerah berawan",
            2: "Berawan sebagian",
            3: "Berawan",
            45: "Kabut",
            48: "Kabut beku",
            51: "Gerimis ringan",
            53: "Gerimis sedang",
            55: "Gerimis lebat",
            56: "Gerimis beku ringan",
            57: "Gerimis beku lebat",
            61: "Hujan ringan",
            63: "Hujan sedang",
            65: "Hujan lebat",
            66: "Hujan beku ringan",
            67: "Hujan beku lebat",
            71: "Salju ringan",
            73: "Salju sedang",
            75: "Salju lebat",
            77: "Butiran salju",
            80: "Hujan gerimis ringan",
            81: "Hujan gerimis sedang",
            82: "Hujan gerimis lebat",
            85: "Hujan salju ringan",
            86: "Hujan salju lebat",
            95: "Badai petir",
            96: "Badai petir dengan hujan es kecil",
            99: "Badai petir dengan hujan es besar",
        }
        return codes.get(code, f"Kode {code}")

    def format_alert(self, alerts: list[dict], source: str) -> str:
        wib = ZoneInfo(self.timezone)
        now_wib = datetime.now(wib)
        window_end = now_wib + timedelta(hours=3)
        lines = [
            f"🌧️ *PERINGATAN HUJAN - PONTIANAK*",
            f"⏰ Cek: {now_wib.strftime('%d/%m/%Y %H:%M')} WIB",
            f"📅 Perkiraan: {now_wib.strftime('%H:%M')}-{window_end.strftime('%H:%M')} WIB (3 jam ke depan)",
            f"📡 Sumber: {source}",
            "",
        ]
        for a in alerts:
            lines.append(
                f"• {a['time']} WIB - Kemungkinan: {int(a['pop']*100)}%"
                f"\n  🌡️ {a['temp']:.1f}°C | 💧 {a['humidity']}% | 🌧️ {a['rain_volume']:.1f}mm"
                f"\n  📝 {a['description']}"
            )
        lines.append("\n⚠️ *Catatan: Prediksi cuaca bisa berubah. Cek berkala untuk update terbaru.*")
        lines.append("☔ Bawa payung/jas hujan!")
        return "\n".join(lines)

    def send_telegram(self, message: str) -> bool:
        url = f"https://api.telegram.org/bot{self.telegram_token}/sendMessage"
        payload = {
            "chat_id": self.telegram_chat_id,
            "text": message,
            "parse_mode": "Markdown",
        }
        try:
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            logger.info("Telegram alert sent")
            return True
        except requests.RequestException as e:
            logger.error(f"Failed to send Telegram: {e}")
            return False

    def run(self) -> bool:
        wib = ZoneInfo(self.timezone)
        now = datetime.now(wib)
        cutoff = now + timedelta(hours=3)
        logger.info(f"Checking rain risk: now={now.isoformat()}, window={now.strftime('%H:%M')}-{cutoff.strftime('%H:%M')} WIB")

        # Try OpenWeatherMap first (primary)
        data = self.fetch_weather_openweather()
        source = "OpenWeatherMap"
        parser = self.check_rain_risk_openweather

        # Fallback 1: Open-Meteo
        if not data:
            logger.info("Falling back to Open-Meteo...")
            data = self.fetch_weather_open_meteo()
            source = "Open-Meteo"
            parser = self.check_rain_risk_open_meteo

        # Fallback 2: wttr.in
        if not data:
            logger.info("Falling back to wttr.in...")
            data = self.fetch_weather_wttr()
            source = "wttr.in"
            parser = self.check_rain_risk_wttr

        if not data:
            logger.error("All weather sources failed")
            return False

        alerts = parser(data)

        if alerts:
            msg = self.format_alert(alerts, source)
            logger.info(f"Alert triggered: {len(alerts)} entries in window {now.strftime('%H:%M')}-{cutoff.strftime('%H:%M')} WIB")
            for a in alerts:
                logger.info(f"  Forecast: {a['time']} WIB pop={int(a['pop']*100)}% {a['description']}")
            return self.send_telegram(msg)
        else:
            logger.info(f"No high rain risk in next 3 hours (source: {source})")
            return True


def main():
    monitor = WeatherMonitor()
    success = monitor.run()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()