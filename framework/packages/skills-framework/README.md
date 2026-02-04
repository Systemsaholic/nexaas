# Skills Framework

Markdown-based skill definitions that provide reusable capabilities to agents.

## How It Works

Skills are `.md` files discovered from two locations:

1. `framework/skills/` — default skills shipped with Nexaas
2. `workspace/skills/` — workspace-specific skills

When both define a skill with the same filename, the workspace version wins.

## File Format

Each skill is a single markdown file. The engine parses:

- **`# Heading`** — becomes the skill name
- **First non-heading line** — becomes the skill description

The rest of the file is the skill body, which can include steps, examples, and output format specifications.

## Example

```markdown
# Deploy Update

Push the latest changes to the production environment.

## Steps

1. Verify all tests pass.
2. Build the production artifacts.
3. Deploy to the target server.
4. Run post-deployment health checks.
```

## API Endpoints

- `GET /api/skills` — list all discovered skills
- `GET /api/skills/{name}` — get a specific skill by name or filename
