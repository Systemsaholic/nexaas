# Image Validation Rules

Ensure images are valid, fresh, and appropriate for scheduled date.

## Freshness Rules

Avoid reusing images too frequently.

| Content Type | Minimum Gap Before Reuse |
|--------------|--------------------------|
| Stock photos | 14 days |
| Custom graphics | 7 days |
| Video thumbnails | 21 days |

## Freshness Check Process

```python
# Before publishing:
1. Query image_usage_log for media_url
2. Check last_used date
3. IF within freshness window: REJECT
4. After publish: Record usage in log
```

## Day-Specific Content

Some images contain day-specific branding that must match the scheduled date.

| Pattern | Required Day |
|---------|--------------|
| "Monday Motivation" | Monday |
| "Travel Tuesday" | Tuesday |
| "Wellness Wednesday" | Wednesday |
| "Throwback Thursday" | Thursday |
| "#FridayVibes" | Friday |
| "#WeekendVibes" | Saturday/Sunday |

## Validation Process

1. Scan image filename and alt text for day patterns
2. Check caption/content for day hashtags
3. Compare to scheduled publish day
4. Reject if mismatch

## Rejection Format

```
REJECTED: [Platform] post for [Date]
  Reason: [Freshness/Day mismatch]
  Image: [URL]
  Details: [Specific issue]
  Action: [Resolution steps]
```
