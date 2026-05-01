# Changesets

This directory hosts release notes drafts ("changesets") for the
independently-versioned **integrations** that live under
`/integrations/*`. Reference: issue #88.

## When to add a changeset

Run `npm run changeset` whenever a PR touches an integration package
(`@nexaas/email-provider-resend`, `@nexaas/email-provider-postmark`,
etc.) in a way that warrants a version bump:

- **patch**: bug fixes, dependency updates that don't change the
  capability surface
- **minor**: new optional fields, new providers exposed
- **major**: capability-version range bump, breaking provider rename

## When NOT to add a changeset

Framework packages (`@nexaas/palace`, `@nexaas/runtime`,
`@nexaas/integration-sdk`, …) are in the `fixed` group — they ship at
the framework version and don't need per-PR changesets. Their version
bumps happen at release time.

## How releases work

`npm run release` consumes pending changesets, bumps the affected
package versions, regenerates changelogs, and stages the version
commit. Reference integrations are published to npm under the
`@nexaas` scope.
