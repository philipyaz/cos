// Unit tests for normalizeMessageUrl (v8): the pure, dependency-free server-side
// gate for MessageRecord.url — the direct deep-link back to the ORIGINAL message
// (e.g. a Gmail thread URL, https://mail.google.com/mail/u/0/#all/<threadId>). The
// validator accepts ONLY an absolute http/https URL and returns the TRIMMED original
// (no rewrite); everything else — non-string, empty/whitespace, relative, javascript:,
// data:, mailto: — collapses to undefined. Pure / in-memory: no clock, no random, no
// store reads, so the suite is fully deterministic. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/message-url.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessageUrl, messageDeepLink } from "../../board/lib/message-url.ts";

// ── accepted: absolute http/https URLs (returned verbatim, trimmed) ────────────
test("normalizeMessageUrl — keeps a valid Gmail thread URL INCLUDING the #all/<threadId> hash", () => {
  // The hash is the whole point of the deep-link (it selects the thread), so it must
  // survive unchanged — the validator returns the original string, it never rewrites.
  const gmail = "https://mail.google.com/mail/u/0/#all/18abc";
  assert.equal(normalizeMessageUrl(gmail), gmail);
});

test("normalizeMessageUrl — accepts a plain https URL", () => {
  assert.equal(normalizeMessageUrl("https://example.com/x"), "https://example.com/x");
});

test("normalizeMessageUrl — accepts a plain http URL (not just https)", () => {
  assert.equal(normalizeMessageUrl("http://example.com/x"), "http://example.com/x");
});

test("normalizeMessageUrl — trims surrounding whitespace and returns the trimmed original", () => {
  // Leading/trailing whitespace is stripped; the returned value is the TRIMMED form,
  // not the raw padded input.
  assert.equal(
    normalizeMessageUrl("   https://mail.google.com/mail/u/0/#all/18abc   "),
    "https://mail.google.com/mail/u/0/#all/18abc",
  );
});

// ── rejected: empty / whitespace-only ──────────────────────────────────────────
test("normalizeMessageUrl — empty string → undefined", () => {
  assert.equal(normalizeMessageUrl(""), undefined);
});

test("normalizeMessageUrl — whitespace-only string → undefined", () => {
  assert.equal(normalizeMessageUrl("   "), undefined);
});

// ── rejected: non-strings ──────────────────────────────────────────────────────
test("normalizeMessageUrl — non-string inputs → undefined (null, undefined, number, object)", () => {
  assert.equal(normalizeMessageUrl(null), undefined);
  assert.equal(normalizeMessageUrl(undefined), undefined);
  assert.equal(normalizeMessageUrl(123), undefined);
  assert.equal(normalizeMessageUrl({ url: "https://example.com" }), undefined);
});

// ── rejected: relative paths (no scheme/host → not absolute) ────────────────────
test("normalizeMessageUrl — relative paths → undefined", () => {
  assert.equal(normalizeMessageUrl("/x"), undefined);
  assert.equal(normalizeMessageUrl("mail/u/0"), undefined);
});

// ── rejected: non-http(s) schemes (the XSS / abuse vectors) ─────────────────────
test("normalizeMessageUrl — javascript: scheme → undefined", () => {
  assert.equal(normalizeMessageUrl("javascript:alert(1)"), undefined);
});

test("normalizeMessageUrl — data: scheme → undefined", () => {
  assert.equal(normalizeMessageUrl("data:text/html,x"), undefined);
});

test("normalizeMessageUrl — mailto: scheme → undefined", () => {
  assert.equal(normalizeMessageUrl("mailto:a@b.com"), undefined);
});

// ── messageDeepLink: structured url first, then a Gmail link embedded in text ─────
test("messageDeepLink — prefers the structured url field when set", () => {
  const url = "https://mail.google.com/mail/u/0/#all/19a7dd27d33740ae";
  assert.equal(messageDeepLink({ url, preview: "https://mail.google.com/mail/u/0/#all/other" }), url);
});

test("messageDeepLink — falls back to a Gmail thread URL embedded in the preview", () => {
  // The shape the mail sweep wrote before the url field existed ("— <url>" tail).
  const preview = "Carmen sent her dossier — https://mail.google.com/mail/u/0/#all/19a7dd27d33740ae";
  assert.equal(messageDeepLink({ preview }), "https://mail.google.com/mail/u/0/#all/19a7dd27d33740ae");
});

test("messageDeepLink — falls back to a Gmail thread URL embedded in the body ('Link: <url>')", () => {
  const body = "…agreed). Link: https://mail.google.com/mail/u/0/#all/19a815934c9c4f87";
  assert.equal(messageDeepLink({ body }), "https://mail.google.com/mail/u/0/#all/19a815934c9c4f87");
});

test("messageDeepLink — preview wins over body when both carry a Gmail link", () => {
  const preview = "p — https://mail.google.com/mail/u/0/#all/aaa111";
  const body = "Link: https://mail.google.com/mail/u/0/#all/bbb222";
  assert.equal(messageDeepLink({ preview, body }), "https://mail.google.com/mail/u/0/#all/aaa111");
});

test("messageDeepLink — ignores a NON-Gmail URL in the body (only the message's own deep-link counts)", () => {
  // A marketing/footer link must never become the "open original" affordance.
  assert.equal(messageDeepLink({ body: "Unsubscribe at https://news.example.com/u/123" }), undefined);
});

test("messageDeepLink — returns undefined when there is no url and no embedded Gmail link", () => {
  assert.equal(messageDeepLink({ preview: "no links here", body: "" }), undefined);
  assert.equal(messageDeepLink({}), undefined);
});

test("messageDeepLink — supports #inbox/<id> and #label/X/<id> Gmail views, not just #all", () => {
  assert.equal(
    messageDeepLink({ preview: "x — https://mail.google.com/mail/u/2/#inbox/19ea0977c18ca3dc" }),
    "https://mail.google.com/mail/u/2/#inbox/19ea0977c18ca3dc",
  );
  assert.equal(
    messageDeepLink({ body: "Link: https://mail.google.com/mail/u/0/#label/Work/19ea04b147ffbf20" }),
    "https://mail.google.com/mail/u/0/#label/Work/19ea04b147ffbf20",
  );
});
