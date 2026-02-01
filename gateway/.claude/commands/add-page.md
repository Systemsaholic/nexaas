# Add Dashboard Page

You are adding a new page to the workspace dashboard. Walk through each step interactively.

## Step 1: Select Perspective

Read `workspace.yaml` and list all existing perspectives. Ask the user which perspective this page belongs to.

If no perspectives exist, suggest creating one first with `/add-perspective`, or offer to add one inline.

## Step 2: Page Details

Ask for:
- **Page name** (display name, e.g., "Email Dashboard")
- **Page ID** (auto-generate from name as lowercase-hyphenated, confirm with user)
- **Icon** (suggest from: `layout-dashboard`, `mail`, `users`, `calendar`, `bar-chart`, `settings`, `message-circle`, `database`, `globe`, `shield`, `zap`, `git-branch`, `list`, `grid`, `file-text`)
- **Description** (short summary of the page purpose)

## Step 3: Select Components

Present the available widget types and ask the user to pick which ones to include on this page:

| Widget Type | Description | Required Config |
|-------------|-------------|-----------------|
| `stat-cards` | Key metric cards in a row | List of cards with label and data source |
| `agent-tree` | Hierarchical agent visualization | Title |
| `agent-chat` | Chat interface with an agent | Agent name, title |
| `event-timeline` | Chronological event feed | Title, limit |
| `queue-status` | Job queue overview | Title, filter |
| `registry-table` | View/edit a registry | Registry name, columns |
| `data-table` | Generic data table | Data source, columns |
| `email-preview` | Single email viewer | Source |
| `email-list` | Email inbox list | Source, limit |
| `social-media-preview` | Social post preview | Platform, source |
| `pipeline-board` | Kanban-style pipeline | Stages, source |
| `draft-list` | Content drafts list | Source, status filter |
| `chart` | Data visualization | Chart type (bar/line/pie), data source |
| `calendar` | Calendar view | Event source |
| `markdown-viewer` | Render markdown content | Source file or content |

Let the user select one or more. For each selected component, ask for the required configuration values.

## Step 4: Configure Each Component

For each selected component, interactively gather configuration. Examples:

### stat-cards
```yaml
- type: stat-cards
  config:
    cards:
      - label: "{metric_name}"
        source: "{data_source}"
        icon: "{icon}"
```
Ask: "What metrics do you want to display? Provide a label and data source for each card."

### agent-chat
```yaml
- type: agent-chat
  config:
    agent: "{agent_name}"
    title: "Chat with {Agent Name}"
```
Ask: "Which agent should this chat connect to?" List available agents from `agents/` directory.

### registry-table
```yaml
- type: registry-table
  config:
    registry: "{registry_name}"
    columns:
      - field: "{field_name}"
        label: "{display_label}"
        sortable: true
```
Ask: "Which registry?" List available from `registries/` directory. Then ask which columns to display.

### chart
```yaml
- type: chart
  config:
    chart_type: "{bar|line|pie|area}"
    title: "{chart_title}"
    data_source: "{source}"
```
Ask: "What type of chart? What data should it visualize?"

Follow similar patterns for all component types, asking only for the relevant config fields.

## Step 5: Write to workspace.yaml

Read the current `workspace.yaml`, find the target perspective, and append the new page definition:

```yaml
- id: "{page_id}"
  name: "{page_name}"
  icon: "{icon}"
  description: "{description}"
  components:
    - type: "{component_type}"
      config:
        {component_config}
```

Write the updated `workspace.yaml`.

## Completion

Summarize:
- Page name and ID
- Perspective it was added to
- Number and types of components
- Suggest viewing the page in the dashboard or adding more components later
