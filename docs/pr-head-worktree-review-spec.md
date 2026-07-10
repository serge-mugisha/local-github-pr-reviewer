# PR Head Worktree Review Spec

## Problem

The reviewer fetches pull request metadata and the PR diff from GitHub, but the
provider process is started in `repo.local_path`. During due diligence, the
provider reads whatever code is currently checked out in that local repository.
That is only correct when the user's current branch happens to match the PR
head being reviewed.

This breaks when:

- The user is on `main` while reviewing a feature PR.
- Multiple agents share the same local repository and switch branches.
- The PR head moves after the local checkout was last updated.
- Reply or revalidation flows inspect local code after the ambient branch has
  changed.

The review invariant should be:

> Every provider filesystem read during review, reply, and revalidation must
> resolve against the same PR head SHA that the app fetched from GitHub for that
> operation.

## Current Behavior

Relevant files:

- `packages/server/src/review.ts`
  - `runReview` calls `hydratePR(...)` and `gh.getPRDiff(...)`.
  - `ReviewContext.cwd` is set to `repo.local_path`.
  - `runReply` and `runRevalidate` also set `cwd` to `repo.local_path`.
- `packages/server/src/providers/*.ts`
  - Providers spawn `codex`, `claude`, or `agy` using `ctx.cwd`.
- `packages/server/src/providers/prompt.ts`
  - The prompt tells the provider to inspect the working copy at the current
    working directory.

The SHA is present in the prompt, but it is informational only. The filesystem
root remains the user's ambient checkout.

## Proposed Design

Add a server-side helper that prepares an isolated detached git worktree at the
PR head SHA and returns that path as the provider cwd.

Suggested file:

- `packages/server/src/prWorktree.ts`

Suggested exported API:

```ts
export interface PrWorktree {
  cwd: string;
  cleanup(): Promise<void>;
}

export async function preparePrHeadWorktree(args: {
  repo: RepoRow;
  pr: Pick<PrRow, "number" | "head_sha">;
  onProgress?: ProviderProgress;
}): Promise<PrWorktree>;
```

The helper should use `git`, not `gh`. The existing test suite enforces that
only `github.ts` and `repoDetect.ts` may call the GitHub CLI, and this feature
does not require new GitHub CLI usage.

## Worktree Preparation

Recommended flow:

1. Resolve a deterministic storage location under `dataDir()`, for example:
   `dataDir()/worktrees/repo-<repo.id>/pr-<pr.number>-<pr.head_sha>`.
2. Fetch the PR ref into a local reviewer-owned ref:
   `git -C <repo.local_path> fetch --no-tags origin +refs/pull/<number>/head:refs/reviewer/pr/<repo.id>/<number>`.
3. Verify the fetched ref resolves to the GitHub head SHA:
   `git -C <repo.local_path> rev-parse refs/reviewer/pr/<repo.id>/<number>`.
4. If the resolved SHA differs from `pr.head_sha`, fail before invoking the
   provider.
5. Create or refresh a detached worktree at that SHA:
   `git -C <repo.local_path> worktree add --detach <worktreePath> <headSha>`.
6. If the path already exists, confirm it is a git worktree at `headSha`.
   If it points elsewhere or is corrupt, remove that worktree path using
   `git worktree remove --force <worktreePath>` or filesystem cleanup as a
   fallback, then recreate it.
7. Return `{ cwd: worktreePath, cleanup }`.

Cleanup can remove the worktree after the provider exits:

```sh
git -C <repo.local_path> worktree remove --force <worktreePath>
```

It is acceptable to keep worktrees temporarily if cleanup fails, but the failure
should be logged through `onProgress` and must not hide the provider result.

## Review Flow Changes

In `runReview`:

1. Keep refreshing PR details with `hydratePR(repo, pr.number)`.
2. Keep fetching the diff from GitHub.
3. Call `preparePrHeadWorktree({ repo, pr: refreshed, onProgress })`.
4. Set `ctx.cwd` to the returned worktree path.
5. Invoke `provider.review(ctx, onProgress)`.
6. Record sessions using the same worktree cwd that the provider used.
7. Cleanup in a `finally` block.

The database should continue storing comments, reviews, stale markers, and
thread SHAs using `refreshed.head_sha`.

## Reply Flow Changes

`runReply` currently uses the PR row passed to it directly. Update it to refresh
the PR first:

```ts
const refreshed = await hydratePR(repo, pr.number);
```

Then prepare the PR head worktree from `refreshed`, use it as `ReplyContext.cwd`,
record sessions against that cwd, and write the AI comment using
`refreshed.head_sha`.

This keeps follow-up answers aligned with the current PR head instead of a
stale database row or ambient local branch.

## Revalidation Flow Changes

`runRevalidate` already refreshes the PR. Prepare the PR head worktree from the
refreshed row, pass that cwd into `RevalidateContext`, record sessions against
that cwd, and cleanup after the provider finishes.

The prompt text should also change from "CURRENT state of the working copy" to
the current PR head worktree, because "current working copy" is ambiguous in a
multi-agent environment.

## Prompt Changes

Update `packages/server/src/providers/prompt.ts` so providers are told:

- The current working directory is a detached worktree checked out at the PR
  head SHA.
- Filesystem reads and grep commands should be treated as PR-head state.

Avoid asking providers to perform branch checkout or fetch operations
themselves. The server should own the revision selection.

## Edge Cases

- **Fork PRs:** `refs/pull/<number>/head` on the base repository should work for
  normal GitHub PRs, including fork PRs. If a remote does not expose PR refs, the
  helper should fail with an actionable error.
- **Moved PR head:** Fetch and verify against `hydratePR`'s `head_sha` for each
  operation. Do not reuse an older worktree for a new SHA.
- **Concurrent reviews:** Include the SHA in the worktree path so concurrent
  review runs for different PR heads do not race on the same checkout.
- **Provider sessions:** Keep using the actual provider cwd when recording
  sessions. Claude cleanup is cwd-sensitive.
- **User local changes:** Never checkout, reset, or clean the user's configured
  `repo.local_path`. All provider filesystem reads should happen in the detached
  worktree.

## Tests

Add focused tests before or alongside implementation:

- `prWorktree` fetches `refs/pull/<number>/head` into a reviewer-owned ref.
- `prWorktree` verifies that the fetched ref equals `pr.head_sha`.
- A SHA mismatch rejects before provider invocation.
- `runReview` passes the worktree cwd to the provider, not `repo.local_path`.
- `runReview` records provider sessions with the worktree cwd.
- `runReply` refreshes the PR, uses the worktree cwd, and stores the AI response
  with the refreshed head SHA.
- `runRevalidate` uses the refreshed head worktree cwd.
- Existing read-only GitHub CLI invariant remains valid.

## Acceptance Criteria

- Starting a review while the configured repository is checked out on `main`
  still causes provider file reads to inspect the PR head.
- Starting two reviews for different PRs or SHAs does not require switching the
  user's local branch.
- Reply and revalidate operations inspect the current PR head, not the ambient
  local checkout.
- The implementation does not introduce any new `gh` invocation outside the
  existing allow-list.
- Provider behavior remains otherwise unchanged.
