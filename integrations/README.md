# Nexaas Reference Integrations

This directory hosts the **reference integrations** maintained by the
Nexaas team — provider plugins for popular vendors that adopters can
opt into. Filed against issue #88.

```
integrations/
  email-provider-resend/        # @nexaas/email-provider-resend
  email-provider-postmark/      # @nexaas/email-provider-postmark
  email-provider-sendgrid/      # @nexaas/email-provider-sendgrid
  ...
```

## Why these are not in the framework core

Vendor-specific code evolves at vendor cadence and brings vendor deps.
Bundling it inside the framework would couple release timing and inflate
the framework's dependency tree. Instead:

- The **framework** (everything under `/packages` and the `mcp/servers/`
  tree) defines capability contracts and ships provider-agnostic shells.
- **Reference integrations** (this directory) live in the same
  monorepo but version independently via [changesets](../.changeset/).
- **Adopter integrations** (Nexmatic's commercial bundle, Phoenix's
  custom providers, …) live in adopter repos and load through the same
  contract — fully equal citizens to the reference set.

## Integration anatomy

Every package in this directory MUST contain:

```
integrations/email-provider-foo/
  package.json                  # name: @nexaas/email-provider-foo
  nexaas-integration.yaml       # manifest — capability + version + env
  src/
    index.ts                    # exports a factory matching the
                                # capability's TypeScript interface
  README.md                     # provider-specific notes
```

### `nexaas-integration.yaml`

```yaml
name: email-provider-foo
implements:
  - capability: email-outbound
    version: ">=0.2 <1"
    provider_name: foo
env:
  required: [FOO_API_KEY]
  optional: [FOO_API_REGION]
entry: "./src/index.ts"
```

The schema is defined in `@nexaas/integration-sdk`'s
`IntegrationManifestSchema`. The framework validates it at integration
discovery time before registering the provider.

## How adopters install

In the workspace manifest, adopters declare the integrations they want
loaded:

```yaml
integrations:
  - "@nexaas/email-provider-resend"
  - "@nexmatic/email-provider-mailjet"
  - "./local/phoenix-zoho-integration"
```

The framework resolves each entry at MCP shell boot, validates the
manifest against the capability registry, and registers the provider.
No magic auto-discovery from `node_modules` — explicit list.

## Adding a new reference integration

1. `mkdir integrations/<capability>-<role>-<provider>`
2. Add `package.json` with name `@nexaas/<capability>-<role>-<provider>`
3. Author the implementation, importing the capability's interface and
   helpers from `@nexaas/integration-sdk`
4. Add `nexaas-integration.yaml`
5. Add a changeset (`npm run changeset`) describing the new provider
6. Open a PR — CodeRabbit + capability-registry validation gate it

## Where things stand

This directory is empty as of the foundation PR (#88, Phase 1). The
existing Resend / Postmark / SendGrid providers ship in the
`mcp/servers/email-outbound/` shell today and migrate here in Phase 2
(one PR per provider).
