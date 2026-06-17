/**
 * Weather tool using Open-Meteo API (no API key required)
 */

import type { ToolDefinition, JsonObject } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Convert WMO weather code to human-readable text.
 * @param code - WMO weather condition code
 * @returns Human-readable weather condition
 */
function weatherCodeToText(code: number): string {
  const codes: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
  };
  return codes[code] || "Unknown";
}

export const weatherTools: ToolDefinition[] = [
  {
    name: "weather_get",
    description: "Get weather for a city.",
    directReturn: true,
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name or location" },
      },
      required: ["location"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined): Promise<string> => {
      try {
        // Geocode location
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(input.location))}&count=1`,
          { signal }
        );
        if (!geoRes.ok) return `Geocoding failed: ${geoRes.status}`;
        const geo: unknown = await geoRes.json();
        const results =
          isRecord(geo) && Array.isArray(geo.results) ? geo.results : [];
        if (!results.length) return `Location not found: ${String(input.location)}`;
        const first: unknown = results[0];
        if (!isRecord(first)) return `Location not found: ${String(input.location)}`;
        const latitude = first.latitude;
        const longitude = first.longitude;
        const name = first.name;
        const country = first.country;

        // Fetch weather
        const wxRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph`,
          { signal }
        );
        if (!wxRes.ok) return `Weather fetch failed: ${wxRes.status}`;
        const wx: unknown = await wxRes.json();
        const current: Record<string, unknown> =
          isRecord(wx) && isRecord(wx.current) ? wx.current : {};
        const c = current;
        return JSON.stringify({
          _ui: {
            component: "weather",
            version: 1,
            data: {
              location: `${name}, ${country}`,
              temperature: c.temperature_2m,
              unit: "F",
              humidity: c.relative_humidity_2m,
              windSpeed: c.wind_speed_10m,
              windUnit: "mph",
              conditionCode: c.weather_code,
              conditionText: weatherCodeToText(Number(c.weather_code))
            },
            fallback: `Weather for ${name}: ${c.temperature_2m}°F, ${weatherCodeToText(Number(c.weather_code))}`
          }
        });
      } catch (err) {
        return `Error getting weather: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
