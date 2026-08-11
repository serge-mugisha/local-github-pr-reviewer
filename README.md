# Local GitHub PR Reviewer

A local, **read-only** GitHub PR reviewer. Pulls PRs through the GitHub CLI,
hands the diff and your local working copy to a local AI CLI of your choice,
and surfaces inline comments and a per-thread chat in a web UI that resembles
the GitHub PR view.

The reviewer **never writes back to GitHub**. Comments and conversations live
in a local SQLite database and are automatically deleted when a PR is merged
or closed.

[![CI](https://github.com/serge-mugisha/local-github-pr-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/serge-mugisha/local-github-pr-reviewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why

Most PR-review bots post directly to GitHub — noisy for teammates, awkward
during iteration, and they can't see beyond the diff. This tool:

- Runs entirely on your machine. Your code stays local.
- Uses **your local AI CLI** (Claude Code, Antigravity, or Codex today) with full
  read access to the working copy, so the reviewer can grep, read whole
  files, and look at tests before commenting.
- Is **strictly read-only** against GitHub. Nothing you do here ever
  surfaces on the real PR.
- Persists conversations per PR until merge; cleans up automatically.
- Lets you teach it per-repo rules ("focus on auth", "ignore dependabot")
  via a free-form markdown skills file.
- Has a revalidate-per-thread button: after you push a fix, ask the
  reviewer to check whether the concern is now addressed.

## Requirements

- **Node.js 20+**
- **`gh`** (the GitHub CLI), authenticated (`gh auth login`)
- At least one supported AI CLI on your `PATH`:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code)
  - Antigravity CLI (`agy`)
  - [Codex CLI](https://github.com/openai/codex) — authenticate with `codex login`
- Local clones of the repositories you want to review

## Install

```bash
git clone https://github.com/serge-mugisha/local-github-pr-reviewer.git
cd local-github-pr-reviewer
npm install
npm run build
```

## Configure

Copy the example config and tell the reviewer where your local clones live:

```bash
cp config.example.json config.json
```

```json
{
  "provider": "claude",
  "port": 47823,
  "host": "127.0.0.1",
  "repos": [{ "owner": "you", "name": "your-repo", "localPath": "/abs/path/to/clone" }]
}
```

You can also add and remove repos at runtime from the **Settings** page —
paste a local path, the server runs `gh repo view` inside it, and the
GitHub owner/name is auto-detected.

The configured provider is the global reviewer default. In **Settings →
Repositories**, each repo can select its own persisted default provider. On a
PR, the **Reviewer** menu can override that provider for just that PR. Provider
selection resolves in this order: PR override, repository default, then global
default. Replies and revalidation use the same resolved provider as new reviews.

### Antigravity

Antigravity authenticates on its own through the local app/CLI state. Install
and authenticate `agy`, then choose the provider in `config.json`:

```json
{
  "provider": "antigravity",
  "antigravity": { "model": "Gemini 3.5 Flash (Medium)", "printTimeout": "15m" }
}
```

`model` and `printTimeout` are optional. Existing configs that still say
`"provider": "gemini"` or `"provider": "agy"` are treated as Antigravity.

### Codex

Codex authenticates on its own — run `codex login` (or set `OPENAI_API_KEY`).
It runs in a read-only sandbox by default; override the model or sandbox in
`config.json` if needed:

```json
{
  "provider": "codex",
  "codex": { "model": "gpt-5-codex", "sandbox": "read-only" }
}
```

## Run

```bash
npm start        # production: serves UI + API at http://127.0.0.1:47823
npm run dev      # dev: API at :47823, Vite UI with HMR at :47824
npm run stop     # graceful shutdown if you lose the terminal
```

Open `http://127.0.0.1:47823` (or `:47824` in dev).

## Usage

1. From the home page, pick a PR. The list auto-refreshes from GitHub on load.
2. Click **Run review**. The AI investigates the working copy and posts
   inline comments anchored to the diff.
3. **Reply** on any thread to have a conversation with the reviewer about
   that specific concern. The AI has full repo access for each reply.
4. **Revalidate** after pushing a fix — the reviewer re-inspects the
   current working copy and either auto-resolves the thread or explains
   what's still missing.
5. **Mark resolved** to manually close a thread.
6. **Clear review** removes the local review (threads, comments, history)
   for a PR while keeping the PR in the list, so you can start over.
7. Use **Skills** (per repo) to give the reviewer durable instructions:
   files to focus on, patterns to ignore, etc.
8. Choose a **Reviewer** on the PR when it needs a one-off provider override;
   leave it on the inherited default for the repository/global selection.

When a PR is merged or closed on GitHub, all local review data for it is
deleted on the next server launch.

## Read-only guarantee

Every call to `gh` flows through a single module, [`packages/server/src/github.ts`](packages/server/src/github.ts).
That module:

- Only exposes read methods (`listOpenPRs`, `getPR`, `getPRDiff`, …).
- Whitelists subcommands (`pr list|view|diff`, `api` GET only, `auth status`).
- Rejects any non-GET use of `gh api`.

A unit test enforces that **no other file in the codebase** invokes `gh`
via `spawn`/`exec`. See [SECURITY.md](SECURITY.md) for details.

## MCP Server for AI Agents

The tool includes a Model Context Protocol (MCP) server that exposes all PR reviewing, configuration, and conversational features to external AI agents (like Claude Desktop or Antigravity). This allows an AI agent to read PR diffs, set review rules, trigger reviews, and reply to threads directly from its own environment without using the web UI.

### Usage with MCP Clients

Add the MCP server to your AI agent's configuration. Ensure that the project is built first (`npm run build`).

**For Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "local-github-pr-reviewer": {
      "command": "node",
      "args": ["/absolute/path/to/local-github-pr-reviewer/packages/mcp/dist/index.js"]
    }
  }
}
```

**For Antigravity** (`.gemini/config/config.json`):

```json
{
  "mcp": {
    "servers": {
      "local-github-pr-reviewer": {
        "command": "node",
        "args": ["/absolute/path/to/local-github-pr-reviewer/packages/mcp/dist/index.js"]
      }
    }
  }
}
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│  React UI (Vite)                                 │
│  PR list · diff viewer · threads · chat · skills │
└──────────────────┬───────────────────────────────┘
                   │  REST + SSE  (127.0.0.1 only)
┌──────────────────▼───────────────────────────────┐
│  Node server (Fastify)                           │
└──┬───────────────┬──────────────────┬────────────┘
   │               │                  │
   ▼               ▼                  ▼
 gh CLI         SQLite          Provider registry
 (read-only)    (better-sqlite3) ┌─────────┬─────────┐
                                 │ claude  │ antigravity │  … extend here
                                 └────┬────┴────┬────┘
                                      │ spawned with cwd = local checkout
                                      ▼
                              Local repo working copy
```

## Adding a new AI provider

Implement the `Provider` interface and register it.

1. Create `packages/server/src/providers/<name>.ts`.
2. Implement `review`, `reply`, and `revalidate`. Most providers shell out
   to a CLI via `spawnCli` (see [`claude.ts`](packages/server/src/providers/claude.ts) or [`antigravity.ts`](packages/server/src/providers/antigravity.ts)).
3. Add to the registry in [`providers/index.ts`](packages/server/src/providers/index.ts).
4. Add the id to the `provider` enum in [`config.ts`](packages/server/src/config.ts) if you want it
   selectable from the UI.

## Project layout

```
local-github-pr-reviewer/
├── packages/
│   ├── mcp/     Model Context Protocol server for AI agents
│   ├── server/  Fastify + SQLite + provider adapters
│   └── web/     Vite + React UI
├── scripts/     Operational helpers (stop, etc.)
├── tests/       Cross-package tests (read-only invariant, etc.)
├── config.example.json
└── README.md
```

## Contributing

Issues and PRs welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
