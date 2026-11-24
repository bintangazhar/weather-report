/**
 * Weather Monitor for Pontianak - Cloudflare Workers
 * Primary: OpenWeatherMap, Fallback: Open-Meteo, wttr.in
 * Runs hourly via Cron Trigger, sends Telegram alert if rain probability high in next 3 hours.
 * Deduplicates alerts using KV storage for notified forecast hours.
 */

export default {
  async scheduled(event, env, ctx) {
    const monitor = new WeatherMonitor(env);
    const success = await monitor.run();
    if (!success) {
      console.error("Weather check failed");
    }
  },

  async fetch(request, env, ctx) {
    // Manual trigger endpoint for testing: GET /run
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      // Rate limit: 10 requests/minute per IP
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = `ratelimit:${ip}`;
      const count = parseInt((await env.WEATHER_STATE.get(rlKey)) || "0", 10);
      if (count >= 10) {
        return new Response("Rate limited", { status: 429 });
      }
      await env.WEATHER_STATE.put(rlKey, String(count + 1), { expirationTtl: 60 });

      // Auth: require X-Cron-Secret header
      const auth = request.headers.get("X-Cron-Secret");
      if (!auth || auth !== env.CRON_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const monitor = new WeatherMonitor(env);
      const success = await monitor.run();
      return new Response(JSON.stringify({ success }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Weather Monitor Worker. Use GET /run to test manually.", { status: 200 });
  },
};

class WeatherMonitor {
  constructor(env) {
    this.env = env;
    this.openweatherKey = env.OPENWEATHER_API_KEY;
    this.telegramToken = env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = env.TELEGRAM_CHAT_ID;
    this.latitude = parseFloat(env.LATITUDE || "-0.03194");
    this.longitude = parseFloat(env.LONGITUDE || "109.325");
    this.timezone = env.TIMEZONE || "Asia/Pontianak";
    this.rainThreshold = parseFloat(env.RAIN_THRESHOLD || "0.5");
    // Minimum expected rain, in mm per 3 hours, for an alert to fire.
    this.minRainMm3h = parseFloat(env.MIN_RAIN_MM ?? "1.0");
    // Open-Meteo must give at least this probability for an OpenWeatherMap alert to be sent.
    this.crossCheckPop = parseFloat(env.CROSSCHECK_MIN_POP ?? "0.5");
    this.stateKey = "notified_hours";
    this.kv = env.WEATHER_STATE; // KV namespace binding (optional)

    if (!this.telegramToken || !this.telegramChatId) {
      throw new Error("Missing Telegram environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    }
  }

  async _loadNotifiedHours() {
    // Try KV first (persistent across runs), fallback to in-memory
    if (this.kv) {
      try {
        const data = await this.kv.get(this.stateKey, { type: "json" });
        if (data && Array.isArray(data)) {
          return this._cleanupOldHours(new Set(data));
        }
      } catch (e) {
        console.warn("KV read failed, using empty state:", e.message);
      }
    }
    return new Set();
  }

  async _saveNotifiedHours(hours) {
    if (this.kv) {
      try {
        await this.kv.put(this.stateKey, JSON.stringify([...hours].sort()));
        console.log("State saved to KV");
      } catch (e) {
        console.error("KV write failed:", e.message);
      }
    }
  }

  _cleanupOldHours(hours) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const valid = new Set();
    for (const h of hours) {
      const dt = new Date(h);
      if (dt >= cutoff) valid.add(h);
    }
    return valid;
  }

  _getForecastHourKey(dt) {
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), 0, 0).toISOString();
  }

  async _fetchJson(url, params = {}) {
    const searchParams = new URLSearchParams(params);
    const fullUrl = `${url}?${searchParams}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(fullUrl, {
        method: "GET",
        headers: { "User-Agent": "weather-pontianak-worker/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      return resp.json();
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  async fetchWeatherOpenWeather() {
    if (!this.openweatherKey) {
      console.warn("OpenWeatherMap API key not set, skipping");
      return null;
    }
    try {
      const data = await this._fetchJson("https://api.openweathermap.org/data/2.5/forecast", {
        lat: this.latitude,
        lon: this.longitude,
        appid: this.openweatherKey,
        units: "metric",
        lang: "id",
      });
      console.log("Weather fetched from OpenWeatherMap");
      return { data, source: "OpenWeatherMap" };
    } catch (e) {
      console.error("OpenWeatherMap fetch failed:", e.message);
      return null;
    }
  }

  async fetchWeatherOpenMeteo() {
    try {
      const data = await this._fetchJson("https://api.open-meteo.com/v1/forecast", {
        latitude: this.latitude,
        longitude: this.longitude,
        hourly: "precipitation_probability,precipitation,weathercode,temperature_2m,relativehumidity_2m",
        timezone: this.timezone,
        forecast_hours: 24,
      });
      console.log("Weather fetched from Open-Meteo");
      return { data, source: "Open-Meteo" };
    } catch (e) {
      console.error("Open-Meteo fetch failed:", e.message);
      return null;
    }
  }

  async fetchWeatherWttr() {
    try {
      const data = await this._fetchJson("https://wttr.in/Pontianak?format=j1", {});
      console.log("Weather fetched from wttr.in");
      return { data, source: "wttr.in" };
    } catch (e) {
      console.error("wttr.in fetch failed:", e.message);
      return null;
    }
  }

  checkRainRiskOpenWeather(result) {
    const { data, source } = result;
    const wib = this.timezone;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const alerts = [];

    for (const entry of data.list || []) {
      const dt = new Date(entry.dt * 1000); // UTC from OpenWeatherMap
      if (now <= dt && dt <= cutoff) {
        const pop = entry.pop || 0;
        const rainVolume = entry.rain?.["3h"] || 0;
        if (pop >= this.rainThreshold && this._meetsRainVolume(rainVolume, 3)) {
          const weather = entry.weather?.[0] || {};
          alerts.push({
            time: dt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: wib }),
            isoTime: dt.toISOString(),
            pop,
            description: (weather.description || "").charAt(0).toUpperCase() + (weather.description || "").slice(1),
            rainVolume,
            rainHours: 3,
            temp: entry.main?.temp || 0,
            humidity: entry.main?.humidity || 0,
          });
        }
      }
    }
    return { alerts, source };
  }

  checkRainRiskOpenMeteo(result) {
    const { data, source } = result;
    const wib = this.timezone;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const alerts = [];

    const hourly = data.hourly || {};
    const times = hourly.time || [];
    const pops = hourly.precipitation_probability || [];
    const precip = hourly.precipitation || [];
    const weatherCodes = hourly.weathercode || [];
    const temps = hourly.temperature_2m || [];
    const humidity = hourly.relativehumidity_2m || [];

    for (let i = 0; i < times.length; i++) {
      const dt = new Date(times[i] + "+07:00");
      if (now <= dt && dt <= cutoff) {
        const pop = (pops[i] || 0) / 100.0;
        if (pop >= this.rainThreshold && this._meetsRainVolume(precip[i] || 0, 1)) {
          alerts.push({
            time: dt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: wib }),
            isoTime: dt.toISOString(),
            pop,
            description: this._weatherCodeToText(weatherCodes[i]),
            rainVolume: precip[i] || 0,
            rainHours: 1,
            temp: temps[i] || 0,
            humidity: humidity[i] || 0,
          });
        }
      }
    }
    return { alerts, source };
  }

  checkRainRiskWttr(result) {
    const { data, source } = result;
    const wib = this.timezone;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const alerts = [];

    for (const day of data.weather || []) {
      for (const hour of day.hourly || []) {
        const dtStr = `${day.date} ${String(hour.time).padStart(4, "0")}`;
        const dt = new Date(`${dtStr.slice(0, 10)}T${dtStr.slice(11, 13)}:${dtStr.slice(13, 15)}:00+07:00`);
        const pop = (parseInt(hour.chanceofrain || "0", 10)) / 100.0;
        const precipMM = parseFloat(hour.precipMM || "0");
        if (now <= dt && dt <= cutoff && pop >= this.rainThreshold && this._meetsRainVolume(precipMM, 3)) {
          const desc = hour.weatherDesc?.[0]?.value || "Unknown";
          alerts.push({
            time: dt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: wib }),
            isoTime: dt.toISOString(),
            pop,
            description: desc,
            rainVolume: precipMM,
            rainHours: 3,
            temp: parseFloat(hour.tempC || "0"),
            humidity: parseInt(hour.humidity || "0", 10),
          });
        }
      }
    }
    return { alerts, source };
  }

  // Scale the per-3h minimum to the source's slot length (OWM/wttr: 3h, Open-Meteo: 1h).
  // OpenWeatherMap's pop saturates at 1 for Pontianak; avoid showing "100%" as certainty.
  _formatPop(pop) {
    if (pop >= 0.95) return "Sangat mungkin (≥95%)";
    return `${Math.round(pop * 100)}%`;
  }

  // OWM rain.3h covers the 3 hours ending at dt; Open-Meteo hourly values cover the
  // preceding hour, so the matching hours are (dt-3h, dt].
  async _crossCheckOpenMeteo(alerts) {
    const om = await this.fetchWeatherOpenMeteo();
    if (!om) {
      console.warn("Cross-check unavailable: Open-Meteo fetch failed, keeping OWM alerts");
      return alerts.map((a) => ({ ...a, crossCheck: null }));
    }
    const h = om.data.hourly || {};
    const times = (h.time || []).map((t) => new Date(t + "+07:00").getTime());
    const kept = [];
    for (const a of alerts) {
      const end = new Date(a.isoTime).getTime();
      const start = end - 3 * 60 * 60 * 1000;
      let maxPop = 0;
      let mm = 0;
      let n = 0;
      times.forEach((t, i) => {
        if (t > start && t <= end) {
          maxPop = Math.max(maxPop, (h.precipitation_probability?.[i] || 0) / 100);
          mm += h.precipitation?.[i] || 0;
          n++;
        }
      });
      if (n === 0) {
        console.warn(`Cross-check: no Open-Meteo hours for ${a.time}, keeping alert`);
        kept.push({ ...a, crossCheck: null });
      } else if (maxPop >= this.crossCheckPop) {
        kept.push({ ...a, crossCheck: { pop: maxPop, mm } });
      } else {
        console.log(`Cross-check: drop ${a.time} WIB (Open-Meteo pop=${Math.round(maxPop * 100)}% rain=${mm.toFixed(2)}mm)`);
      }
    }
    return kept;
  }

  _meetsRainVolume(mm, hours) {
    return mm >= (this.minRainMm3h * hours) / 3;
  }

  // BMKG hourly intensity categories (mm/jam).
  _rainIntensity(mm, hours) {
    const rate = mm / hours;
    if (rate < 1) return "Sangat ringan";
    if (rate < 5) return "Ringan";
    if (rate < 10) return "Sedang";
    if (rate < 20) return "Lebat";
    return "Sangat lebat";
  }

  _weatherCodeToText(code) {
    const codes = {
      0: "Cerah", 1: "Cerah berawan", 2: "Berawan sebagian", 3: "Berawan",
      45: "Kabut", 48: "Kabut beku", 51: "Gerimis ringan", 53: "Gerimis sedang",
      55: "Gerimis lebat", 56: "Gerimis beku ringan", 57: "Gerimis beku lebat",
      61: "Hujan ringan", 63: "Hujan sedang", 65: "Hujan lebat", 66: "Hujan beku ringan",
      67: "Hujan beku lebat", 71: "Salju ringan", 73: "Salju sedang", 75: "Salju lebat",
      77: "Butiran salju", 80: "Hujan gerimis ringan", 81: "Hujan gerimis sedang",
      82: "Hujan gerimis lebat", 85: "Hujan salju ringan", 86: "Hujan salju lebat",
      95: "Badai petir", 96: "Badai petir dengan hujan es kecil", 99: "Badai petir dengan hujan es besar",
    };
    return codes[code] || `Kode ${code}`;
  }

  formatAlert(alerts, source) {
    const wib = this.timezone;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const timeFormat = { hour: "2-digit", minute: "2-digit", timeZone: wib };
    const dateFormat = { day: "2-digit", month: "2-digit", year: "numeric", ...timeFormat };

    const lines = [
      "🌧️ *PERINGATAN HUJAN - PONTIANAK*",
      `⏰ Cek: ${now.toLocaleString("id-ID", dateFormat)} WIB`,
      `📅 Perkiraan: ${now.toLocaleTimeString("id-ID", timeFormat)}-${windowEnd.toLocaleTimeString("id-ID", timeFormat)} WIB (3 jam ke depan)`,
      `📡 Sumber: ${source}`,
      "",
    ];

    alerts.forEach((a, i) => {
      if (i > 0) lines.push("---");
      lines.push(
        `• ${a.time} WIB - Peluang: ${this._formatPop(a.pop)}`,
        `  🌧️ ${a.rainVolume.toFixed(2)} mm/${a.rainHours} jam (~${(a.rainVolume / a.rainHours).toFixed(2)} mm/jam) - Intensitas: ${this._rainIntensity(a.rainVolume, a.rainHours)}`,
        `  🌡️ ${a.temp.toFixed(1)}°C | 💧 ${a.humidity}%`,
        `  📝 ${a.description}`
      );
      if (a.crossCheck) {
        lines.push(`  🔁 Open-Meteo: ${Math.round(a.crossCheck.pop * 100)}% | ${a.crossCheck.mm.toFixed(2)} mm/3 jam`);
      } else if (a.crossCheck === null) {
        lines.push("  🔁 Cek silang Open-Meteo tidak tersedia");
      }
    });
    lines.push("", "⚠️ *Catatan: Prediksi cuaca bisa berubah. Cek berkala untuk update terbaru.*", "☔ Bawa payung/jas hujan!");
    return lines.join("\n");
  }

  async sendTelegram(message) {
    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    const payload = {
      chat_id: this.telegramChatId,
      text: message,
      parse_mode: "Markdown",
    };
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Telegram API ${resp.status}`);
      console.log("Telegram alert sent");
      return true;
    } catch (e) {
      console.error("Failed to send Telegram:", e.message);
      return false;
    }
  }

  async run() {
    const wib = this.timezone;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    console.log(`Checking rain risk: now=${now.toISOString()}, window=${now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: wib })}-${cutoff.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: wib })} WIB`);

    const notifiedHours = await this._loadNotifiedHours();

    // Try sources in order
    let result = await this.fetchWeatherOpenWeather();
    let parser = this.checkRainRiskOpenWeather.bind(this);

    if (!result) {
      console.log("Falling back to Open-Meteo...");
      result = await this.fetchWeatherOpenMeteo();
      parser = this.checkRainRiskOpenMeteo.bind(this);
    }
    if (!result) {
      console.log("Falling back to wttr.in...");
      result = await this.fetchWeatherWttr();
      parser = this.checkRainRiskWttr.bind(this);
    }
    if (!result) {
      console.error("All weather sources failed");
      return false;
    }

    let { alerts } = parser(result);
    if (result.source === "OpenWeatherMap" && alerts.length > 0) {
      alerts = await this._crossCheckOpenMeteo(alerts);
    }

    // Filter out already-notified hours
    const newAlerts = [];
    const newlyNotifiedHours = new Set();
    for (const a of alerts) {
      // Use stored ISO datetime for reliable parsing, fallback to time string
      let forecastDt;
      if (a.isoTime) {
        forecastDt = new Date(a.isoTime);
      } else {
        forecastDt = new Date(now);
        const [h, m] = a.time.split(":").map(Number);
        if (isNaN(h) || isNaN(m)) {
          console.warn(`Invalid time format: ${a.time}, skipping`);
          continue;
        }
        forecastDt.setHours(h, m, 0, 0);
      }
      if (forecastDt < now) forecastDt.setDate(forecastDt.getDate() + 1);
      const hourKey = this._getForecastHourKey(forecastDt);
      if (!notifiedHours.has(hourKey)) {
        newAlerts.push(a);
        newlyNotifiedHours.add(hourKey);
      } else {
        console.log(`Skipping already-notified hour: ${hourKey}`);
      }
    }

    if (newAlerts.length > 0) {
      const msg = this.formatAlert(newAlerts, result.source);
      console.log(`Alert triggered: ${newAlerts.length} new entries`);
      for (const a of newAlerts) {
        console.log(`  Forecast: ${a.time} WIB pop=${Math.round(a.pop * 100)}% rain=${a.rainVolume}mm/${a.rainHours}h ${a.description}`);
      }
      const success = await this.sendTelegram(msg);
      if (success) {
        notifiedHours.forEach(h => newlyNotifiedHours.add(h));
        await this._saveNotifiedHours(newlyNotifiedHours);
      }
      return success;
    } else {
      console.log(`No new high rain risk in next 3 hours (source: ${result.source})`);
      return true;
    }
  }
}