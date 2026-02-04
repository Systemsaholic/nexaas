# YAML Registries

Structured data stores defined as YAML files with typed fields and entries.

## How It Works

Registries are YAML files in `workspace/registries/`. Each file defines a schema (`fields`) and data (`entries`). The engine serves them via the API, and the dashboard renders them as tables.

## File Format

```yaml
name: clients
description: Client accounts and contact information

fields:
  - name: name
    type: string
  - name: industry
    type: string
  - name: status
    type: string
  - name: contact_email
    type: string

entries:
  - name: Acme Corp
    industry: Technology
    status: active
    contact_email: contact@example.com
```

## Field Types

| Type | Description |
|---|---|
| `string` | Text value |
| `number` | Numeric value |
| `date` | ISO date string |
| `boolean` | true/false |
| `url` | URL string |

## API Endpoints

- `GET /api/registries` — list all registries (names and descriptions)
- `GET /api/registries/{name}` — get a registry's fields and entries

## Dashboard Integration

Use the `registry-table` component in `workspace.yaml` to display a registry:

```yaml
components:
  - type: registry-table
    title: Clients
    span: 12
    config:
      registry: clients
```
