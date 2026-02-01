# Add Perspective

You are creating a new perspective (a named view grouping dashboard pages) in this workspace.

## Step 1: Perspective Details

Ask the user for:
- **Perspective name** (e.g., "Marketing", "Operations", "Sales Manager")
- **Icon** (suggest from: `shield`, `briefcase`, `megaphone`, `headphones`, `bar-chart`, `code`, `eye`, `target`, `users`, `settings`, `globe`, `trending-up`)
- **Description** (who this perspective is for and what it shows)

## Step 2: Select Pages

Read `workspace.yaml` and list all existing pages across all perspectives.

Ask: "Which existing pages should be included in this perspective? You can also create new pages later with `/add-page`."

Let the user select from the list. A page can appear in multiple perspectives.

If no pages exist yet, let them know and offer to create one with `/add-page` after this step, or create a default overview page inline.

## Step 3: Set Default Page

If the user selected pages, ask which one should be the default (shown first when switching to this perspective).

If no pages were selected, note that the default will be set when pages are added.

## Step 4: Write to workspace.yaml

Read the current `workspace.yaml` and append the new perspective to the `perspectives` list:

```yaml
- name: "{perspective_name}"
  icon: "{icon}"
  description: "{description}"
  default_page: "{default_page_id}"
  pages:
    - id: "{page_id_1}"
      name: "{page_name_1}"
      icon: "{page_icon_1}"
      description: "{page_description_1}"
      components: [...]
    - id: "{page_id_2}"
      ...
```

For pages referenced from other perspectives, copy their full definition into this perspective's page list.

Write the updated `workspace.yaml`.

## Completion

Summarize:
- Perspective name
- Number of pages included
- Default page
- Suggest next steps: add pages with `/add-page`, add agents with `/add-agent`
