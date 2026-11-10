import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AxiError } from "axi-sdk-js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { feedbackHookConfigFromArgs, getCommandHelp, refuseFeedbackHookFlags } from "../src/cli.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const HOOK_SCRIPT = `
import { appendFile } from "node:fs/promises";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
await appendFile(
  process.env.HOOK_RECORD,
  JSON.stringify({ payload: JSON.parse(raw), argv: process.argv.slice(1), secret: process.env.LAVISH_TEST_HOOK_SECRET || null }) + "\\n",
);
`;

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function runCli(args, { cwd = REPO_ROOT, env = process.env } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = /** @type {import("node:net").AddressInfo} */ (probe.address()).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** @param {string} dir */
async function hookFixture(dir) {
  const script = path.join(dir, "hook.mjs");
  await writeFile(script, HOOK_SCRIPT);
  await chmod(script, 0o700);
  return { script, record: path.join(dir, "record.jsonl") };
}

/**
 * @param {string} file
 * @param {number} [timeoutMs]
 */
async function waitForHookRecords(file, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const entries = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
      if (entries.length > 0) return entries.map((line) => JSON.parse(line));
    } catch {
      // The hook has not written the file yet, or the line is not flushed: keep waiting.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the hook to record a delivery`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * @param {string} dir
 */
async function readServerLog(dir) {
  try {
    return await readFile(path.join(dir, "server.log"), "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} base
 * @param {string} file
 */
async function openBoard(base, file) {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  return (await response.json()).key;
}

/**
 * @param {number} port
 */
async function waitForServer(port, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json());
      if (health.app === "lavish-axi") return health;
    } catch {
      // The detached server is still binding its listeners: keep asking.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the Lavish server on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test("lavish-axi server --help documents the hook flags, what they deliver, and where they belong", () => {
  const help = getCommandHelp("server");
  assert.match(help, /--feedback-webhook <url>/);
  assert.match(help, /--feedback-cmd/);
  assert.match(help, /--feedback-hook-env/);
  assert.match(help, /LAVISH_AXI_FEEDBACK_WEBHOOK/);
  assert.match(help, /LAVISH_AXI_FEEDBACK_CMD/);
  // The contract an agent reads: same schema as a poll, additional, never a replacement.
  assert.match(help, /dom_snapshot/);
  assert.match(help, /session_ended/);
  assert.match(help, /batch stays queued for `lavish-axi poll`/);
  assert.match(help, /at most once/);
  assert.match(help, /belong to this command only/);
});

test("a hook flag on a command that does not own the server is refused rather than silently ignored", () => {
  // The server command owns the hook, so it passes.
  refuseFeedbackHookFlags(["server", "--feedback-webhook", "http://127.0.0.1:8080/inbox"]);
  refuseFeedbackHookFlags(["server"]);
  refuseFeedbackHookFlags(["open", "report.html"]);

  for (const argv of [
    ["open", "report.html", "--feedback-webhook", "http://127.0.0.1:8080/inbox"],
    ["report.html", "--feedback-cmd", "merge-inbox --json"],
    ["poll", "report.html", "--feedback-hook-env", "FIRSTMATE_SIGNING_SECRET"],
    ["reply", "report.html", "--agent-reply", "done", "--feedback-webhook=http://127.0.0.1:8080/inbox"],
    ["export", "report.html", "--feedback-cmd=merge-inbox"],
    ["stop", "--feedback-webhook", "http://127.0.0.1:8080/inbox"],
  ]) {
    assert.throws(
      () => refuseFeedbackHookFlags(argv),
      (error) => {
        assert.ok(error instanceof AxiError, `${argv.join(" ")} is a typed CLI error`);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /--feedback-(webhook|cmd|hook-env)/);
        assert.match(error.message, /belongs to the Lavish server/);
        assert.ok(error.suggestions.some((hint) => hint.includes("lavish-axi server")));
        assert.ok(error.suggestions.some((hint) => hint.includes("LAVISH_AXI_FEEDBACK_WEBHOOK")));
        return true;
      },
      argv.join(" "),
    );
  }
});

test("a malformed hook flag is refused before the server starts, with the fix named", () => {
  for (const argv of [
    ["server", "--feedback-webhook"],
    ["server", "--feedback-webhook", ""],
    ["server", "--feedback-webhook", "--verbose"],
    ["server", "--feedback-webhook", "not a url"],
    ["server", "--feedback-webhook", "file:///home/jason/.lavish-axi/state.json"],
    ["server", "--feedback-cmd", "--verbose"],
    ["server", "--feedback-cmd", ""],
    ["server", "--feedback-hook-env"],
    ["server", "--feedback-hook-env", "=abc"],
    ["server", "--feedback-hook-env", "LAVISH_TEST_DEFINITELY_UNSET_SECRET"],
  ]) {
    assert.throws(
      () => feedbackHookConfigFromArgs(argv),
      (error) => {
        assert.ok(error instanceof AxiError, `${argv.join(" ")} is a typed CLI error`);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.ok(error.suggestions.length > 0);
        return true;
      },
      argv.join(" "),
    );
  }

  // `--feedback-hook-env <KEY> --feedback-cmd ...` is the ordinary shape: a named key, then the next
  // flag. The key travels to the hook, not into its command line.
  process.env.LAVISH_TEST_CARVED_SECRET = "from-the-server-environment";
  try {
    const config = feedbackHookConfigFromArgs([
      "server",
      "--feedback-hook-env",
      "LAVISH_TEST_CARVED_SECRET",
      "--feedback-cmd",
      "'node' 'hook.mjs'",
    ]);
    assert.deepEqual(config, {
      webhook: null,
      command: ["node", "hook.mjs"],
      extraEnv: { LAVISH_TEST_CARVED_SECRET: "from-the-server-environment" },
    });
  } finally {
    delete process.env.LAVISH_TEST_CARVED_SECRET;
  }
});

test("lavish-axi server --feedback-cmd pushes the accepted batch, and the secret stays out of argv", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-cli-hook-"));
  const port = await freePort();
  const { script, record } = await hookFixture(dir);
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
  };
  const child = spawn(
    process.execPath,
    [
      CLI,
      "server",
      "--port",
      String(port),
      `--feedback-cmd='${process.execPath}' '${script}'`,
      "--feedback-hook-env",
      "LAVISH_TEST_HOOK_SECRET=hunter2",
      `--feedback-hook-env=HOOK_RECORD=${record}`,
    ],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForServer(port);
    const base = `http://127.0.0.1:${port}`;
    const key = await openBoard(base, artifact);
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [{ prompt: "widen the totals column", selector: "td.amount", tag: "td", text: "$1,204,00" }],
      }),
    });
    assert.equal(queued.status, 200);

    const [entry] = await waitForHookRecords(record);
    assert.equal(entry.payload.session.file, artifact);
    assert.deepEqual(
      entry.payload.prompts.map((prompt) => prompt.prompt),
      ["widen the totals column"],
    );
    assert.equal(entry.secret, "hunter2");
    assert.ok(!entry.argv.includes("hunter2"), "a secret named by --feedback-hook-env never reaches argv");
    assert.ok(!stderr.includes("hunter2"), "the secret is not printed either");
  } finally {
    // The server this test started is this test's to stop. A `child.kill()` on a child that already
    // exited would leave the await hanging forever, so only wait when it is still running.
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server Lavish starts for an agent picks the hook up from its environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-cli-hook-env-"));
  const port = await freePort();
  const { script, record } = await hookFixture(dir);
  const artifact = path.join(dir, "board.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>board</h1></body></html>");
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_FEEDBACK_CMD: `'${process.execPath}' '${script}'`,
    HOOK_RECORD: record,
  };
  let stoppedPort = false;
  try {
    // No `lavish-axi server` was ever run by hand: this is the open command's own auto-start, which
    // is the path a fleet actually takes.
    const opened = await runCli([artifact], { env });
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    await waitForServer(port);

    const base = `http://127.0.0.1:${port}`;
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [{ prompt: "the environment-configured hook should see this", tag: "message", text: "" }],
      }),
    });
    assert.equal(queued.status, 200);

    const [entry] = await waitForHookRecords(record);
    assert.equal(entry.payload.session.file, artifact);
    assert.deepEqual(
      entry.payload.prompts.map((prompt) => prompt.prompt),
      ["the environment-configured hook should see this"],
    );
    // The server this command started on its own is the one that pushed it.
    assert.match(await readServerLog(dir), /feedback hook enabled \(command/);

    // Stop the server this test started, the way the CLI itself stops an owned server.
    const stopped = await runCli(["stop", "--port", String(port)], { env });
    stoppedPort = stopped.status === 0;
    assert.ok(stoppedPort, stopped.stdout + stopped.stderr);
  } finally {
    // A failed assertion must not leave an owned server listening on the operator's machine.
    if (!stoppedPort) await runCli(["stop", "--port", String(port)], { env });
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unset hook environment leaves an auto-started server exactly as it was", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-cli-hook-off-"));
  const port = await freePort();
  const artifact = path.join(dir, "board.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>board</h1></body></html>");
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_FEEDBACK_WEBHOOK: "",
    LAVISH_AXI_FEEDBACK_CMD: "",
  };
  let stoppedPort = false;
  try {
    const opened = await runCli([artifact], { env });
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    await waitForServer(port);
    const base = `http://127.0.0.1:${port}`;
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "ordinary feedback", tag: "message", text: "" }] }),
    });
    assert.equal(queued.status, 200);
    const delivered = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then((res) =>
      res.json(),
    );
    assert.equal(delivered.status, "feedback");
    assert.deepEqual(
      delivered.prompts.map((prompt) => prompt.prompt),
      ["ordinary feedback"],
    );
    // The detached server this command started logs to LAVISH_AXI_STATE_DIR/server.log. Nothing in
    // this run configured a hook, so that log says nothing about one - and nothing was pushed.
    await stat(path.join(dir, "server.log"));
    assert.ok(
      !(await readFile(path.join(dir, "server.log"), "utf8")).includes("feedback hook"),
      "an unconfigured server says nothing about hooks, and pushes nothing",
    );

    const stopped = await runCli(["stop", "--port", String(port)], { env });
    stoppedPort = stopped.status === 0;
    assert.ok(stoppedPort, stopped.stdout + stopped.stderr);
  } finally {
    if (!stoppedPort) await runCli(["stop", "--port", String(port)], { env });
    await rm(dir, { recursive: true, force: true });
  }
});
