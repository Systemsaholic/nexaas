# Add Registry

Add a new data registry to the workspace.

## Step 1: Registry Identity

Ask:
1. **Registry name** — lowercase, hyphenated (e.g., `client-list`)
2. **Description** — What data does this store?

## Step 2: Define Fields

Ask: "What fields should this registry have?"

Common field types:
- `string` — Text
- `number` — Numeric value
- `date` — Date/datetime
- `boolean` — True/false

Help them define 3-6 fields. Example for a contacts registry:
- name (string)
- email (string)
- company (string)
- status (string)
- last_contact (date)

## Step 3: Initial Entries

Ask: "Do you want to add any initial entries, or start empty?"

If yes, collect a few sample entries.

## Step 4: Create Registry

Create `workspace/registries/{name}.yaml`:

```yaml
name: {name}
description: {description}
fields:
  - name: {field1}
    type: {type}
  - name: {field2}
    type: {type}
entries:
  - {field1}: {value}
    {field2}: {value}
```

Or with empty entries:
```yaml
entries: []
```

## Step 5: Update Workspace CLAUDE.md

Add the new registry to the "Active Registries" section in `workspace/CLAUDE.md`.

## Step 6: Summary

```
Registry created:
- File: workspace/registries/{name}.yaml
- Fields: {count} fields
- Entries: {count} entries

Access via API:
  curl -H "Authorization: Bearer $API_KEY" localhost:8400/api/registries/{name}

Agents can read/update: registries/{name}.yaml
```
