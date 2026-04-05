import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = "https://api.open-meteo.com/v1";
const GEO_BASE = "https://geocoding-api.open-meteo.com/v1";
const AIR_BASE = "https://air-quality-api.open-meteo.com/v1";
const MARINE_BASE = "https://marine-api.open-meteo.com/v1";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Open-Meteo API error ${res.status}: ${body}`);
  }
  return res.json();
}

function jsonResult(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: "open-meteo",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "geocode",
  "Search for a location by name and return coordinates. Use this first to get latitude/longitude for weather queries.",
  {
    name: z.string().describe("Location name to search (e.g. 'New York', 'Paris')"),
    count: z.number().int().min(1).max(10).default(3).describe("Max results to return"),
    language: z.string().default("en").describe("Language for results (ISO 639-1)"),
  },
  async ({ name, count, language }) => {
    const params = new URLSearchParams({
      name,
      count: String(count),
      language,
      format: "json",
    });
    const data = await fetchJson(`${GEO_BASE}/search?${params}`);
    const results = (data.results ?? []).map((r: any) => ({
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      country: r.country,
      country_code: r.country_code,
      admin1: r.admin1,
      timezone: r.timezone,
      population: r.population,
      elevation: r.elevation,
    }));
    return jsonResult({ results });
  }
);

server.tool(
  "get_weather_forecast",
  "Get weather forecast for a location. Returns current conditions plus hourly and daily forecasts. Supports up to 16 days ahead.",
  {
    latitude: z.number().describe("Latitude of the location"),
    longitude: z.number().describe("Longitude of the location"),
    forecast_days: z.number().int().min(1).max(16).default(3).describe("Number of forecast days (1-16)"),
    hourly: z
      .array(z.string())
      .default([
        "temperature_2m",
        "relative_humidity_2m",
        "precipitation_probability",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
      ])
      .describe("Hourly variables to include"),
    daily: z
      .array(z.string())
      .default([
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "sunrise",
        "sunset",
        "precipitation_sum",
        "precipitation_probability_max",
        "wind_speed_10m_max",
      ])
      .describe("Daily variables to include"),
    current: z
      .array(z.string())
      .default([
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "is_day",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
      ])
      .describe("Current weather variables to include"),
    temperature_unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
    wind_speed_unit: z.enum(["kmh", "ms", "mph", "kn"]).default("kmh"),
    precipitation_unit: z.enum(["mm", "inch"]).default("mm"),
    timezone: z.string().default("auto").describe("Timezone for times (e.g. 'America/New_York', or 'auto')"),
  },
  async ({
    latitude,
    longitude,
    forecast_days,
    hourly,
    daily,
    current,
    temperature_unit,
    wind_speed_unit,
    precipitation_unit,
    timezone,
  }) => {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      forecast_days: String(forecast_days),
      hourly: hourly.join(","),
      daily: daily.join(","),
      current: current.join(","),
      temperature_unit,
      wind_speed_unit,
      precipitation_unit,
      timezone,
    });
    const data = await fetchJson(`${BASE}/forecast?${params}`);
    return jsonResult(data);
  }
);

server.tool(
  "get_historical_weather",
  "Get historical weather data for a location and date range. Useful for comparing past conditions.",
  {
    latitude: z.number().describe("Latitude"),
    longitude: z.number().describe("Longitude"),
    start_date: z.string().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().describe("End date (YYYY-MM-DD)"),
    daily: z
      .array(z.string())
      .default([
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "wind_speed_10m_max",
      ])
      .describe("Daily variables to include"),
    temperature_unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
    timezone: z.string().default("auto"),
  },
  async ({ latitude, longitude, start_date, end_date, daily, temperature_unit, timezone }) => {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      start_date,
      end_date,
      daily: daily.join(","),
      temperature_unit,
      timezone,
    });
    const data = await fetchJson(`${BASE}/forecast?${params}`);
    return jsonResult(data);
  }
);

server.tool(
  "get_air_quality",
  "Get current and forecast air quality data (PM2.5, PM10, ozone, NO2, etc.) for a location.",
  {
    latitude: z.number().describe("Latitude"),
    longitude: z.number().describe("Longitude"),
    hourly: z
      .array(z.string())
      .default([
        "pm10",
        "pm2_5",
        "carbon_monoxide",
        "nitrogen_dioxide",
        "ozone",
        "european_aqi",
        "us_aqi",
      ])
      .describe("Hourly air quality variables"),
    current: z
      .array(z.string())
      .default(["european_aqi", "us_aqi", "pm10", "pm2_5"])
      .describe("Current air quality variables"),
    forecast_days: z.number().int().min(1).max(5).default(1).describe("Forecast days (1-5)"),
    timezone: z.string().default("auto"),
  },
  async ({ latitude, longitude, hourly, current, forecast_days, timezone }) => {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      hourly: hourly.join(","),
      current: current.join(","),
      forecast_days: String(forecast_days),
      timezone,
    });
    const data = await fetchJson(`${AIR_BASE}/air-quality?${params}`);
    return jsonResult(data);
  }
);

server.tool(
  "get_marine_forecast",
  "Get marine/ocean weather forecast — wave height, period, direction, sea temperature.",
  {
    latitude: z.number().describe("Latitude (ocean location)"),
    longitude: z.number().describe("Longitude (ocean location)"),
    hourly: z
      .array(z.string())
      .default([
        "wave_height",
        "wave_direction",
        "wave_period",
        "wind_wave_height",
        "swell_wave_height",
        "ocean_current_velocity",
      ])
      .describe("Hourly marine variables"),
    daily: z
      .array(z.string())
      .default(["wave_height_max", "wave_direction_dominant", "wave_period_max"])
      .describe("Daily marine variables"),
    forecast_days: z.number().int().min(1).max(7).default(3).describe("Forecast days (1-7)"),
    timezone: z.string().default("auto"),
  },
  async ({ latitude, longitude, hourly, daily, forecast_days, timezone }) => {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      hourly: hourly.join(","),
      daily: daily.join(","),
      forecast_days: String(forecast_days),
      timezone,
    });
    const data = await fetchJson(`${MARINE_BASE}/marine?${params}`);
    return jsonResult(data);
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Open-Meteo MCP server failed to start:", err);
  process.exit(1);
});
