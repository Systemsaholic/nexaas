# Weather Forecast — Standard Operating Procedure

## Purpose
Retrieve current weather conditions and multi-day forecast for the client's location. Deliver a business-relevant summary.

## Steps

1. **Geocode location** — Use the open-meteo `geocode` tool to resolve the requested location to coordinates
2. **Fetch weather data** — Use the `get_weather_forecast` tool with coordinates for current conditions + 3-day forecast
3. **Analyze for business impact** — Note any weather that could affect operations (storms, extreme temperatures, events)
4. **Generate summary** — Produce a concise, business-relevant weather summary using the client's Brand Voice tone

## Output Format

Return JSON:
```json
{
  "summary": "One-sentence current conditions",
  "temperature": number (celsius),
  "condition": "sunny|cloudy|rainy|snowy|windy|overcast|other",
  "forecast": "2-3 sentence outlook",
  "reasoning": "Brief note on data used"
}
```

## Feedback Gates

```yaml
feedback-gate:
  id: weather-share
  source: user
  target: role:owner
  channel-requires: { direction: two-way }
  timeout: 24h
  on-timeout: auto-approve
```

## Error Handling

- If geocode fails: return error with "Location not found" message
- If forecast API fails: return last known data if available, flag for review
- If location is ambiguous: pick the most likely match, note the assumption in reasoning
