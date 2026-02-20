/**
 * Storm Sniper Elite — Data Layer
 *
 * Weather stream, ensemble tracking, pressure analysis, historical snapshots.
 * Multiple free weather sources → ensemble forecast → divergence detection.
 */

import type {
  WeatherSnapshot,
  EnsembleForecast,
  PressureAnomaly,
} from "./types.js";

// ─── Historical Ring Buffer ────────────────────────────────────

const MAX_HISTORY = 288; // 24h at 5-min intervals

class HistoricalDB {
  private weatherHistory: Map<string, WeatherSnapshot[]> = new Map();
  private priceHistory: Map<string, { price: number; timestamp: string }[]> = new Map();

  pushWeather(snapshot: WeatherSnapshot): void {
    const key = snapshot.location.toLowerCase();
    if (!this.weatherHistory.has(key)) this.weatherHistory.set(key, []);
    const arr = this.weatherHistory.get(key)!;
    arr.push(snapshot);
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  }

  getWeatherHistory(location: string, count: number = 12): WeatherSnapshot[] {
    return (this.weatherHistory.get(location.toLowerCase()) || []).slice(-count);
  }

  pushPrice(marketId: string, price: number): void {
    if (!this.priceHistory.has(marketId)) this.priceHistory.set(marketId, []);
    const arr = this.priceHistory.get(marketId)!;
    arr.push({ price, timestamp: new Date().toISOString() });
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  }

  getPriceHistory(marketId: string, count: number = 12): { price: number; timestamp: string }[] {
    return (this.priceHistory.get(marketId) || []).slice(-count);
  }

  getPriceNMinutesAgo(marketId: string, minutes: number): number | null {
    const history = this.priceHistory.get(marketId);
    if (!history || history.length === 0) return null;
    const cutoff = Date.now() - minutes * 60_000;
    // Find closest entry to that time
    let closest: { price: number; timestamp: string } | null = null;
    let minDelta = Infinity;
    for (const entry of history) {
      const delta = Math.abs(new Date(entry.timestamp).getTime() - cutoff);
      if (delta < minDelta) {
        minDelta = delta;
        closest = entry;
      }
    }
    return closest?.price ?? null;
  }
}

export const historicalDb = new HistoricalDB();

// ─── Weather Stream ────────────────────────────────────────────

/**
 * Fetch weather from wttr.in (fast, free, no API key).
 */
async function fetchWttrIn(location: string): Promise<WeatherSnapshot | null> {
  try {
    const resp = await Promise.race([
      fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
        headers: { Accept: "application/json" },
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    if (!(resp as Response).ok) return null;
    const data: any = await (resp as Response).json();
    const c = data.current_condition?.[0];
    if (!c) return null;

    return {
      location,
      timestamp: new Date().toISOString(),
      temperature: parseFloat(c.temp_C) || 20,
      pressure: parseFloat(c.pressure) || 1013,
      humidity: parseFloat(c.humidity) || 50,
      windSpeed: (parseFloat(c.windspeedKmph) || 0) / 3.6,
      precipMm: parseFloat(c.precipMM) || 0,
      chanceRain: Math.min(1, (parseFloat(c.precipMM) || 0) / 50),
      cloudCover: parseFloat(c.cloudcover) || 0,
      source: "wttr.in",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch from Open-Meteo (free, no key, high quality).
 */
async function fetchOpenMeteo(location: string): Promise<WeatherSnapshot | null> {
  try {
    // Geocode first
    const coords = KNOWN_COORDS[location.toLowerCase()] || { lat: 40.71, lon: -74.01 };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,precipitation,cloud_cover`;
    const resp = await Promise.race([
      fetch(url),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    if (!(resp as Response).ok) return null;
    const data: any = await (resp as Response).json();
    const c = data.current;
    if (!c) return null;

    return {
      location,
      timestamp: new Date().toISOString(),
      temperature: c.temperature_2m ?? 20,
      pressure: c.surface_pressure ?? 1013,
      humidity: c.relative_humidity_2m ?? 50,
      windSpeed: (c.wind_speed_10m ?? 0) / 3.6,
      precipMm: c.precipitation ?? 0,
      chanceRain: Math.min(1, (c.precipitation ?? 0) / 20),
      cloudCover: c.cloud_cover ?? 0,
      source: "open-meteo",
    };
  } catch {
    return null;
  }
}

const KNOWN_COORDS: Record<string, { lat: number; lon: number }> = {
  "new york": { lat: 40.71, lon: -74.01 },
  "los angeles": { lat: 34.05, lon: -118.24 },
  "chicago": { lat: 41.88, lon: -87.63 },
  "denver": { lat: 39.74, lon: -104.99 },
  "miami": { lat: 25.76, lon: -80.19 },
  "london": { lat: 51.51, lon: -0.13 },
  "tokyo": { lat: 35.68, lon: 139.65 },
  "sydney": { lat: -33.87, lon: 151.21 },
  "paris": { lat: 48.86, lon: 2.35 },
  "berlin": { lat: 52.52, lon: 13.41 },
  "singapore": { lat: 1.35, lon: 103.82 },
  "california": { lat: 36.78, lon: -119.42 },
  "seattle": { lat: 47.61, lon: -122.33 },
  "san francisco": { lat: 37.77, lon: -122.42 },
  "houston": { lat: 29.76, lon: -95.37 },
};

// ─── Ensemble Tracker ──────────────────────────────────────────

/**
 * Fetch weather from multiple sources → create ensemble.
 * Divergence between sources = signal.
 */
export async function fetchEnsembleForecast(location: string): Promise<EnsembleForecast> {
  const fetchers = [fetchWttrIn(location), fetchOpenMeteo(location)];
  const results = await Promise.allSettled(fetchers);

  const sources: WeatherSnapshot[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      sources.push(r.value);
      historicalDb.pushWeather(r.value);
    }
  }

  // Need at least 1 source
  if (sources.length === 0) {
    return {
      location,
      timestamp: new Date().toISOString(),
      sources: [],
      meanTemp: 20,
      stdTemp: 0,
      meanRain: 0.3,
      stdRain: 0,
      meanPressure: 1013,
      stdPressure: 0,
      divergenceScore: 0,
    };
  }

  const temps = sources.map((s) => s.temperature);
  const rains = sources.map((s) => s.chanceRain);
  const pressures = sources.map((s) => s.pressure);

  const meanTemp = mean(temps);
  const stdTemp = std(temps);
  const meanRain = mean(rains);
  const stdRain = std(rains);
  const meanPressure = mean(pressures);
  const stdPressure = std(pressures);

  // Divergence: how much do sources disagree? Normalized 0–1
  const tempDiv = sources.length > 1 ? Math.min(1, stdTemp / 5) : 0;
  const rainDiv = sources.length > 1 ? Math.min(1, stdRain / 0.3) : 0;
  const divergenceScore = (tempDiv + rainDiv) / 2;

  return {
    location,
    timestamp: new Date().toISOString(),
    sources,
    meanTemp,
    stdTemp,
    meanRain,
    stdRain,
    meanPressure,
    stdPressure,
    divergenceScore,
  };
}

// ─── Pressure Analyzer ────────────────────────────────────────

/**
 * Analyze atmospheric pressure for anomalies.
 * Rapid pressure drops → storm signals.
 */
export function analyzePressure(location: string, currentPressure: number): PressureAnomaly {
  const history = historicalDb.getWeatherHistory(location, MAX_HISTORY);
  const pressures = history.map((h) => h.pressure).filter((p) => p > 0);

  if (pressures.length < 2) {
    return {
      current: currentPressure,
      historical24hMean: currentPressure,
      historical7dMean: currentPressure,
      zScore: 0,
      changeRate: 0,
      isAnomaly: false,
    };
  }

  const hist24h = pressures.slice(-288); // last 24h
  const hist7d = pressures;
  const mean24h = mean(hist24h);
  const mean7d = mean(hist7d);
  const std24h = std(hist24h) || 1;

  const zScore = (currentPressure - mean24h) / std24h;

  // Change rate: pressure change per hour based on last few readings
  const recent = pressures.slice(-12); // last hour
  const changeRate =
    recent.length >= 2
      ? (recent[recent.length - 1] - recent[0]) / (recent.length * 5 / 60)
      : 0;

  return {
    current: currentPressure,
    historical24hMean: mean24h,
    historical7dMean: mean7d,
    zScore,
    changeRate,
    isAnomaly: Math.abs(zScore) > 2 || Math.abs(changeRate) > 3,
  };
}

// ─── Math Helpers ──────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

export { mean, std };
