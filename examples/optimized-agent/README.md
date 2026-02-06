# Optimized Agent Example

This example demonstrates the **tiered loading pattern** for token-efficient agents.

## The Pattern

Instead of one large prompt file, split agent instructions into tiers:

```
agents/content-publisher/
├── config.yaml           # Agent configuration
├── prompt.md             # Core workflow (~100 lines)
└── reference/            # Detailed procedures (loaded on-demand)
    ├── video-upload.md
    ├── image-validation.md
    └── platform-limits.md
```

## Benefits

| Metric | Monolithic | Tiered |
|--------|------------|--------|
| Prompt size | 25 KB | 3 KB |
| Tokens/call | ~6,250 | ~750 |
| Context usage | High | Low |

## Core Prompt Structure

The main `prompt.md` should contain only:

1. **Identity** - What the agent does (2-3 lines)
2. **Core Workflow** - 4-6 numbered steps
3. **Critical Rules** - Safety/never-do constraints
4. **Quick Reference** - Essential tables (IDs, codes)
5. **Reference Pointers** - Links to detailed docs

## Reference Files

Extract to `reference/` directory:

- Detailed step-by-step procedures
- Platform-specific variations
- Error handling workflows
- Examples and templates

## When Agents Load References

The agent reads reference files when:

- Encountering specific scenarios (e.g., video content)
- Handling errors or edge cases
- User asks for detailed explanation
- First time performing a task type

## Usage

Copy this example as a template:

```bash
cp -r examples/optimized-agent/agents/content-publisher workspace/agents/my-agent
```

Then customize:

1. Edit `config.yaml` with your MCP servers and tools
2. Rewrite `prompt.md` for your use case
3. Create `reference/` files for detailed procedures

## Documentation

See `docs/token-optimization.md` for the complete guide.
