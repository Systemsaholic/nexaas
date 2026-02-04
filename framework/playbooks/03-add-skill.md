# Playbook 03: Add a Skill

Add a reusable skill to your workspace.

## Prerequisites

- Workspace deployed and engine running

## Steps

### 1. Create Skill File

```bash
cp framework/templates/skill-template.md workspace/skills/{{SKILL_NAME}}.md
```

### 2. Edit the Skill

Open `workspace/skills/{{SKILL_NAME}}.md` and customize:

- The `# Heading` becomes the skill name
- The first non-heading line becomes the description
- Add steps, examples, and output format as needed

### 3. Verify

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/skills
```

Your skill should appear in the list.

## Notes

- Skill filenames should be lowercase, hyphenated (e.g., `deploy-update.md`)
- If a framework skill has the same filename, your workspace version takes precedence
- Skills are markdown files — structure them however makes sense for the task
