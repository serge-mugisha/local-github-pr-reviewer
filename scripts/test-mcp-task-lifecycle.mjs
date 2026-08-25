import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CreateTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

const root = await mkdtemp(join(tmpdir(), "reviewer-task-lifecycle-"));
const repoPath = join(root, "repo");
const remotePath = join(root, "remote.git");
const binPath = join(root, "bin");
const dataPath = join(root, "data");
const configPath = join(root, "config.json");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "packages/mcp/dist/index.js")],
    env,
  });
  const client = new Client(
    { name: "reviewer-task-lifecycle-test", version: "1.0.0" },
    { capabilities: { tasks: { requests: { tools: { call: {} } } } } },
  );
  await client.connect(transport);
  return client;
}

async function waitForTask(client, taskId) {
  let task;
  for (let attempt = 0; attempt < 120; attempt++) {
    task = await client.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return task;
}

try {
  await mkdir(repoPath);
  await mkdir(binPath);
  run("git", ["init", "--bare", remotePath]);
  run("git", ["init", "-b", "main"], repoPath);
  run("git", ["config", "user.email", "reviewer@example.test"], repoPath);
  run("git", ["config", "user.name", "Reviewer Test"], repoPath);
  await writeFile(join(repoPath, "file.txt"), "base\n");
  run("git", ["add", "file.txt"], repoPath);
  run("git", ["commit", "-m", "base"], repoPath);
  const baseSha = run("git", ["rev-parse", "HEAD"], repoPath);
  run("git", ["checkout", "-b", "feature"], repoPath);
  await writeFile(join(repoPath, "file.txt"), "base\nfeature\n");
  run("git", ["commit", "-am", "feature"], repoPath);
  const headSha = run("git", ["rev-parse", "HEAD"], repoPath);
  run("git", ["remote", "add", "origin", remotePath], repoPath);
  run("git", ["push", "origin", "main", "feature"], repoPath);
  run("git", ["update-ref", "refs/pull/1/head", headSha], remotePath);

  const ghScript = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({number:1,title:'Task lifecycle',state:'OPEN',headRefName:'feature',baseRefName:'main',url:'https://example.test/pr/1',isDraft:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',author:{login:'tester'},assignees:[],reviewRequests:[],body:'',headRefOid:process.env.TEST_HEAD_SHA,baseRefOid:process.env.TEST_BASE_SHA,additions:1,deletions:0,changedFiles:1}))
} else if (args[0] === 'pr' && args[1] === 'diff') {
  process.stdout.write('diff --git a/file.txt b/file.txt\\n+feature\\n')
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0)
} else if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write(JSON.stringify({login:'tester'}))
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]')
} else {
  process.stderr.write('unexpected fake gh args: ' + args.join(' ')); process.exit(2)
}
`;
  const claudeScript = `#!/usr/bin/env node
process.stdin.resume()
setTimeout(() => process.stdout.write(JSON.stringify({result:JSON.stringify({summary:'bridge-independent success',comments:[]}),session_id:'task-lifecycle-session'})), 2500)
`;
  await writeFile(join(binPath, "gh"), ghScript);
  await writeFile(join(binPath, "claude"), claudeScript);
  await chmod(join(binPath, "gh"), 0o755);
  await chmod(join(binPath, "claude"), 0o755);
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "claude",
      host: "127.0.0.1",
      port: 47823,
      repos: [{ owner: "test", name: "repo", localPath: repoPath }],
    }),
  );

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    PATH: `${binPath}${delimiter}${process.env.PATH}`,
    REVIEWER_CONFIG_PATH: configPath,
    REVIEWER_DATA_DIR: dataPath,
    REVIEWER_STALE_AFTER_MS: "500",
    REVIEWER_HEARTBEAT_MS: "100",
    TEST_HEAD_SHA: headSha,
    TEST_BASE_SHA: baseSha,
  };
  Object.assign(process.env, env);
  const api = await import("../packages/server/dist/api.js");
  const [repo] = api.syncReposFromConfig([{ owner: "test", name: "repo", localPath: repoPath }]);
  const timestamp = new Date().toISOString();
  api
    .getDb()
    .prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref,
        state, url, author, updated_at)
       VALUES (1, ?, 1, 'Task lifecycle', '', ?, ?, 'feature', 'main',
               'OPEN', 'https://example.test/pr/1', 'tester', ?)`,
    )
    .run(repo.id, headSha, baseSha, timestamp);

  const first = await makeClient(env);
  const startedAt = Date.now();
  const created = await first.request(
    {
      method: "tools/call",
      params: { name: "trigger_review", arguments: { prId: 1 }, task: { ttl: 60_000 } },
    },
    CreateTaskResultSchema,
  );
  if (Date.now() - startedAt > 1_000) throw new Error("Task creation blocked on provider work.");
  await first.close();

  const second = await makeClient(env);
  const task = await waitForTask(second, created.task.taskId);
  if (task?.status !== "completed") {
    throw new Error(`Reconnected task did not complete: ${JSON.stringify(task)}`);
  }
  const result = await second.request(
    { method: "tasks/result", params: { taskId: created.task.taskId } },
    GetTaskPayloadResultSchema,
  );
  await second.close();

  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (!text.includes("bridge-independent success")) {
    throw new Error(`Unexpected task result: ${JSON.stringify(result)}`);
  }
  const work = api.getWorkItem(created.task.taskId);
  if (work?.status !== "done" || work.attempt_count !== 1) {
    throw new Error(`Work was not completed exactly once: ${JSON.stringify(work)}`);
  }
  process.stdout.write(`MCP task survived bridge replacement: ${created.task.taskId}\n`);

  const crashClient = await makeClient(env);
  const crashed = await crashClient.request(
    {
      method: "tools/call",
      params: { name: "trigger_review", arguments: { prId: 1 }, task: { ttl: 60_000 } },
    },
    CreateTaskResultSchema,
  );
  let crashedWork;
  for (let attempt = 0; attempt < 80; attempt++) {
    crashedWork = api.getWorkItem(crashed.task.taskId);
    if (crashedWork?.status === "running" && crashedWork.worker_pid) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!crashedWork?.worker_pid) throw new Error("Detached worker never claimed the crash test.");
  process.kill(crashedWork.worker_pid, "SIGKILL");
  await crashClient.close();

  const recoveryClient = await makeClient(env);
  const recoveredTask = await waitForTask(recoveryClient, crashed.task.taskId);
  if (recoveredTask?.status !== "completed") {
    throw new Error(`Killed worker was not recovered: ${JSON.stringify(recoveredTask)}`);
  }
  const recoveredResult = await recoveryClient.request(
    { method: "tasks/result", params: { taskId: crashed.task.taskId } },
    GetTaskPayloadResultSchema,
  );
  await recoveryClient.close();
  const recoveredText = recoveredResult.content?.find((item) => item.type === "text")?.text ?? "";
  if (!recoveredText.includes("bridge-independent success")) {
    throw new Error(`Recovered task returned the wrong result: ${JSON.stringify(recoveredResult)}`);
  }
  const recoveredWork = api.getWorkItem(crashed.task.taskId);
  const reviews = api.getDb().prepare("SELECT status FROM reviews ORDER BY id").all();
  if (recoveredWork?.status !== "done" || recoveredWork.attempt_count !== 2) {
    throw new Error(`Killed work was not reclaimed exactly once: ${JSON.stringify(recoveredWork)}`);
  }
  if (reviews.filter((review) => review.status === "done").length !== 2) {
    throw new Error(`Recovered review publication was not exact: ${JSON.stringify(reviews)}`);
  }
  process.stdout.write(`MCP task recovered a killed worker: ${crashed.task.taskId}\n`);
} finally {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(root, { recursive: true, force: true });
}
