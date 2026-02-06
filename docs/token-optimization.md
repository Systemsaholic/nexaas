# Token Optimization Guide

Minimize context window usage while maintaining agent capability through tiered prompt loading.

## The Problem

Large agent prompts waste tokens on every API call:
- A 25 KB prompt costs ~6,250 tokens per request
- Most detailed workflows are rarely needed per-call
- Context window limits become bottlenecks

## Solution: Tiered Loading Pattern

Split agent instructions into two tiers:

| Tier | Location | Loaded | Contains |
|------|----------|--------|----------|
| **Core** | `prompt.md` | Always | Identity, workflow, critical rules |
| **Reference** | `reference/*.md` | On-demand | Detailed procedures, edge cases |

## Implementation

### Before (Monolithic)

```
agents/publisher/
└── prompt.md          # 25 KB - everything in one file
```

### After (Tiered)

```
agents/publisher/
├── prompt.md          # 3 KB - core workflow only
└── reference/
    ├── video-upload.md      # Detailed video handling
    ├── day-validation.md    # Day-specific content rules
    └── image-freshness.md   # Image reuse tracking
```

## What Goes Where

### Core Prompt (prompt.md)

Keep these in the main prompt (~100-150 lines max):

- **Agent identity** - Who am I, what do I do
- **Core workflow** - 4-6 numbered steps
- **Critical rules** - Safety constraints, never-do items
- **API format** - Essential syntax/format rules
- **Quick reference** - Tables of IDs, codes, mappings
- **Reference pointers** - "See `reference/X.md` for details"

### Reference Files (reference/*.md)

Extract these to separate files:

- **Detailed procedures** - Step-by-step workflows
- **Edge cases** - Error handling, validation rules
- **Platform specifics** - Platform-by-platform variations
- **Examples** - Code samples, templates
- **Historical context** - Why decisions were made

## Example Transformation

### Before (Publisher Agent - 849 lines)

```markdown
# Publisher Agent

Publish posts to social media platforms.

## Core Workflow
[20 lines]

## Video Upload Process
[150 lines of detailed curl commands, error handling]

## Day-Specific Validation
[80 lines of validation rules, rejection formats]

## Image Freshness Rules
[60 lines of tracking logic, deduplication]

## Platform-Specific Guidelines
[200 lines per platform]

## Error Recovery
[100 lines]

... (continues for 849 lines)
```

### After (Publisher Agent - 112 lines)

**prompt.md:**
```markdown
# Publisher Agent

Publish posts to social media platforms.

## Core Workflow
1. Read post YAML from `/Marketing/Social/[Platform]/`
2. Validate media URL (must be real, not fabricated)
3. Publish via `posts_create` or `posts_cross_post`
4. Report success with post ID

## Critical Rules
1. Validate media - Reject posts without valid URLs
2. Use correct API format - strings, not lists
3. Default to scheduled - `publish_now=False`
4. Check compliance status - Only publish APPROVED

## API Format

posts_create(
    content="...",
    platform="instagram",      # String, singular
    media_urls="https://...",  # String, NOT list
)

## Reference Documentation

For detailed workflows:
- Video uploads: `reference/video-upload.md`
- Day validation: `reference/day-validation.md`
- Image tracking: `reference/image-freshness.md`
```

**Result:** 88% token reduction (25 KB → 3 KB)

## Benefits

| Metric | Before | After |
|--------|--------|-------|
| Tokens per call | ~6,250 | ~750 |
| Context available | Limited | More room for conversation |
| Agent focus | Scattered | Clear priorities |
| Maintenance | Edit one huge file | Edit relevant section |

## When to Load Reference Files

Agents should read reference files when:

1. **Encountering specific scenarios** - e.g., video content triggers `video-upload.md`
2. **Error conditions** - Check error handling in reference docs
3. **User asks for details** - Load relevant reference for explanation
4. **First time doing task** - Review full procedure

## Common Extraction Candidates

| Content Type | Typical Savings |
|--------------|-----------------|
| API documentation | 40-60% |
| Platform-specific rules | 30-50% |
| Error handling procedures | 20-40% |
| Compliance checklists | 15-25% |
| Example code/templates | 25-35% |

## Anti-Patterns

**Don't extract:**
- Identity and purpose (always needed)
- Core workflow steps (fundamental to operation)
- Safety constraints (must be ever-present)
- Quick-reference tables (frequently accessed)

**Don't over-fragment:**
- Avoid >5 reference files per agent
- Group related content together
- Keep file names self-explanatory

## Measuring Success

Before optimization:
```bash
wc -c agents/*/prompt.md | sort -n
```

After optimization:
```bash
# Prompt files should be <5 KB
wc -c agents/*/prompt.md | sort -n

# Reference totals for validation
find agents/*/reference -name "*.md" -exec wc -c {} + | tail -1
```

Target: Core prompts under 5 KB, total with references under 15 KB.
