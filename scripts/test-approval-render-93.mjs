#!/usr/bin/env node
/**
 * Regression test for #93 — notification-dispatcher must render
 * approval-request drawers (kind: "approval_request") into channel-shaped
 * fields. Under the pre-fix code the dispatcher forwarded `content: ""`
 * and Telegram rejected the message with HTTP 400.
 *
 * Run from repo root: `node scripts/test-approval-render-93.mjs`
 * No database, no network — pure unit-style assertions.
 */

import { _renderApprovalRequest } from "@nexaas/runtime/tasks/notification-dispatcher";

let pass = 0, fail = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`OK    ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}`);
    fail++;
  }
}

// 1. Email-shape payload renders with To/Subject labels and blockquote body.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k1",
    channel_role: "pa_reply_mireille",
    kind: "approval_request",
    summary: "Mireille drafted a reply about Friday tasting",
    payload_full: {
      to: "joanne@example.com",
      subject: "Re: Friday tasting",
      body: "Hi Joanne, thanks for confirming. We have your spot held...",
      in_reply_to: "<msg-id@example.com>",
    },
    payload_preview: "{\"to\":\"joanne@example.com\",\"subject\":\"Re: Friday tasting\",\"body\":\"Hi Joanne...\"}",
    decisions: [
      { id: "approve", label: "Approve" },
      { id: "edit", label: "Edit" },
      { id: "reject", label: "Reject" },
    ],
  });
  assert(r.parse_mode === "HTML", "email-shape: parse_mode is HTML");
  assert(r.content.includes("<b>To:</b> joanne@example.com"), "email-shape: To label");
  assert(r.content.includes("<b>Subject:</b> Re: Friday tasting"), "email-shape: Subject label");
  assert(r.content.includes("<blockquote>Hi Joanne"), "email-shape: body wrapped in blockquote");
  assert(!r.content.includes("<pre>"), "email-shape: no <pre> block");
  assert(r.content.startsWith("Mireille drafted a reply"), "email-shape: summary leads");
  assert(r.inline_buttons?.length === 3, "email-shape: 3 inline_buttons");
  assert(r.inline_buttons?.[0]?.button_id === "approve", "email-shape: button_id matches decision id");
  assert(r.inline_buttons?.[0]?.text === "Approve", "email-shape: button text matches decision label");
}

// 2. Non-email payload falls back to <pre>{payload_preview}</pre>.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k2",
    channel_role: "ops_review",
    kind: "approval_request",
    summary: "Onboarding step 3 awaiting review",
    payload_preview: "{\"step\":\"verify_dba\",\"client\":\"acme\"}",
    decisions: [{ id: "approve", label: "Approve" }],
  });
  assert(r.content.includes("<pre>"), "non-email: uses <pre>");
  assert(!r.content.includes("<blockquote>"), "non-email: no blockquote");
  assert(r.content.includes("verify_dba"), "non-email: payload_preview escaped & embedded");
}

// 3. HTML metacharacters in user input are escaped.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k3",
    channel_role: "x",
    kind: "approval_request",
    summary: "<script>alert(1)</script>",
    payload_full: {
      to: "user@example.com",
      subject: "<img onerror=alert(1)>",
      body: "evil & dangerous <b>injected</b>",
    },
  });
  assert(!r.content.includes("<script>"), "escape: <script> tag escaped");
  assert(!r.content.includes("<img onerror"), "escape: <img onerror> escaped");
  assert(r.content.includes("&lt;script&gt;"), "escape: < and > entitied");
  assert(r.content.includes("evil &amp; dangerous"), "escape: ampersand entitied");
  assert(r.content.includes("&lt;b&gt;injected&lt;/b&gt;"), "escape: nested tags entitied in body");
}

// 4. Missing summary → content has no lead-in but still renders payload.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k4",
    channel_role: "x",
    kind: "approval_request",
    payload_full: { to: "a@b.c", subject: "S", body: "B" },
  });
  assert(!r.content.startsWith("\n"), "no-summary: no leading newline");
  assert(r.content.startsWith("<b>To:</b>"), "no-summary: starts with To label");
}

// 5. Missing decisions → no inline_buttons in output.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k5",
    channel_role: "x",
    kind: "approval_request",
    summary: "no buttons",
    payload_preview: "{}",
  });
  assert(r.inline_buttons === undefined, "no-decisions: inline_buttons undefined");
}

// 6. Empty decisions array → no inline_buttons.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k6",
    channel_role: "x",
    kind: "approval_request",
    summary: "empty array",
    payload_preview: "{}",
    decisions: [],
  });
  assert(r.inline_buttons === undefined, "empty-decisions: inline_buttons undefined");
}

// 7. Decisions missing label → falls back to id as button text.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k7",
    channel_role: "x",
    kind: "approval_request",
    payload_preview: "{}",
    decisions: [{ id: "go" }],
  });
  assert(r.inline_buttons?.[0]?.text === "go", "missing-label: text falls back to id");
}

// 8. Decisions with non-string id are coerced via String() and dropped if empty.
{
  const r = _renderApprovalRequest({
    idempotency_key: "k8",
    channel_role: "x",
    kind: "approval_request",
    payload_preview: "{}",
    decisions: [{ id: 7, label: "Seven" }, { id: "", label: "Empty" }],
  });
  assert(r.inline_buttons?.length === 1, "coerce-id: keeps numeric id, drops empty");
  assert(r.inline_buttons?.[0]?.button_id === "7", "coerce-id: numeric id stringified");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
