# Playbook 04: Add a Registry

Add a structured data registry to your workspace.

## Prerequisites

- Workspace deployed and engine running

## Steps

### 1. Create Registry File

```bash
cp framework/templates/registry-template.yaml workspace/registries/{{REGISTRY_NAME}}.yaml
```

### 2. Define Schema

Edit the file to define your fields:

```yaml
name: {{REGISTRY_NAME}}
description: What this registry stores.

fields:
  - name: title
    type: string
  - name: status
    type: string
  - name: created
    type: date

entries: []
```

### 3. Add Entries

```yaml
entries:
  - title: First Item
    status: active
    created: "2025-01-15"
```

### 4. Register in workspace.yaml (Optional)

Add the registry name to the `registries` list in `workspace.yaml`:

```yaml
registries:
  - {{REGISTRY_NAME}}
```

### 5. Add Dashboard View (Optional)

Add a `registry-table` component to a page in `workspace.yaml`:

```yaml
components:
  - type: registry-table
    title: "{{REGISTRY_NAME}}"
    span: 12
    config:
      registry: {{REGISTRY_NAME}}
```

### 6. Verify

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/registries/{{REGISTRY_NAME}}
```

## Notes

- Registry names must match the filename (without `.yaml`)
- Supported field types: `string`, `number`, `date`, `boolean`, `url`
