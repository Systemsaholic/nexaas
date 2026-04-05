/**
 * Weather Forecast Skill — E2E test skill.
 *
 * Simple skill: single Anthropic API call, no MCP tools needed.
 * Fetches weather via Open-Meteo API URL embedded in the prompt,
 * Claude summarizes the result, logs to activity_log.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast?latitude=45.5088&longitude=-73.5878&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=America/Montreal&forecast_days=3";

export const weatherForecast = task({
  id: "weather-forecast",
  queue: { name: "skills", concurrencyLimit: 3 },
  maxDuration: 60,
  run: async (payload?: { location?: string }) => {
    const workspaceId = process.env.NEXAAS_WORKSPACE ?? "unknown";

    logger.info(`Running weather forecast for ${workspaceId}`);

    // 1. Fetch weather data from Open-Meteo (free, no API key)
    let weatherData: string;
    try {
      const res = await fetch(OPEN_METEO_URL);
      weatherData = await res.text();
      logger.info("Weather data fetched from Open-Meteo");
    } catch (e) {
      weatherData = `Failed to fetch weather: ${(e as Error).message}`;
      logger.warn(`Weather fetch failed: ${(e as Error).message}`);
    }

    // 2. Call Claude to summarize
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      const errorMsg = "ANTHROPIC_API_KEY not configured — cannot run skill";
      logger.error(errorMsg);
      await logActivity(workspaceId, "error", errorMsg, "flag");
      return { success: false, error: errorMsg };
    }

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `You are a weather assistant for a business. Summarize the weather data concisely.
Return JSON only: {"summary": "one sentence", "temperature": number, "condition": "sunny|cloudy|rainy|snowy|other", "forecast": "2-3 day outlook"}`,
      messages: [
        {
          role: "user",
          content: `Here is the current weather data for Montreal:\n\n${weatherData}\n\nSummarize this for a business owner. JSON only.`,
        },
      ],
    });

    const rawOutput = response.content[0].type === "text" ? response.content[0].text : "";
    logger.info(`Claude response: ${rawOutput}`);

    // 3. Parse result
    let result: { summary: string; temperature: number; condition: string; forecast: string };
    try {
      result = JSON.parse(rawOutput);
    } catch {
      result = { summary: rawOutput, temperature: 0, condition: "unknown", forecast: rawOutput };
    }

    // 4. Log to activity_log
    await logActivity(
      workspaceId,
      "weather_check",
      result.summary,
      "auto_execute",
      {
        temperature: result.temperature,
        condition: result.condition,
        forecast: result.forecast,
        tokens_used: response.usage.input_tokens + response.usage.output_tokens,
      }
    );

    // 5. Log token usage
    await logTokenUsage(workspaceId, response);

    logger.info(`Weather skill complete: ${result.summary}`);
    return { success: true, ...result };
  },
});

async function logActivity(
  workspaceId: string,
  action: string,
  summary: string,
  tagRoute: string,
  details: Record<string, unknown> = {}
) {
  try {
    // Dynamic import to avoid bundling issues
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO activity_log (workspace_id, skill_id, action, summary, details, tag_route, created_at)
       VALUES ($1, 'operations/weather-forecast', $2, $3, $4, $5, NOW())`,
      [workspaceId, action, summary, JSON.stringify(details), tagRoute]
    );
    await pool.end();
  } catch (e) {
    logger.warn(`Failed to log activity: ${(e as Error).message}`);
  }
}

async function logTokenUsage(workspaceId: string, response: Anthropic.Message) {
  try {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO token_usage (workspace, agent, source, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, 'operations/weather-forecast', 'skill', $2, $3, $4, $5, NOW())`,
      [
        workspaceId,
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        // Approximate cost: Sonnet ~$3/MTok input, $15/MTok output
        (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000,
      ]
    );
    await pool.end();
  } catch (e) {
    logger.warn(`Failed to log token usage: ${(e as Error).message}`);
  }
}
