# Health Check

Run a system health check across all Nexaas components.

## Steps

1. Call `GET /api/health` to verify engine responsiveness.
2. Check database connectivity via the health endpoint's `db` field.
3. Review worker pool status: how many workers are active vs idle.
4. Check for recent ops alerts (severity: warning or critical).
5. Summarize findings with a pass/fail for each component.

## Output Format

```
Engine:   ✓ healthy
Database: ✓ connected
Workers:  ✓ 3/3 active
Alerts:   ✓ no critical alerts
```

If any component fails, include the error details and suggested next steps.
