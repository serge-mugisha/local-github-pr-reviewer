# Contributing

Thanks for considering a contribution. This project aims to stay small, sharp,
and local-first. Please read this before opening a PR.

## Quick start

```bash
git clone https://github.com/serge-mugisha/local-github-pr-reviewer.git
cd local-github-pr-reviewer
npm install
cp config.example.json config.json    # point it at a real local clone or two
npm run dev
```

Server at `http://127.0.0.1:47823`. Dev UI with HMR at `http://127.0.0.1:47824`.

## Before opening a PR

```bash
npm run ci   # runs lint + typecheck + tests + build
```

CI runs the same on every PR. If `npm run ci` is green locally, CI will be
green too.

You can also run individual steps:

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
```

## Design principles

These shape what we will and won't accept.

1. **Read-only against GitHub. Forever.** No code path may post comments,
   reviews, or any other state back to GitHub. There is a unit test that
   enforces this — see [SECURITY.md](SECURITY.md). PRs that add write
   functionality will not be merged.

2. **Local-first.** Everything runs on the user's machine, against the
   user's own clones, using the user's own AI CLI auth. No remote services,
   no telemetry, no analytics, no auto-update phone-home.

3. **Provider seam stays thin.** A provider is a small adapter that hands
   a prompt + cwd to an AI tool and returns text. Don't add provider-specific
   behavior outside the provider file. If you're tempted to put a
   `if (provider === 'claude')` branch anywhere else, stop and rethink.

4. **Bias toward silence.** The reviewer's job is to catch real issues, not
   to find something to say about every diff. If a feature would push the
   reviewer toward more comments rather than better ones, it's probably
   the wrong feature.

5. **Small surface area.** This is a personal tool. We deliberately avoid
   multi-user features, auth, hosted deployment guides, etc.

## Adding a provider

This is the most common kind of contribution. See the "Adding a new AI
provider" section of the [README](README.md). The PR should:

- Add `packages/server/src/providers/<name>.ts` implementing the `Provider`
  interface.
- Register it in [`providers/index.ts`](packages/server/src/providers/index.ts).
- Add the id to the `provider` enum in [`config.ts`](packages/server/src/config.ts).
- Add tests under `packages/server/src/providers/<name>.test.ts` for any
  non-trivial parsing logic the provider needs.
- Update the README's "Requirements" section if the provider needs a new CLI.

Keep the provider file focused on prompt → CLI → text. Reuse `buildReviewPrompt`,
`buildReplyPrompt`, `buildRevalidatePrompt`, and the shared parser.

## Style

- TypeScript strict mode is on; we expect zero `any`.
- Default to no comments. Only add one when the _why_ is non-obvious.
- Don't add abstractions for hypothetical future requirements.
- Run `npm run format` before committing.

## Commit messages

Short, imperative, lower case. Body optional but appreciated for non-trivial
changes. Example:

```
add provider: ollama

Adds an Ollama-backed local provider. Uses the same prompt builders and JSON
parser as claude/antigravity; the only delta is the CLI invocation.
```

## Reporting bugs / requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For bugs, include the
provider, the output of `gh --version` and `node --version`, and the relevant
section of the server log.

## Security

If you find a way to make the tool post to GitHub, leak secrets, or otherwise
violate its "read-only, local-only" promise, please follow the disclosure
process in [SECURITY.md](SECURITY.md).
