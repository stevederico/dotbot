/**
 * Weather tool using Open-Meteo API (no API key required)
 */
export const weatherTools = [
  {
    name: "weather_get",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name or location" },
      },
      required: ["location"],
    },
    execute: async (input, signal) => {
      try {
        // Geocode location
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.location)}&count=1`,
          { signal }
        );
        if (!geoRes.ok) return `Geocoding failed: ${geoRes.status}`;
        const geo = await geoRes.json();
        if (!geo.results?.length) return `Location not found: ${input.location}`;
        const { latitude, longitude, name, country } = geo.results[0];

        // Fetch weather
        const wxRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph`,
          { signal }
        );
        if (!wxRes.ok) return `Weather fetch failed: ${wxRes.status}`;
        const wx = await wxRes.json();
        const c = wx.current;
        return `Weather for ${name}, ${country}:\nTemperature: ${c.temperature_2m}°F\nHumidity: ${c.relative_humidity_2m}%\nWind: ${c.wind_speed_10m} mph\nCondition code: ${c.weather_code}`;
      } catch (err) {
        return `Error getting weather: ${err.message}`;
      }
    },
  },
];
