# Video Upload Workflow

Videos cannot use external URLs directly. They must be uploaded to the platform's CDN first.

## Image vs Video Handling

| Media Type | External URL Works? | Required Action |
|------------|---------------------|-----------------|
| Images (.jpg, .png) | Yes | Use URL directly |
| Videos (.mp4, .mov) | No | Upload to CDN first |

## Upload Process

```python
# 1. Download video locally
download_file(source_url, "/tmp/video.mp4")

# 2. Get presigned upload URL
presign = media_get_presigned_url(
    filename="video.mp4",
    content_type="video/mp4"
)

# 3. Upload to CDN
upload_file(presign["upload_url"], "/tmp/video.mp4")

# 4. Use public URL in post
posts_create(
    content="...",
    media_urls=presign["public_url"],
    ...
)
```

## Video Requirements

| Constraint | Limit |
|------------|-------|
| Max size | 500 MB |
| Max duration | 10 minutes |
| Formats | .mp4, .mov, .webm |
| Min resolution | 720p |

## Error Handling

| Error | Action |
|-------|--------|
| Upload timeout | Retry with exponential backoff |
| Invalid format | Reject with format error |
| Size exceeded | Reject with size error |
| CDN unavailable | Queue for retry |
