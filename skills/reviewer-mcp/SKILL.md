---
name: reviewer-mcp
description: Use the local GitHub PR Reviewer MCP for exact-head AI self-review, durable operation waiting, thread disposition, and final gate validation.
---

# Reviewer MCP

Reviewer is a local second-opinion system. It reads GitHub PR metadata and diffs, checks out the
exact PR head locally, runs the configured AI provider, and persists reviews and threads locally.
Its threads are not GitHub review comments and it does not replace CI, approvals, or human review.

Treat findings as evidence to evaluate, not instructions to obey automatically.

## When to use it

After opening or materially updating a PR, check whether its repository is already registered with
`manage_repositories`. If registered, run a self-review after the implementation is pushed and local
verification passes, unless the user opts out. Do not register unrelated repositories just to force
this workflow.

## Review workflow

1. Find the local `prId` with `list_my_prs` or `list_prs`.
2. Call `get_pr_details` and record `pr.head_sha`.
3. Call `trigger_review` once with `prId` and `expectedHeadSha`.
   - A Task-capable host receives an MCP Task and should use its normal Task lifecycle.
   - An ordinary host receives a durable operation immediately.
4. For an ordinary operation, call `wait_operation` with its `operationId`. If `terminal` is false,
   repeat the same bounded wait. Do not sleep, create timers, or call `trigger_review` again.
5. On completion, evaluate every open non-stale thread:
   - Patch and call `revalidate_thread` when AI rechecking adds value.
   - Patch and mark resolved when independently verified.
   - Reply with a concise rationale and resolve when dismissing an incorrect or out-of-scope finding.
6. Every reply or revalidation also returns a durable operation. Use `wait_operation` the same way.
7. If fixes changed the PR head, push and run one new full review for that new head.
8. Call `verify_review_gate` with the final review `operationId`. Accept the gate only when it reports
   `status: completed`, `review.gate: clean`, and the reviewed and current head SHAs match.

Reviewer validates provider output and retries malformed output once. A completed zero-finding
review is validated; do not inspect raw provider logs or the database to second-guess it.

## Recovery

Operations are persisted before their handles are returned, and detached workers continue across
MCP bridge replacement. `get_operation` is an immediate recovery/status read. `wait_operation` is
bounded, safe to repeat, and returns a healthy running snapshot instead of a transport timeout.

If the initial trigger response itself is lost, call `get_review_threads` once. Its
`latestOperation` is the correlated durable operation for that PR. Do not start a duplicate review.

Worker leases are fenced and supervised. A stale worker cannot publish after recovery. Terminal
errors include their cause and are never represented as a clean review.

After correcting the cause of a terminal failure, repeat the original tool call once. Failed
operations release their semantic key, so the retry creates a fresh durable operation.

Use `forceNew` only when intentionally requesting another pass for an unchanged head and review
configuration, such as re-running a clean review at the same head. For replies, use it only to
intentionally repeat an otherwise identical message.

## Guardrails

- Do not search GitHub for Reviewer-local threads.
- Do not clear review data as ordinary recovery.
- Do not start a new full review while prior actionable threads remain undisposed.
- Do not accept a review whose exact-head gate is stale.
- Do not enter an endless review-fix loop; escalate findings that materially expand scope.
- GitHub mutations such as pushing, resolving local threads, merging, or deploying still require
  the user's authorization.

Normal sequence:

```text
get_pr_details -> trigger_review -> wait_operation until terminal
triage findings -> wait on any reply/revalidation operations
if head changed: trigger_review -> wait_operation
verify_review_gate -> clean exact-head result
```
