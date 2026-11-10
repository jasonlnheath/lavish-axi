import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FEEDBACK_HOOK_FLAG_HINTS,
  FeedbackHookConfigError,
  buildFeedbackHookPayload,
  createFeedbackHookDelivery,
  describeFeedbackWebhook,
  normalizeFeedbackWebhookUrl,
  parseFeedbackHookCommand,
  parseFeedbackHookEnv,
  resolveFeedbackHookConfig,
} from "../src/feedback-hook.js";

// A stand-in for the operator's receiver: it records every payload it is handed, how it was named,
// and what it was given in the environment, and it can be told to refuse its first N attempts.
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

const failUntil = Number(process.env.HOOK_FAIL_UNTIL || 0);
if (attempts < failUntil) {
  console.error("the receiver refused this delivery");
  process.exit(1);
}

const record = {
  payload: JSON.parse(raw),
  argv: process.argv.slice(1),
  secret: process.env.LAVISH_TEST_HOOK_SECRET || null,
  attempts,
};
await appendFile(process.env.HOOK_RECORD, JSON.stringify(record) + "\\n");
if (process.env.HOOK_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOOK_DELAY_MS)));
`;

async function createHookDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-feedback-hook-"));
  const script = path.join(dir, "hook.mjs");
  await writeFile(script, HOOK_SCRIPT);
  await chmod(script, 0o700);
  return {
    dir,
    script,
    record: path.join(dir, "record.jsonl"),
    attempts: path.join(dir, "attempts"),
  };
}

/** @param {string} file */
async function readJsonl(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * @param {{ at?: string }} [options]
 */
function annotationPayload({ at } = {}) {
  return buildFeedbackHookPayload({
    key: "abc123",
    session: {
      key: "abc123",
      file: "/tmp/review/report.html",
      status: "feedback",
      dom_snapshot: "<body><h1>Report</h1></body>",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    at,
    prompts: [
      {
        uid: "u1",
        prompt: "make this column wider",
        selector: "table.budget td.amount",
        tag: "div",
        text: "Amount",
        attachments: [],
      },
      { uid: "u2", prompt: "ship it", tag: "message", text: "" },
    ],
  });
}

test("no hook flags and no hook environment leaves the server with no hook at all", () => {
  assert.equal(resolveFeedbackHookConfig({ env: {} }), null);
  assert.equal(resolveFeedbackHookConfig({ webhookFlag: "", commandFlag: "  ", hookEnvFlags: [], env: {} }), null);
  assert.equal(createFeedbackHookDelivery(null), null);
  assert.equal(createFeedbackHookDelivery({ webhook: null, command: null }), null);
});

test("flags configure the hook, and a flag beats the environment it duplicates", () => {
  const fromFlags = resolveFeedbackHookConfig({
    webhookFlag: "http://127.0.0.1:8080/inbox",
    commandFlag: "'/usr/bin/inbox-merge' '--json'",
    hookEnvFlags: ["FIRSTMATE_SIGNING_SECRET=s3cret"],
    env: {},
  });
  assert.deepEqual(fromFlags, {
    webhook: "http://127.0.0.1:8080/inbox",
    command: ["/usr/bin/inbox-merge", "--json"],
    extraEnv: { FIRSTMATE_SIGNING_SECRET: "s3cret" },
  });

  const fromEnvironment = resolveFeedbackHookConfig({
    env: {
      LAVISH_AXI_FEEDBACK_WEBHOOK: "https://rig.example/inbox",
      LAVISH_AXI_FEEDBACK_CMD: "merge-inbox --json",
    },
  });
  assert.deepEqual(fromEnvironment, {
    webhook: "https://rig.example/inbox",
    command: ["merge-inbox", "--json"],
    extraEnv: {},
  });

  const flagWins = resolveFeedbackHookConfig({
    webhookFlag: "http://127.0.0.1:8080/inbox",
    env: { LAVISH_AXI_FEEDBACK_WEBHOOK: "https://rig.example/inbox" },
  });
  assert.equal(flagWins.webhook, "http://127.0.0.1:8080/inbox");
});

test("a webhook that is not an http(s) URL is refused with actionable suggestions", () => {
  for (const value of ["not-a-url", "file:///etc/passwd", "ftp://rig.example/inbox"]) {
    assert.throws(
      () => resolveFeedbackHookConfig({ webhookFlag: value, env: {} }),
      (error) => {
        assert.ok(error instanceof FeedbackHookConfigError, `${value} refused as a configuration error`);
        assert.ok(error.suggestions.some((hint) => hint.includes("lavish-axi server --help")));
        assert.ok(error.suggestions.some((hint) => hint.includes("LAVISH_AXI_FEEDBACK_WEBHOOK")));
        return true;
      },
      value,
    );
  }
  assert.equal(normalizeFeedbackWebhookUrl("http://rig.example/inbox?token=x"), "http://rig.example/inbox?token=x");
});

test("--feedback-cmd is split into words without a shell, quoting groups words, and an unterminated quote is refused", () => {
  assert.deepEqual(parseFeedbackHookCommand("merge-inbox --json"), ["merge-inbox", "--json"]);
  assert.deepEqual(parseFeedbackHookCommand("'node hook.mjs'   '--json'"), ["node hook.mjs", "--json"]);
  assert.deepEqual(parseFeedbackHookCommand('node "hook with spaces.mjs" --json'), [
    "node",
    "hook with spaces.mjs",
    "--json",
  ]);
  // No shell ran this, so $VAR stayed literal text instead of becoming an expanded secret.
  assert.deepEqual(parseFeedbackHookCommand("merge --token $FIRSTMATE_SIGNING_SECRET"), [
    "merge",
    "--token",
    "$FIRSTMATE_SIGNING_SECRET",
  ]);
  assert.throws(() => parseFeedbackHookCommand("merge 'unterminated"), FeedbackHookConfigError);
  assert.throws(() => parseFeedbackHookCommand("   "), FeedbackHookConfigError);
});

test("--feedback-hook-env carries a secret to the hook without spelling it into the command", () => {
  assert.deepEqual(parseFeedbackHookEnv(["TOKEN=abc"], {}), { TOKEN: "abc" });
  assert.deepEqual(parseFeedbackHookEnv(["TOKEN"], { TOKEN: "from-server-environment" }), {
    TOKEN: "from-server-environment",
  });
  assert.deepEqual(parseFeedbackHookEnv(["A=1", "B=2"], {}), { A: "1", B: "2" });
  for (const value of ["", "   ", "=abc", "BAD NAME=1", "TOKEN="]) {
    assert.throws(() => parseFeedbackHookEnv([value], { TOKEN: "x" }), FeedbackHookConfigError, JSON.stringify(value));
  }
  assert.throws(
    () => parseFeedbackHookEnv(["MISSING"], {}),
    (error) => {
      assert.ok(error instanceof FeedbackHookConfigError);
      assert.ok(error.suggestions.some((hint) => hint.includes("MISSING")));
      return true;
    },
    "a bare KEY the server does not have is a refused configuration",
  );
});

test("the payload is the feedback object a poll hands the agent for the same batch", () => {
  const payload = annotationPayload();
  assert.deepEqual(Object.keys(payload).sort(), ["at", "dom_snapshot", "prompts", "session"]);
  assert.deepEqual(payload.session, {
    file: "/tmp/review/report.html",
    key: "abc123",
    status: "feedback",
  });
  assert.equal(payload.dom_snapshot, "<body><h1>Report</h1></body>");
  assert.equal(payload.at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(payload.prompts[0], {
    uid: "u1",
    prompt: "make this column wider",
    selector: "table.budget td.amount",
    tag: "div",
    text: "Amount",
    attachments: [],
  });

  // An end that rode on the note is reported the way a poll reports it, not as a new field.
  const ended = buildFeedbackHookPayload({
    key: "abc123",
    session: { key: "abc123", file: "/tmp/review/report.html", status: "ended", ended_by: "user" },
    prompts: [{ uid: "u1", prompt: "done, ending the review", tag: "message", text: "" }],
    at: "2026-01-01T00:01:00.000Z",
  });
  assert.deepEqual(ended.session, {
    file: "/tmp/review/report.html",
    key: "abc123",
    status: "feedback",
    session_ended: true,
    ended_by: "user",
  });
});

test("a command hook receives the payload as one JSON object on stdin, and never its secret in argv", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  const logs = [];
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: null,
        command: [process.execPath, script, "--json"],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, LAVISH_TEST_HOOK_SECRET: "s3cret" },
      },
      { logFailure: (line) => logs.push(`failure: ${line}`), logSuccess: (line) => logs.push(`success: ${line}`) },
    );

    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, true);
    const [entry] = await readJsonl(record);
    assert.deepEqual(
      entry.payload.prompts.map((prompt) => prompt.prompt),
      ["make this column wider", "ship it"],
    );
    assert.equal(entry.payload.session.file, "/tmp/review/report.html");
    assert.equal(entry.argv.join(" "), `${script} --json`);
    // The secret arrived through the environment the operator named, not through the command line
    // every `ps` on the machine can read.
    assert.equal(entry.secret, "s3cret");
    assert.ok(!entry.argv.includes("s3cret"));
    assert.deepEqual(logs, ["success: feedback hook command delivered"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook call never waits for the receiver, so a slow endpoint cannot hold up the send", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: null,
        command: [process.execPath, script],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, HOOK_DELAY_MS: "80" },
      },
      { retryDelayMs: 5 },
    );
    const startedAt = Date.now();
    const inflight = delivery.deliver(annotationPayload());
    const waitedMs = Date.now() - startedAt;
    assert.ok(waitedMs < 60, `deliver() returned in ${waitedMs}ms while the receiver was still running`);
    assert.equal((await inflight).ok, true);
    assert.equal((await readJsonl(record)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deliveries land in send order so a hook that appends to an inbox never races itself", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: null,
        command: [process.execPath, script],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, HOOK_DELAY_MS: "40" },
      },
      { retryDelayMs: 5 },
    );
    const first = delivery.deliver(annotationPayload({ at: "2026-01-01T00:00:01.000Z" }));
    const second = delivery.deliver(annotationPayload({ at: "2026-01-01T00:00:02.000Z" }));
    await Promise.all([first, second]);
    const entries = await readJsonl(record);
    assert.deepEqual(
      entries.map((entry) => entry.payload.at),
      ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"],
      "the first Send reached the receiver first, even though both deliveries were in flight",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook that fails once is retried exactly once, and the retry is what lands", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  const logs = [];
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: null,
        command: [process.execPath, script],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, HOOK_FAIL_UNTIL: "2" },
      },
      {
        retryDelayMs: 5,
        logFailure: (line) => logs.push(`failure: ${line}`),
        logSuccess: (line) => logs.push(`success: ${line}`),
      },
    );
    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, true);
    assert.equal(Number(await readFile(attempts, "utf8")), 2, "at most one retry after the first failure");
    assert.equal((await readJsonl(record)).length, 1, "a delivered note is recorded once, not twice");
    assert.deepEqual(logs, ["success: feedback hook command delivered on its retry"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook that fails twice logs one honest failure, delivers nothing, and never throws at the sender", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  const logs = [];
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: null,
        command: [process.execPath, script],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts, HOOK_FAIL_UNTIL: "3" },
      },
      {
        retryDelayMs: 5,
        logFailure: (line) => logs.push(line),
        logSuccess: (line) => logs.push(line),
      },
    );
    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, false);
    assert.equal(Number(await readFile(attempts, "utf8")), 2, "no third attempt: this is not a delivery queue");
    assert.equal((await readJsonl(record)).length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /failed twice/);
    assert.match(logs[0], /the receiver refused this delivery/);
    // The honesty clause: the failure says nothing about the queue, because it did not touch it.
    assert.match(logs[0], /still queued for `lavish-axi poll`/);

    // A later send still gets its own delivery, with its own attempts: one failed delivery never
    // poisons the next one, and the receiver being back up is enough for it to land.
    const next = await delivery.deliver(annotationPayload());
    assert.equal(next.ok, true);
    assert.equal(Number(await readFile(attempts, "utf8")), 3);
    assert.equal((await readJsonl(record)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command that cannot be spawned or that hangs is a logged failure, not a stuck server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-feedback-hook-"));
  const logs = [];
  try {
    const missing = createFeedbackHookDelivery(
      { webhook: null, command: [path.join(dir, "definitely-not-installed")], extraEnv: {} },
      { retryDelayMs: 1, logFailure: (line) => logs.push(line) },
    );
    const missingResult = await missing.deliver(annotationPayload());
    assert.equal(missingResult.ok, false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /failed twice/);

    const hangingScript = path.join(dir, "hang.mjs");
    await writeFile(hangingScript, "setTimeout(() => process.exit(0), 10_000);\n");
    const hanging = createFeedbackHookDelivery(
      { webhook: null, command: [process.execPath, hangingScript], extraEnv: {} },
      { retryDelayMs: 1, timeoutMs: 60, logFailure: (line) => logs.push(line) },
    );
    const startedAt = Date.now();
    const hangingResult = await hanging.deliver(annotationPayload());
    assert.equal(hangingResult.ok, false);
    assert.match(hangingResult.results[0].detail, /no exit within 60ms/);
    assert.ok(Date.now() - startedAt < 3_000, "a hung hook is killed by its timeout, not left running");
    assert.equal(logs.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a webhook receives the same payload as a POST body, retries once, and is logged without its path", async () => {
  const requests = [];
  let refuseNext = 1;
  const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        body: JSON.parse(raw),
      });
      if (refuseNext > 0) {
        refuseNext -= 1;
        res.writeHead(503).end("receiver down");
        return;
      }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = /** @type {import("node:net").AddressInfo} */ (receiver.address()).port;
  const logs = [];
  try {
    const url = `http://127.0.0.1:${receiverPort}/inbox/firstmate-review`;
    const delivery = createFeedbackHookDelivery(
      { webhook: url, command: null, extraEnv: {} },
      {
        retryDelayMs: 5,
        userAgent: "lavish-axi/test",
        logFailure: (line) => logs.push(line),
        logSuccess: (line) => logs.push(line),
      },
    );
    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2, "one attempt, one retry, no more");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/inbox/firstmate-review");
    assert.equal(requests[0].contentType, "application/json");
    assert.deepEqual(
      requests[0].body.prompts.map((prompt) => prompt.prompt),
      ["make this column wider", "ship it"],
    );
    assert.deepEqual(requests[1].body, requests[0].body, "the retry re-sends the same batch, unchanged");
    assert.deepEqual(logs, ["feedback hook webhook delivered on its retry"]);

    // Both ends of the same channel: a healthy endpoint logs one success line.
    const healthy = createFeedbackHookDelivery(
      { webhook: url, command: null, extraEnv: {} },
      { logSuccess: (line) => logs.push(line) },
    );
    assert.equal((await healthy.deliver(annotationPayload())).ok, true);
    assert.deepEqual(logs.at(-1), "feedback hook webhook delivered");

    assert.equal(describeFeedbackWebhook(url), `http://127.0.0.1:${receiverPort}`);
    assert.equal(describeFeedbackWebhook("https://rig.example/inbox?token=secretpart"), "https://rig.example");
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("a webhook that never answers is cut off by its timeout and logged as a failure", async () => {
  const socketHolder = new Set();
  const receiver = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      // Never answers: the only way to prove the timeout is real is to keep the socket open.
      socketHolder.add(res.socket);
      res.socket.on("close", () => socketHolder.delete(res.socket));
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = /** @type {import("node:net").AddressInfo} */ (receiver.address()).port;
  const logs = [];
  try {
    const delivery = createFeedbackHookDelivery(
      { webhook: `http://127.0.0.1:${receiverPort}/inbox`, command: null, extraEnv: {} },
      { retryDelayMs: 1, timeoutMs: 80, logFailure: (line) => logs.push(line) },
    );
    const startedAt = Date.now();
    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, false);
    assert.match(result.results[0].detail, /AbortError|timeout|aborted/i);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /failed twice/);
  } finally {
    for (const socket of socketHolder) socket.destroy();
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("both channels configured deliver the same batch to each, and one broken channel never blocks the other", async () => {
  const { dir, script, record, attempts } = await createHookDir();
  const receiver = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.writeHead(500).end("nope"));
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = /** @type {import("node:net").AddressInfo} */ (receiver.address()).port;
  const logs = [];
  try {
    const delivery = createFeedbackHookDelivery(
      {
        webhook: `http://127.0.0.1:${receiverPort}/inbox`,
        command: [process.execPath, script],
        extraEnv: { HOOK_RECORD: record, HOOK_ATTEMPTS: attempts },
      },
      { retryDelayMs: 5, logFailure: (line) => logs.push(line) },
    );
    const result = await delivery.deliver(annotationPayload());
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.results.map((entry) => [entry.kind, entry.ok]),
      [
        ["webhook", false],
        ["command", true],
      ],
    );
    assert.equal((await readJsonl(record)).length, 1, "the command channel still got its note");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /webhook failed twice/);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("the failure hint text names both configuration channels an operator actually has", () => {
  assert.ok(FEEDBACK_HOOK_FLAG_HINTS.some((hint) => hint.includes("lavish-axi server --help")));
  assert.ok(FEEDBACK_HOOK_FLAG_HINTS.some((hint) => hint.includes("LAVISH_AXI_FEEDBACK_WEBHOOK")));
  assert.ok(FEEDBACK_HOOK_FLAG_HINTS.some((hint) => hint.includes("LAVISH_AXI_FEEDBACK_CMD")));
});
