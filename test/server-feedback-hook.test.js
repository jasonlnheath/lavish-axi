import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";
import { sessionKey } from "../src/session-store.js";

// The operator's receiver, standing in for firstmate's inbox writer: it records every payload it is
// handed to a file the test can read, and it can be told to refuse.
const HOOK_SCRIPT = `
import { appendFile, readFile, writeFile } from "node:fs/promises";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const attemptsFile = process.env.HOOK_ATTEMPTS;
let attempts = 0;
try {
  attempts = Number(await readFile(attemptsFile, "utf8"));
} catch {}
attempts += 1;
await writeFile(attemptsFile, String(attempts));

if (Number(process.env.HOOK_FAIL_UNTIL || 0) < attempts) {
  await appendFile(process.env.HOOK_RECORD, JSON.stringify(JSON.parse(raw)) + "\\n");
  process.exit(0);
}
console.error("the receiver refused this delivery");
process.exit(1);
`;

/**
 * @param {string} dir
 */
async function hookPaths(dir) {
  const script = path.join(dir, "hook.mjs");
  await writeFile(script, HOOK_SCRIPT);
  await chmod(script, 0o700);
  return { script, record: path.join(dir, "record.jsonl"), attempts: path.join(dir, "attempts") };
}

/**
 * @param {string} file
 * @param {number} count
 * @param {number} [timeoutMs]
 */
async function waitForHookRecords(file, count, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    /** @type {Array<Record<string, any>>} */
    let entries;
    try {
      entries = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      entries = [];
    }
    if (entries.length >= count) return entries;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} hook record(s), saw ${entries.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * @param {string} file
 */
async function hookRecordCount(file) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * @param {string} base
 * @param {string} file
 */
async function openSession(base, file) {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  const body = await response.json();
  assert.equal(body.key, sessionKey(file));
  return body.key;
}

/**
 * The chrome's own same-origin send.
 *
 * @param {string} base
 * @param {string} key
 * @param {object} payload
 */
async function send(base, key, payload) {
  const response = await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * @param {string} base
 * @param {string} file
 */
async function pollOnce(base, file) {
  return fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`).then((res) => res.json());
}

const ANNOTATION_BATCH = {
  prompts: [
    {
      prompt: "the Amount column is too narrow for the totals",
      selector: "table.budget td.amount",
      tag: "td",
      text: "$1,204,00",
      prompt_id: "chrome-annotation-1",
    },
    { prompt: "widen it and re-check the totals row", tag: "message", text: "", prompt_id: "chrome-message-1" },
  ],
  domSnapshot: '<table class="budget"><tr><td class="amount">$1,204,00</td></tr></table>',
};

test("a Send fires the hook with the accepted batch, and the same batch is still queued for the poll", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-send-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, '<!doctype html><html><body><table class="budget"></table></body></html>');
  const { script, record, attempts } = await hookPaths(dir);
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    log: (line) => logs.push(line),
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.ok(
      logs.some((line) => line.includes("feedback hook enabled (command")),
      "a configured hook is visible in server.log",
    );

    const key = await openSession(base, artifact);
    const queued = await send(base, key, ANNOTATION_BATCH);
    assert.equal(queued.status, 200);
    assert.equal(queued.body.pending_prompts, 2);

    const [hook] = await waitForHookRecords(record, 1);
    assert.equal(hook.session.file, artifact);
    assert.equal(hook.session.key, key);
    assert.equal(hook.session.status, "feedback");
    assert.ok(!("session_ended" in hook.session), "a plain Send does not end the session");
    assert.deepEqual(
      hook.prompts.map((prompt) => prompt.prompt),
      ["the Amount column is too narrow for the totals", "widen it and re-check the totals row"],
    );
    const annotation = hook.prompts[0];
    assert.equal(annotation.selector, "table.budget td.amount");
    assert.equal(annotation.tag, "td");
    assert.equal(annotation.text, "$1,204,00");
    // The chrome mints this id and the poll never sees it, so neither does the hook - and the payload
    // carries exactly the prompt fields a poll carries for the same note, nothing invented.
    assert.ok(!("prompt_id" in annotation), "the hook payload mirrors the agent-facing queue");
    assert.deepEqual(Object.keys(annotation).sort(), ["prompt", "selector", "tag", "text", "uid"]);
    assert.match(hook.dom_snapshot, /table class="budget"/);
    assert.equal(typeof hook.at, "string");

    // The whole point of the issue: the hook is additional. The poll still gets the batch whole.
    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.deepEqual(delivered.prompts, hook.prompts, "the hook payload and the poll payload are one schema");

    const afterPoll = await pollOnce(base, artifact);
    assert.equal(afterPoll.status, "waiting");
    assert.equal(await hookRecordCount(record), 1, "one send is one hook delivery");
    assert.equal(Number(await readFile(attempts, "utf8")), 1, "a healthy hook is not retried");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Send & End fires exactly once for its final batch and reports the end the way a poll reports it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-end-"));
  const artifact = path.join(dir, "report.html");
  const other = path.join(dir, "other.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  await writeFile(other, "<!doctype html><html><body><h1>other</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    // A second board stays open so the server outlives this session's end and the retry below is a
    // real request rather than a refused connection.
    const otherKey = await openSession(base, other);
    const sent = await send(base, key, {
      prompts: [{ prompt: "that is the last change I need, ending the review", tag: "message", text: "" }],
      endSession: true,
    });
    assert.equal(sent.status, 200);

    const records = await waitForHookRecords(record, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].session.status, "feedback");
    assert.equal(records[0].session.session_ended, true);
    assert.equal(records[0].session.ended_by, "user");

    // Whatever the chrome retries after the end, the hook never re-pushes the note it already pushed.
    const late = await send(base, key, ANNOTATION_BATCH);
    assert.equal(late.body.status, "ended");
    const otherSend = await send(base, otherKey, {
      prompts: [{ prompt: "still reviewing this one", tag: "message", text: "" }],
    });
    assert.equal(otherSend.status, 200);
    const otherHook = await waitForHookRecords(record, 2);
    assert.ok(!("session_ended" in otherHook[1].session), "the end belongs to the session that ended");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await hookRecordCount(record), 2, "one push per accepted send, never for a rejected one");
    assert.equal(Number(await readFile(attempts, "utf8")), 2);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll keeps working on its own while a hook is configured, including for a session the hook pushed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-poll-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const receiver = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.writeHead(204).end());
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = /** @type {import("node:net").AddressInfo} */ (receiver.address()).port;
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    feedbackHook: {
      webhook: `http://127.0.0.1:${receiverPort}/inbox`,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    await send(base, key, ANNOTATION_BATCH);
    const [hook] = await waitForHookRecords(record, 1);

    // An agent that starts its poll after the Send still gets the note from the queue, because the
    // hook never took it out of the queue on the way past.
    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.deepEqual(delivered.prompts, hook.prompts);

    // A second send wakes the waiting poll exactly as it always has.
    await send(base, key, { prompts: [{ prompt: "second note", tag: "message", text: "" }] });
    const longPoll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=2000`).then((res) =>
      res.json(),
    );
    assert.equal(longPoll.status, "feedback");
    assert.deepEqual(
      longPoll.prompts.map((prompt) => prompt.prompt),
      ["second note"],
    );
    await waitForHookRecords(record, 2);
    assert.equal(await hookRecordCount(record), 2);
  } finally {
    await server.close();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a webhook that refuses the batch never changes what the browser send returns or what the poll delivers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-webhook-down-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const seen = [];
  const receiver = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      seen.push(req.method);
      res.writeHead(503).end("receiver down");
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = /** @type {import("node:net").AddressInfo} */ (receiver.address()).port;
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    log: (line) => logs.push(line),
    feedbackHook: {
      webhook: `http://127.0.0.1:${receiverPort}/inbox`,
      command: null,
      extraEnv: {},
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    const queued = await send(base, key, ANNOTATION_BATCH);
    assert.equal(queued.status, 200, "the reviewer's Send succeeded even though the hook is down");
    assert.equal(queued.body.status, "queued");

    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.deepEqual(
      delivered.prompts.map((prompt) => prompt.prompt),
      ["the Amount column is too narrow for the totals", "widen it and re-check the totals row"],
    );

    const deadline = Date.now() + 4_000;
    while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ["POST", "POST"], "the webhook retried exactly once");

    const failure = logs.find((line) => line.includes("feedback hook webhook failed twice"));
    assert.ok(failure, `a down webhook is logged, saw: ${JSON.stringify(logs)}`);
    assert.match(failure, /HTTP 503/);
    assert.match(failure, /still queued for `lavish-axi poll`/);
    assert.ok(!logs.some((line) => line.includes("error")), "the failure stayed a log line, not an error path");
  } finally {
    await server.close();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook process that fails outright never reaches the reviewer's Send or the agent's poll", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-broken-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    log: (line) => logs.push(line),
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      // HOOK_FAIL_UNTIL above the attempt count means every attempt refuses.
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, HOOK_FAIL_UNTIL: "99" },
      retryDelayMs: 10,
      timeoutMs: 2_000,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    const queued = await send(base, key, ANNOTATION_BATCH);
    assert.equal(queued.status, 200);

    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.equal(delivered.prompts.length, 2);

    const deadline = Date.now() + 4_000;
    while (!logs.some((line) => line.includes("feedback hook command failed twice")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const failure = logs.find((line) => line.includes("feedback hook command failed twice"));
    assert.ok(failure, `a broken hook is logged, saw: ${JSON.stringify(logs)}`);
    assert.match(failure, /exit 1/);
    assert.equal(Number(await readFile(attempts, "utf8")), 2, "one retry, and then it stops");
    assert.equal(await hookRecordCount(record), 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch that arrives again is not pushed a second time, including a disconnected poll's restore", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-replay-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    await send(base, key, ANNOTATION_BATCH);
    await waitForHookRecords(record, 1);

    // The chrome's queued bubble arriving a second time: the same prompt_ids, already acknowledged.
    const duplicate = await send(base, key, ANNOTATION_BATCH);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.pending_prompts, 2, "the queue still holds the one batch");

    // A poll that disconnected mid-delivery hands its taken batch back through the same route.
    const restored = await send(base, key, { ...ANNOTATION_BATCH, restore: true });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.pending_prompts, 2);

    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.equal(delivered.prompts.length, 2);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await hookRecordCount(record), 1, "the hook pushes a send, never a replay of one");
    assert.equal(Number(await readFile(attempts, "utf8")), 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a caller the chrome guard rejects never reaches the operator's hook", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-guard-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);

    for (const headers of [
      { "content-type": "application/json", origin: "https://evil.example" },
      { "content-type": "application/json" },
    ]) {
      const rejected = await fetch(`${base}/api/${key}/prompts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompts: [{ prompt: "push this to the operator's inbox", tag: "message", text: "" }] }),
      });
      assert.equal(rejected.status, 403);
    }

    const waiting = await pollOnce(base, artifact);
    assert.equal(waiting.status, "waiting");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await hookRecordCount(record),
      0,
      "a hook that a foreign page could wake would be a bridge from the browser to the operator's machine",
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server with no hook configured sends feedback exactly the way it did before", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-none-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    log: (line) => logs.push(line),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    const queued = await send(base, key, ANNOTATION_BATCH);
    assert.equal(queued.status, 200);
    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.equal(delivered.prompts.length, 2);
    assert.ok(!logs.some((line) => line.includes("feedback hook")), "an unconfigured server says nothing about hooks");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hook sees the note a user queued from the layout issues inbox like any other note", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-hook-layout-"));
  const artifact = path.join(dir, "report.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>report</h1></body></html>");
  const { script, record, attempts } = await hookPaths(dir);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    feedbackHook: {
      webhook: null,
      command: [process.execPath, script],
      extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      retryDelayMs: 10,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const key = await openSession(base, artifact);
    const queued = await send(base, key, {
      prompts: [
        {
          prompt: "fix the two issues I selected",
          tag: "layout-warnings",
          text: "",
          target: { type: "layout-warnings", warnings: [{ id: "warning-1", summary: "content overflows its column" }] },
        },
      ],
    });
    assert.equal(queued.status, 200);
    const [hook] = await waitForHookRecords(record, 1);
    assert.deepEqual(
      hook.prompts.map((prompt) => prompt.tag),
      ["layout-warnings"],
    );
    const delivered = await pollOnce(base, artifact);
    assert.equal(delivered.status, "feedback");
    assert.deepEqual(delivered.prompts, hook.prompts);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
