/**
 * Weather Forecast Skill — uses open-meteo MCP server.
 *
 * Claude calls the open-meteo MCP tools directly (get_weather_forecast, etc.)
 * The task code does NOT fetch data — MCP handles all external calls.
 * MCP servers are loaded from contract.yaml by executeSkill().
 */

import { task } from "@trigger.dev/sdk/v3";
import { executeSkill } from "../../../trigger/lib/skill-executor.js";

export const weatherForecast = task({
  id: "weather-forecast",
  queue: { name: "skills", concurrencyLimit: 3 },
  maxDuration: 60,
  run: async (payload?: { location?: string }) => {
    return executeSkill({
      skillId: "operations/weather-forecast",
      workspaceId: process.env.NEXAAS_WORKSPACE ?? "unknown",
      input: {
        location: payload?.location ?? "Montreal",
        task: "Get the current weather conditions and 3-day forecast",
      },
    });
  },
});
