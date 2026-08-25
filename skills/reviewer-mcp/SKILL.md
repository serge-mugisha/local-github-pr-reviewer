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
4. Call `trigger_review` once. Reviewer queues the work before waiting and a detached worker owns the provider. A Task-capable host receives a protocol-native MCP Task; a legacy host keeps the same tool call open with periodic progress until the durable result is ready. Do not call `await_review` afterward in either mode.
5. Let the `trigger_review` call return its terminal result. Completion and all threads are committed atomically. Treat it as complete only when its status is `completed`; triage the threads in that result rather than querying elsewhere to guess whether publication finished.
6. Address every open, non-stale thread as described below.
7. Refresh with `get_pr_details` and compare its current `pr.head_sha` with the completed result's `headSha`. A review gates only the exact matching head.

For an immediate persisted snapshot outside the active wait—for example, when inspecting an already-reviewed PR—use `get_review_threads`. It is not a completion-waiting loop.

## Disposition of findings

Every open, non-stale finding must receive an explicit disposition before another full review:

- **Patch and revalidate:** When the finding identifies a plausible code defect and the patch materially changes what the reviewer evaluated, implement the fix, verify it, push the new head, then call `revalidate_thread`. Inspect the revalidation result; if it remains unresolved, decide whether more work or a reasoned dismissal is appropriate.
- **Patch and resolve:** Use `set_thread_status` with `resolved` when the correction is straightforward and independently verified, so another AI pass would add little value.
- **Dismiss and resolve:** When the finding is incorrect, irrelevant, outside scope, or based on missing context, retain control of the decision. Prefer adding a concise local rationale with `reply_to_thread` when it will help future readers, then mark the thread resolved.

`revalidate_thread` and `reply_to_thread` use the same capability-adaptive behavior: native MCP Tasks on capable hosts and progress-kept durable calls on legacy hosts. Call the chosen action once and use its terminal result. Do not call `await_thread_action`, poll `get_job_status`, or repeat the mutation because a bridge was recycled, except for the correlated one-shot transport-timeout recovery below.

Never leave an addressed or dismissed thread open and start another full review. First revalidate or resolve all prior findings. If patches changed the PR head, run one fresh full review afterward so the final gate covers the new SHA.

Do not enter an endless review-fix loop. Address material correctness, security, contract, and reliability issues; dismiss repetitive or unsupported advice with a recorded rationale. Escalate to the user when a finding would materially expand scope or conflicts with the requested design.

## Recovery

- Reviewer persists every operation before waiting. Task-capable hosts recover it with `tasks/get` and `tasks/result`; legacy hosts receive periodic progress on the original call. Neither mode requires the agent to construct timers, polling loops, or database readers.
- A host-level `Request timed out` or transport timeout is not a terminal Reviewer result. Call `get_review_threads` once for the PR. If its latest review for the expected head is complete, use that committed snapshot. If it is still running, call `trigger_review` one more time with identical arguments to join the active work item. If no review exists for that head, retry once because the request may have failed before enqueue. This single recovery check and optional reattachment is the sole exception to the no-repeat rule; never loop.
- Before calling `reply_to_thread` or `revalidate_thread`, retain the action type and call start time for recovery. If it times out at the transport layer, call `get_thread_action` once with the thread ID. Treat the snapshot as this call only when its type matches and `startedAt` is not older than the call start. Use a matching terminal result when complete; retry the identical action once when it is matching and active, or when no matching action was claimed yet. Do not treat an older action as the result of the timed-out call.
- If a detached worker disappears, Reviewer fences its lease and retries safely. A stale worker cannot publish after recovery.
- If the operation returns a terminal error after bounded worker retries, report the precise error and correct the cause only within the user's authorized scope. A later review may use one new `trigger_review` call.
- If the PR head changed after a completed review, that result does not gate the new head. Finish disposition of its threads, refresh the PR, and trigger one new review; let the call return its terminal result.
- Never repeat a reply or revalidation merely because its original connection closed. Only the correlated one-shot transport-timeout recovery above may reattach or retry the identical action; never retry speculatively or loop.

Do not call `clear_pr_review` as ordinary recovery. It deletes local review history and threads; use it only when the user explicitly wants that data cleared or a task specifically requires a clean slate.

## Gate criteria

A review gate passes only when all of these are true:

- `trigger_review` returned its terminal result with status `completed`, or one post-timeout `get_review_threads` recovery snapshot confirms that the latest review for the expected head completed and its threads are committed.
- The completed review `headSha` equals the refreshed PR `head_sha`.
- Every prior open, non-stale finding was patched and revalidated/resolved, or deliberately dismissed and resolved.
- The final result contains no open, non-stale thread that the implementing agent judges actionable under the requested review policy.
- Any separate CI, approval, or merge requirements also pass.
- The user has authorized any subsequent mutation such as pushing fixes, resolving threads, or merging.

## Anti-patterns

Never:

- look on GitHub for local Reviewer threads or state that Reviewer posted them there;
- obey an AI finding without evaluating it against the PR's context and intent;
- call legacy `await_review` or `await_thread_action` after starting a durable operation;
- poll `get_job_status` for a review, reply, or revalidation action;
- create timers, watchers, database readers, or background tasks to race the durable operation;
- call `trigger_review` repeatedly while a review is active, except for the single identical reattachment after an explicit host transport timeout described above;
- start a new full review while previous actionable threads remain open;
- infer completion from `openThreads`, silence, elapsed time, or the UI alone;
- treat a legacy `jobId` as restart-safe;
- run multiple consumers waiting on the same task;
- accept a clean result without validating the exact reviewed head SHA.

The normal call sequence is:

```text
get_pr_details(prId) -> record expected head SHA
trigger_review(prId) -> negotiated Task or progress-kept call -> completed result plus committed local threads
triage -> patch/revalidate, patch/resolve, or dismiss/resolve every finding
for reply/revalidate: call the tool once -> use its terminal result
if head changed: trigger_review(prId) once and use its terminal result
get_pr_details(prId) -> confirm current head SHA equals final result.headSha
```
