#!/usr/bin/env node
/**
 * Mocked-fetch regression test for the email-outbound integration extraction
 * (#78 / #88). Validates that each provider's send/track:
 *
 *   1. Calls the right URL with the right method and auth header
 *   2. Sends a request body in the vendor-specific shape
 *   3. Returns the framework-canonical response shape on success / failure
 *   4. Handles vendor quirks correctly (SendGrid 202+header, Postmark
 *      ErrorCode != 0, Resend's bundled error shape, etc.)
 *
 * No network, no DB. Stubs `globalThis.fetch` and inspects the captured
 * call. Run from repo root:
 *
 *   node --import tsx scripts/test-email-providers-88.mjs
 *
 * Purpose: prove the #88 Phase-2 extraction (moving providers out of the
 * MCP shell into independently-versioned packages) preserved request and
 * response semantics byte-for-byte. Useful as a permanent regression
 * test, not just a one-shot — captures the contract each vendor expects.
 */

import { createResendProvider } from "@nexaas/email-provider-resend";
import { createPostmarkProvider } from "@nexaas/email-provider-postmark";
import { createSendGridProvider } from "@nexaas/email-provider-sendgrid";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

// ─────────────────────────────────────────────────────────────────────
// Mocked-fetch harness
// ─────────────────────────────────────────────────────────────────────
let lastRequest = null;
let nextResponse = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init };
  if (typeof nextResponse === "function") return nextResponse();
  return nextResponse;
};

function mockResponse(status, body, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headerMap.get(h.toLowerCase()) ?? null },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}

function bodyJson() {
  return JSON.parse(lastRequest.init.body);
}

function reset() {
  lastRequest = null;
  nextResponse = null;
}

// ─────────────────────────────────────────────────────────────────────
// Sample input every provider should accept
// ─────────────────────────────────────────────────────────────────────
const SEND_INPUT = {
  from: { email: "ops@bsbc.test", name: "BSBC Ops" },
  reply_to: "noreply@bsbc.test",
  to: ["a@example.com", "b@example.com"],
  subject: "Hello",
  body_text: "Plain-text body for deliverability.",
  body_html: "<p>Optional HTML.</p>",
  headers: { "List-Unsubscribe": "<mailto:unsub@bsbc.test>" },
  tracking: { opens: true, clicks: true },
  tags: ["welcome-sequence"],
};

// ─────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────
{
  const provider = createResendProvider("re_fake_key");

  // send happy path
  reset();
  nextResponse = mockResponse(200, { id: "01HZ_RESEND_ID" });
  const sendOut = await provider.send(SEND_INPUT);
  assert(lastRequest.url === "https://api.resend.com/emails", "resend send: URL");
  assert(lastRequest.init.method === "POST", "resend send: POST");
  assert(lastRequest.init.headers.Authorization === "Bearer re_fake_key", "resend send: bearer auth");
  assert(lastRequest.init.headers["Content-Type"] === "application/json", "resend send: content-type JSON");
  {
    const b = bodyJson();
    assert(b.from === "BSBC Ops <ops@bsbc.test>", "resend send: from name <email>");
    assert(Array.isArray(b.to) && b.to.length === 2, "resend send: to as array");
    assert(b.subject === "Hello", "resend send: subject");
    assert(b.text === "Plain-text body for deliverability.", "resend send: text");
    assert(b.html === "<p>Optional HTML.</p>", "resend send: html");
    assert(b.reply_to === "noreply@bsbc.test", "resend send: reply_to");
    assert(b.headers["List-Unsubscribe"] === "<mailto:unsub@bsbc.test>", "resend send: custom headers");
    assert(Array.isArray(b.tags) && b.tags[0]?.name === "welcome-sequence", "resend send: tags as [{name}]");
  }
  assert(sendOut.message_id === "01HZ_RESEND_ID", "resend send: message_id returned");
  assert(sendOut.accepted.length === 2 && sendOut.rejected.length === 0, "resend send: accepted/rejected");

  // send error path: 4xx with bundled error
  reset();
  nextResponse = mockResponse(422, { message: "Invalid `from` field", name: "validation_error", statusCode: 422 });
  const errOut = await provider.send(SEND_INPUT);
  assert(errOut.message_id === undefined, "resend send err: no message_id");
  assert(errOut.accepted.length === 0, "resend send err: nothing accepted");
  assert(errOut.rejected.length === 2 && errOut.rejected[0].reason === "Invalid `from` field",
    "resend send err: per-recipient rejection with reason");

  // track happy path
  reset();
  nextResponse = mockResponse(200, {
    id: "01HZ_RESEND_ID",
    last_event: "delivered",
    delivered_at: "2026-05-08T15:00:00Z",
  });
  const trackOut = await provider.track("01HZ_RESEND_ID");
  assert(lastRequest.url === "https://api.resend.com/emails/01HZ_RESEND_ID", "resend track: URL with id");
  assert(lastRequest.init.headers.Authorization === "Bearer re_fake_key", "resend track: bearer auth");
  assert(trackOut.status === "delivered" && trackOut.delivered_at === "2026-05-08T15:00:00Z",
    "resend track: delivered status + timestamp");

  // track 404 → unknown
  reset();
  nextResponse = mockResponse(404, { message: "Not found" });
  const t404 = await provider.track("missing-id");
  assert(t404.status === "unknown", "resend track 404: status=unknown (graceful)");

  // track bounced
  reset();
  nextResponse = mockResponse(200, {
    id: "x", last_event: "bounced",
    bounced_at: "2026-05-08T16:00:00Z",
    bounce: { type: "Permanent", message: "Mailbox does not exist" },
  });
  const tBounce = await provider.track("x");
  assert(tBounce.status === "bounced", "resend track bounced: status=bounced");
  assert(tBounce.bounced?.type === "Permanent", "resend track bounced: bounce.type");
  assert(tBounce.bounced?.reason === "Mailbox does not exist", "resend track bounced: bounce.reason");
}

// ─────────────────────────────────────────────────────────────────────
// Postmark
// ─────────────────────────────────────────────────────────────────────
{
  const provider = createPostmarkProvider("pm_fake_token");

  // send happy path
  reset();
  nextResponse = mockResponse(200, {
    To: "a@example.com,b@example.com",
    MessageID: "PM_MSG_ID",
    ErrorCode: 0,
    SubmittedAt: "2026-05-08T15:00:00Z",
  });
  const sendOut = await provider.send(SEND_INPUT);
  assert(lastRequest.url === "https://api.postmarkapp.com/email", "postmark send: URL");
  assert(lastRequest.init.method === "POST", "postmark send: POST");
  assert(lastRequest.init.headers["X-Postmark-Server-Token"] === "pm_fake_token", "postmark send: server token header");
  {
    const b = bodyJson();
    assert(b.From === "BSBC Ops <ops@bsbc.test>", "postmark send: From");
    assert(b.To === "a@example.com, b@example.com", "postmark send: comma-space-separated To");
    assert(b.Subject === "Hello", "postmark send: Subject");
    assert(b.TextBody === "Plain-text body for deliverability.", "postmark send: TextBody");
    assert(b.HtmlBody === "<p>Optional HTML.</p>", "postmark send: HtmlBody");
    assert(b.ReplyTo === "noreply@bsbc.test", "postmark send: ReplyTo");
    assert(Array.isArray(b.Headers) && b.Headers[0].Name === "List-Unsubscribe", "postmark send: Headers as [{Name,Value}]");
    assert(b.TrackOpens === true, "postmark send: TrackOpens");
    assert(b.TrackLinks === "HtmlAndText", "postmark send: TrackLinks enum (true → HtmlAndText)");
    assert(b.Tag === "welcome-sequence", "postmark send: Tag (singular, first of tags[])");
  }
  assert(sendOut.message_id === "PM_MSG_ID", "postmark send: message_id");
  assert(sendOut.accepted.length === 2 && sendOut.rejected.length === 0, "postmark send: accepted/rejected");

  // send error path: ErrorCode != 0
  reset();
  nextResponse = mockResponse(422, { ErrorCode: 405, Message: "Inactive recipient" });
  const errOut = await provider.send(SEND_INPUT);
  assert(errOut.message_id === undefined, "postmark send err: no message_id");
  assert(errOut.rejected.length === 2 && errOut.rejected[0].reason === "Inactive recipient",
    "postmark send err: per-recipient with Postmark Message");

  // multiple tags → first → Tag, rest → Metadata
  reset();
  nextResponse = mockResponse(200, { MessageID: "X", ErrorCode: 0 });
  await provider.send({ ...SEND_INPUT, tags: ["one", "two", "three"] });
  {
    const b = bodyJson();
    assert(b.Tag === "one", "postmark send: Tag = tags[0]");
    assert(b.Metadata?.tag_1 === "two" && b.Metadata?.tag_2 === "three",
      "postmark send: extra tags become Metadata.tag_N");
  }

  // tracking.clicks=false → TrackLinks=None
  reset();
  nextResponse = mockResponse(200, { MessageID: "X", ErrorCode: 0 });
  await provider.send({ ...SEND_INPUT, tracking: { opens: false, clicks: false } });
  assert(bodyJson().TrackLinks === "None", "postmark send: TrackLinks=None on clicks=false");

  // track happy path with MessageEvents
  reset();
  nextResponse = mockResponse(200, {
    MessageID: "PM_MSG_ID",
    Status: "Sent",
    ReceivedAt: "2026-05-08T15:00:00Z",
    Recipients: ["a@example.com"],
    MessageEvents: [
      { Type: "Sent", ReceivedAt: "2026-05-08T15:00:00Z" },
      { Type: "Delivered", ReceivedAt: "2026-05-08T15:00:30Z" },
    ],
  });
  const trackOut = await provider.track("PM_MSG_ID");
  assert(lastRequest.url === "https://api.postmarkapp.com/messages/outbound/PM_MSG_ID/details",
    "postmark track: URL with /details");
  assert(trackOut.status === "delivered", "postmark track: prefers Delivered MessageEvent over Status='Sent'");
  assert(trackOut.delivered_at === "2026-05-08T15:00:30Z", "postmark track: delivered_at from event");

  // track 404 → unknown
  reset();
  nextResponse = mockResponse(404, {});
  const t404 = await provider.track("missing");
  assert(t404.status === "unknown", "postmark track 404: status=unknown");

  // track bounced via MessageEvents
  reset();
  nextResponse = mockResponse(200, {
    MessageID: "X",
    Status: "Bounced",
    MessageEvents: [{
      Type: "Bounced",
      ReceivedAt: "2026-05-08T16:00:00Z",
      Details: { Type: "HardBounce", Description: "Mailbox not found" },
    }],
  });
  const tBounce = await provider.track("X");
  assert(tBounce.status === "bounced", "postmark track bounced: status");
  assert(tBounce.bounced?.type === "HardBounce" && tBounce.bounced?.reason === "Mailbox not found",
    "postmark track bounced: bounce.type + reason from Details");
}

// ─────────────────────────────────────────────────────────────────────
// SendGrid
// ─────────────────────────────────────────────────────────────────────
{
  const provider = createSendGridProvider("SG.fake_key");

  // send happy path: 202 + X-Message-Id header (NO body)
  reset();
  nextResponse = mockResponse(202, "", { "x-message-id": "SG_MSG_ID" });
  const sendOut = await provider.send(SEND_INPUT);
  assert(lastRequest.url === "https://api.sendgrid.com/v3/mail/send", "sendgrid send: URL");
  assert(lastRequest.init.method === "POST", "sendgrid send: POST");
  assert(lastRequest.init.headers.Authorization === "Bearer SG.fake_key", "sendgrid send: bearer auth");
  {
    const b = bodyJson();
    assert(Array.isArray(b.personalizations), "sendgrid send: personalizations array");
    assert(b.personalizations[0].to.length === 2 && b.personalizations[0].to[0].email === "a@example.com",
      "sendgrid send: personalizations[0].to=[{email},{email}]");
    assert(b.from.email === "ops@bsbc.test" && b.from.name === "BSBC Ops",
      "sendgrid send: from object with name");
    assert(b.subject === "Hello", "sendgrid send: subject");
    // SendGrid requires text/plain BEFORE text/html
    assert(b.content[0].type === "text/plain", "sendgrid send: content[0]=text/plain (ordering rule)");
    assert(b.content[1].type === "text/html", "sendgrid send: content[1]=text/html");
    assert(b.reply_to.email === "noreply@bsbc.test", "sendgrid send: reply_to as object");
    assert(b.headers["List-Unsubscribe"] === "<mailto:unsub@bsbc.test>", "sendgrid send: headers");
    assert(b.categories?.[0] === "welcome-sequence", "sendgrid send: categories from tags");
    assert(b.tracking_settings?.open_tracking?.enable === true,
      "sendgrid send: tracking_settings.open_tracking.enable");
    assert(b.tracking_settings?.click_tracking?.enable === true,
      "sendgrid send: tracking_settings.click_tracking.enable");
  }
  assert(sendOut.message_id === "SG_MSG_ID", "sendgrid send: message_id from X-Message-Id header");
  assert(sendOut.accepted.length === 2 && sendOut.rejected.length === 0, "sendgrid send: accepted/rejected");

  // send 202 with NO header (subuser quirk) → accepted but no message_id
  reset();
  nextResponse = mockResponse(202, "", {});
  const noHdr = await provider.send(SEND_INPUT);
  assert(noHdr.message_id === undefined, "sendgrid send no-hdr: message_id omitted");
  assert(noHdr.accepted.length === 2, "sendgrid send no-hdr: still accepted (known SendGrid quirk)");

  // send error path: 4xx with errors[]
  reset();
  nextResponse = mockResponse(400, { errors: [
    { message: "The from email does not match a verified Sender Identity.", field: "from.email" },
  ]});
  const errOut = await provider.send(SEND_INPUT);
  assert(errOut.message_id === undefined, "sendgrid send err: no message_id");
  assert(errOut.rejected.length === 2, "sendgrid send err: per-recipient rejection");
  assert(errOut.rejected[0].reason.includes("Sender Identity"),
    "sendgrid send err: reason from errors[].message");

  // categories cap at 10
  reset();
  nextResponse = mockResponse(202, "", { "x-message-id": "X" });
  const manyTags = Array.from({ length: 15 }, (_, i) => `tag_${i}`);
  await provider.send({ ...SEND_INPUT, tags: manyTags });
  assert(bodyJson().categories.length === 10, "sendgrid send: tags[] sliced to 10 categories");

  // track happy path → delivered
  reset();
  nextResponse = mockResponse(200, {
    msg_id: "SG_MSG_ID",
    status: "delivered",
    last_event_time: "2026-05-08T15:00:00Z",
  });
  const trackOut = await provider.track("SG_MSG_ID");
  assert(lastRequest.url === "https://api.sendgrid.com/v3/messages/SG_MSG_ID", "sendgrid track: URL");
  assert(trackOut.status === "delivered", "sendgrid track: status=delivered");
  assert(trackOut.delivered_at === "2026-05-08T15:00:00Z", "sendgrid track: delivered_at");

  // track 401 (no paid Activity feed) → unknown (graceful)
  reset();
  nextResponse = mockResponse(401, { errors: [{ message: "no paid plan" }] });
  const t401 = await provider.track("X");
  assert(t401.status === "unknown", "sendgrid track 401: status=unknown (graceful for non-paid accounts)");

  // track 403 → unknown
  reset();
  nextResponse = mockResponse(403, {});
  assert((await provider.track("X")).status === "unknown", "sendgrid track 403: status=unknown");

  // track 404 → unknown
  reset();
  nextResponse = mockResponse(404, {});
  assert((await provider.track("X")).status === "unknown", "sendgrid track 404: status=unknown");

  // status normalization: bounce → bounced
  reset();
  nextResponse = mockResponse(200, { msg_id: "X", status: "bounce" });
  assert((await provider.track("X")).status === "bounced", "sendgrid track: bounce → bounced (normalized)");

  // status normalization: blocked → bounced
  reset();
  nextResponse = mockResponse(200, { msg_id: "X", status: "blocked" });
  assert((await provider.track("X")).status === "bounced", "sendgrid track: blocked → bounced");

  // status normalization: spam_report → complained
  reset();
  nextResponse = mockResponse(200, { msg_id: "X", status: "spam_report" });
  assert((await provider.track("X")).status === "complained", "sendgrid track: spam_report → complained");
}

// Restore real fetch (in case anything else runs after).
globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
