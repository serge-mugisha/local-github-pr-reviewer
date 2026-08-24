---
name: reviewer-mcp
description: Use the local GitHub PR Reviewer MCP for local AI self-review, thread disposition, durable waiting, and exact-head validation. Apply automatically when an agent opens or updates a PR whose working repository is registered with Reviewer, or whenever local-github-pr-reviewer is requested; this does not grant permission to change, push, or merge a PR.
---

# Reviewer MCP

## Intent and boundaries

Reviewer is a local second-opinion system for pull requests. It refreshes PR metadata and diffs from GitHub, checks out the PR head locally, asks the configured AI provider to review it, and persists reviews, comments, and thread status in Reviewer's local database. The UI and MCP read the same local state.

Review threads are not GitHub review comments, approvals, or conversations. Do not search GitHub for them or claim that Reviewer posted them there. Reviewer does not replace required GitHub reviews, CI, or human approval.

The reviewer is another AI agent, not a human authority. Treat each finding as evidence to evaluate, not an instruction to obey literally. The agent implementing the PR owns the broader context and decides whether to patch, explain, or dismiss a finding. Resolve every finding deliberately, but do not make low-value changes merely to satisfy the reviewer.

## When to use it

When work opens or materially updates a PR, check whether its working repository is already returned by `manage_repositories` with `action: "list"`. If it is registered, run a self-review automatically before declaring the PR ready or merging it, unless the user explicitly opts out. Do not auto-register unrelated repositories solely to force this workflow.

Review a stable, pushed PR head after the planned implementation and local verification are complete. Reviewing while continuing to push unrelated changes wastes review work and invalidates the exact-head gate.

## Review workflow

1. Find the local `prId` with `list_my_prs`, or list registered repositories and then their PRs.
2. Call `get_pr_details` before the gate review to refresh GitHub data. Record `pr.head_sha` as the expected head.
3. Apply a preset or configuration only when the task calls for it. Do so before triggering the review.
4. Call `trigger_review` once. Save its positive, durable `reviewId`. A response with `joined: true` means another process already owns the same active review; use the returned ID without triggering again.
5. Call `await_review` once with that `reviewId`. Let the call remain open until it returns a terminal result. Completion and all threads are committed atomically. Progress may appear about every 10 seconds when the client supports it.
6. Treat the result as complete only when its status is `completed`. Triage the threads returned by `await_review`; do not query elsewhere to guess whether publication finished.
7. Address every open, non-stale thread as described below.
8. Refresh with `get_pr_details` and compare its current `pr.head_sha` with the completed result's `headSha`. A review gates only the exact matching head.

For an immediate persisted snapshot outside the active wait—for example, when inspecting an already-reviewed PR—use `get_review_threads`. It is not a completion-waiting loop.

## Disposition of findings

Every open, non-stale finding must receive an explicit disposition before another full review:

- **Patch and revalidate:** When the finding identifies a plausible code defect and the patch materially changes what the reviewer evaluated, implement the fix, verify it, push the new head, then call `revalidate_thread`. Inspect the revalidation result; if it remains unresolved, decide whether more work or a reasoned dismissal is appropriate.
- **Patch and resolve:** Use `set_thread_status` with `resolved` when the correction is straightforward and independently verified, so another AI pass would add little value.
- **Dismiss and resolve:** When the finding is incorrect, irrelevant, outside scope, or based on missing context, retain control of the decision. Prefer adding a concise local rationale with `reply_to_thread` when it will help future readers, then mark the thread resolved.

`revalidate_thread` and `reply_to_thread` return a positive durable `actionId`. Call `await_thread_action` once with that ID; do not poll `get_job_status`. If the client disconnects or the wait times out, re-enter `await_thread_action` with the same ID after the prior call ends. If the ID was lost, call `get_thread_action` once with the `threadId` to recover the latest persisted action.

Never leave an addressed or dismissed thread open and start another full review. First revalidate or resolve all prior findings. If patches changed the PR head, run one fresh full review afterward so the final gate covers the new SHA.

Do not enter an endless review-fix loop. Address material correctness, security, contract, and reliability issues; dismiss repetitive or unsupported advice with a recorded rationale. Escalate to the user when a finding would materially expand scope or conflicts with the requested design.

## Recovery

- If the client disconnects, restarts, or an `await_review` attempt ends because of a transport timeout, reconnect and call `await_review` again with the same `reviewId`. Retry only after the previous call has ended; never run parallel awaiters.
- If the wait reaches its own timeout, the review may still be active. Re-enter `await_review` with the same `reviewId`; do not trigger a replacement.
- If the `reviewId` was lost but the `prId` is known, call `get_review_threads` once and use the latest persisted review ID. Await it if its status is still `running`.
- If the review returns a terminal error, report the error and correct the cause only within the user's authorized scope. A later retry should use one new `trigger_review` call and its new `reviewId`.
- If the PR head changed after a completed review, that result does not gate the new head. Finish disposition of its threads, refresh the PR, trigger one new review, and await its returned ID.
- Recover reply and revalidation actions with their durable `actionId` and `await_thread_action`; never repeat the thread mutation merely because its original connection closed.

Do not call `clear_pr_review` as ordinary recovery. It deletes local review history and threads; use it only when the user explicitly wants that data cleared or a task specifically requires a clean slate.

## Gate criteria

A review gate passes only when all of these are true:

- `await_review` returned `completed`, not a timeout, transport failure, or terminal error.
- The completed review `headSha` equals the refreshed PR `head_sha`.
- Every prior open, non-stale finding was patched and revalidated/resolved, or deliberately dismissed and resolved.
- The final result contains no open, non-stale thread that the implementing agent judges actionable under the requested review policy.
- Any separate CI, approval, or merge requirements also pass.
- The user has authorized any subsequent mutation such as pushing fixes, resolving threads, or merging.

## Anti-patterns

Never:

- look on GitHub for local Reviewer threads or state that Reviewer posted them there;
- obey an AI finding without evaluating it against the PR's context and intent;
- poll `get_job_status` for a full review;
- poll `get_job_status` for a reply or revalidation action;
- create timers, watchers, database readers, or background tasks to race `await_review`;
- call `trigger_review` repeatedly while a review is active;
- start a new full review while previous actionable threads remain open;
- infer completion from `openThreads`, silence, elapsed time, or the UI alone;
- treat a legacy `jobId` as restart-safe;
- run multiple consumers waiting on the same review;
- accept a clean result without validating the exact reviewed head SHA.

The normal call sequence is:

```text
get_pr_details(prId) -> record expected head SHA
trigger_review(prId) -> save reviewId
await_review(reviewId) -> completed result plus committed local threads
triage -> patch/revalidate, patch/resolve, or dismiss/resolve every finding
for reply/revalidate: save actionId -> await_thread_action(actionId) once
if head changed: trigger_review(prId) once -> await_review(new reviewId)
get_pr_details(prId) -> confirm current head SHA equals final result.headSha
```
