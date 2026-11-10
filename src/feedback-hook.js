import { spawn } from "node:child_process";

// The push lane for feedback delivery. The hook fires when the server ACCEPTS a browser send, so a
// note no longer depends on a `lavish-axi poll` listener being alive at the instant Send is pressed.
// It is strictly additional: the accepted batch stays queued for the poll exactly as before, and
// nothing here waits for, replaces, or fails that queue.
export const FEEDBACK_HOOK_RETRY_DELAY_MS = 1_000;
export const FEEDBACK_HOOK_TIMEOUT_MS = 15_000;

// The hook's own configuration is operator input (a flag on the server command or that server's
// environment). Nothing here is ever derived from a request.
const HOOK_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// How much of a hook command's stdout/stderr is kept for the server log line.
const HOOK_OUTPUT_LIMIT = 1_000;
export const FEEDBACK_HOOK_FLAG_HINTS = [
  "Run `lavish-axi server --help` for the feedback hook flags",
  "Set LAVISH_AXI_FEEDBACK_WEBHOOK or LAVISH_AXI_FEEDBACK_CMD in the environment that starts the server",
];

export class FeedbackHookConfigError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [suggestions]
   */
  constructor(message, suggestions = FEEDBACK_HOOK_FLAG_HINTS) {
    super(message);
    this.name = "FeedbackHookConfigError";
    this.suggestions = suggestions;
  }
}

/**
 * @typedef {{ webhook: string | null, command: string[] | null, extraEnv: { [key: string]: string }, retryDelayMs?: number, timeoutMs?: number }} ResolvedFeedbackHook
 */

/**
 * Resolve the hook from `lavish-axi server` flags plus the starting environment, so a detached
 * server the CLI auto-starts picks up the same configuration its parent had.
 *
 * @param {{
 *   webhookFlag?: string | null,
 *   commandFlag?: string | null,
 *   hookEnvFlags?: string[],
 *   env?: { [key: string]: string | undefined },
 * }} [options]
 * @returns {ResolvedFeedbackHook | null}
 *   null when no hook is configured, so a server without one pays nothing.
 */
export function resolveFeedbackHookConfig({
  webhookFlag = null,
  commandFlag = null,
  hookEnvFlags = [],
  env = process.env,
} = {}) {
  const webhookValue = firstConfigured(webhookFlag, env.LAVISH_AXI_FEEDBACK_WEBHOOK);
  const commandValue = firstConfigured(commandFlag, env.LAVISH_AXI_FEEDBACK_CMD);
  // A flag someone typed is a flag they meant. Validate every one of them even when no channel ends
  // up configured, so a half-configured hook reports the mistake instead of quietly doing nothing.
  const webhook = webhookValue === null ? null : normalizeFeedbackWebhookUrl(webhookValue);
  const command = commandValue === null ? null : parseFeedbackHookCommand(commandValue);
  const extraEnv = parseFeedbackHookEnv(hookEnvFlags, env);
  if (webhook === null && command === null) return null;
  return { webhook, command, extraEnv };
}

/**
 * @param {string | null | undefined} flagValue
 * @param {string | null | undefined} envValue
 * @returns {string | null}
 */
function firstConfigured(flagValue, envValue) {
  const flag = typeof flagValue === "string" ? flagValue.trim() : "";
  if (flag) return flag;
  const env = typeof envValue === "string" ? envValue.trim() : "";
  if (env) return env;
  return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeFeedbackWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new FeedbackHookConfigError(`--feedback-webhook is not a URL: ${value}`, FEEDBACK_HOOK_FLAG_HINTS);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FeedbackHookConfigError(
      `--feedback-webhook must be an http:// or https:// URL, not ${url.protocol.replace(":", "")}`,
      FEEDBACK_HOOK_FLAG_HINTS,
    );
  }
  if (!url.hostname) {
    throw new FeedbackHookConfigError("--feedback-webhook has no host to post to", FEEDBACK_HOOK_FLAG_HINTS);
  }
  return url.toString();
}

/**
 * Split `--feedback-cmd` into the program and its arguments. Words group inside single or double
 * quotes. No shell runs this string, so `$VAR` is never expanded here: pass a value to the hook with
 * `--feedback-hook-env` instead of spelling it out in the command.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function parseFeedbackHookCommand(value) {
  /** @type {string[]} */
  const words = [];
  let current = "";
  let hasWord = false;
  /** @type {string | null} */
  let quote = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasWord) {
        words.push(current);
        current = "";
        hasWord = false;
      }
      continue;
    }
    current += char;
    hasWord = true;
  }
  if (quote !== null) {
    throw new FeedbackHookConfigError(`--feedback-cmd has an unterminated ${quote} quote`, FEEDBACK_HOOK_FLAG_HINTS);
  }
  if (hasWord) words.push(current);
  if (words.length === 0 || !words[0]) {
    throw new FeedbackHookConfigError("--feedback-cmd names no program to run", FEEDBACK_HOOK_FLAG_HINTS);
  }
  return words;
}

/**
 * Build the extra environment for a `--feedback-cmd` hook. `KEY=VAL` sets a value; a bare `KEY`
 * carries this server's own value for that name, which is the form that keeps a secret out of every
 * process listing - name it here, never spell its value out.
 *
 * @param {string[]} values
 * @param {{ [key: string]: string | undefined }} env
 * @returns {{ [key: string]: string }}
 */
export function parseFeedbackHookEnv(values, env = process.env) {
  /** @type {{ [key: string]: string }} */
  const entries = {};
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      throw new FeedbackHookConfigError(
        "--feedback-hook-env was given no value. Quote it as --feedback-hook-env <KEY=VALUE>, or pass --feedback-hook-env <KEY> to carry this server's own value for that name",
        FEEDBACK_HOOK_FLAG_HINTS,
      );
    }
    const separator = value.indexOf("=");
    const name = (separator === -1 ? value : value.slice(0, separator)).trim();
    const raw = separator === -1 ? undefined : value.slice(separator + 1);
    if (!HOOK_ENV_KEY_PATTERN.test(name)) {
      throw new FeedbackHookConfigError(
        `--feedback-hook-env name ${name} is not a valid environment variable name`,
        FEEDBACK_HOOK_FLAG_HINTS,
      );
    }
    if (raw !== undefined) {
      const assigned = raw.trim();
      if (!assigned) {
        throw new FeedbackHookConfigError(
          `--feedback-hook-env ${name}= is empty. Quote the value, or pass --feedback-hook-env ${name} alone to carry this server's own ${name}`,
          FEEDBACK_HOOK_FLAG_HINTS,
        );
      }
      entries[name] = assigned;
      continue;
    }
    const inherited = env[name];
    if (typeof inherited !== "string") {
      throw new FeedbackHookConfigError(
        `--feedback-hook-env ${name} names an environment variable this server does not have set`,
        [
          `Set ${name} in the environment that starts the server, or pass --feedback-hook-env ${name}=<value>`,
          ...FEEDBACK_HOOK_FLAG_HINTS,
        ],
      );
    }
    entries[name] = inherited;
  }
  return entries;
}

/**
 * The hook payload is the same feedback object `lavish-axi poll` hands the agent for this batch -
 * `session`, `prompts`, `dom_snapshot` - plus the server's accept time. No second schema.
 *
 * @param {{ key: string, session: any, prompts: any[], at?: string }} input
 * @returns {{ session: { file: string, key: string, status: string, session_ended?: boolean, ended_by?: string }, prompts: any[], dom_snapshot: string, at: string }}
 */
export function buildFeedbackHookPayload({ key, session, prompts, at }) {
  const ended = session && session.status === "ended";
  const endedBy = typeof session?.ended_by === "string" ? session.ended_by : undefined;
  return {
    session: {
      file: String(session?.file || ""),
      key: String(key || session?.key || ""),
      // Mirrors the poll response for a delivered batch: the batch itself is the feedback, and an
      // end that rode on it (Send & End) is reported the way poll reports it.
      status: "feedback",
      ...(ended ? { session_ended: true, ...(endedBy ? { ended_by: endedBy } : {}) } : {}),
    },
    prompts: Array.isArray(prompts) ? prompts : [],
    dom_snapshot: String(session?.dom_snapshot || ""),
    at: at || (typeof session?.updated_at === "string" ? session.updated_at : new Date().toISOString()),
  };
}

/**
 * @param {string} url
 * @returns {string} the scheme + host + port only: a webhook path or query can itself be a secret.
 */
export function describeFeedbackWebhook(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "the configured webhook";
  }
}

/**
 * A serialized delivery queue: hook deliveries land in send order, so a hook that appends to a
 * review inbox never races an earlier note. `deliver` never rejects and is never awaited by the
 * send path - a slow or broken hook must not delay, block, or undo feedback delivery.
 *
 * @param {{ webhook: string | null, command: string[] | null, extraEnv?: { [key: string]: string } }} hook
 * @param {{ userAgent?: string, retryDelayMs?: number, timeoutMs?: number, logFailure?: ((line: string) => void) | null, logSuccess?: ((line: string) => void) | null }} [options]
 * @returns {{ deliver: (payload: any) => Promise<{ ok: boolean, results: any[] }> } | null}
 */
export function createFeedbackHookDelivery(
  hook,
  { userAgent = "lavish-axi", retryDelayMs, timeoutMs, logFailure = null, logSuccess = null } = {},
) {
  if (!hook || (!hook.webhook && !hook.command)) return null;
  /** @type {{ kind: string, target: string, command?: string[] }[]} */
  const channels = [];
  if (hook.webhook) channels.push({ kind: "webhook", target: hook.webhook });
  if (hook.command) channels.push({ kind: "command", target: hook.command[0], command: hook.command });
  const delayMs =
    Number.isFinite(retryDelayMs) && retryDelayMs !== null ? Math.max(0, retryDelayMs) : FEEDBACK_HOOK_RETRY_DELAY_MS;
  const hookTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs !== null ? Math.max(1, timeoutMs) : FEEDBACK_HOOK_TIMEOUT_MS;
  const extraEnv = hook.extraEnv || {};

  /** @type {Promise<any>} */
  let queue = Promise.resolve();

  async function deliverPayload(payload) {
    /** @type {{ kind: string, ok: boolean, detail: string }[]} */
    const results = [];
    for (const channel of channels) {
      const first = await attemptDelivery(channel, payload, extraEnv, hookTimeoutMs, userAgent);
      if (first.ok) {
        logSuccess?.(`feedback hook ${channel.kind} delivered`);
        results.push({ kind: channel.kind, ok: true, detail: "" });
        continue;
      }
      // One retry, after a short pause, and no more: a hook that is down stays down instead of
      // turning every send into a queue of its own.
      await delay(delayMs);
      const retry = await attemptDelivery(channel, payload, extraEnv, hookTimeoutMs, userAgent);
      results.push({ kind: channel.kind, ok: retry.ok, detail: retry.detail });
      if (retry.ok) {
        logSuccess?.(`feedback hook ${channel.kind} delivered on its retry`);
        continue;
      }
      logFailure?.(
        `feedback hook ${channel.kind} failed twice (${first.detail}; retry ${retry.detail}). The note is still queued for \`lavish-axi poll\`, which this never replaced.`,
      );
    }
    return { ok: results.every((result) => result.ok), results };
  }

  return {
    deliver(payload) {
      const run = queue.then(() => deliverPayload(payload));
      // A delivery that throws inside its own guards must not poison the next one.
      queue = run.catch(() => ({ ok: false, results: [] }));
      return run;
    },
  };
}

/**
 * @param {{ kind: string, target: string, command?: string[] }} channel
 * @param {any} payload
 * @param {{ [key: string]: string }} extraEnv
 * @param {number} timeoutMs
 * @param {string} userAgent
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function attemptDelivery(channel, payload, extraEnv, timeoutMs, userAgent) {
  try {
    if (channel.kind === "webhook") return await deliverToWebhook(channel.target, payload, timeoutMs, userAgent);
    return await deliverToCommand(channel.command, payload, extraEnv, timeoutMs);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function deliverToWebhook(url, payload, timeoutMs, userAgent) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${clip(body)}` };
  }
  return { ok: true, detail: "" };
}

function deliverToCommand(command, payload, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      });
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish({ ok: false, detail: `no exit within ${timeoutMs}ms${clip(stderr) || clip(stdout)}` });
    }, timeoutMs);
    timer.unref?.();
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    child.on("error", (error) => {
      finish({ ok: false, detail: error.message });
    });
    // An early-exiting hook gets an EPIPE instead of a hung pipe; the exit code is the diagnosis.
    /** @type {import("node:stream").Writable} */
    const stdin = child.stdin;
    stdin.on("error", () => {});
    /** @type {import("node:stream").Readable} */
    const stdoutStream = child.stdout;
    /** @type {import("node:stream").Readable} */
    const stderrStream = child.stderr;
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk) => {
      stdout = keepBounded(stdout, chunk);
    });
    stderrStream.on("data", (chunk) => {
      stderr = keepBounded(stderr, chunk);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true, detail: "" });
        return;
      }
      const reason = code === null ? `killed by ${signal || "a signal"}` : `exit ${code}`;
      finish({ ok: false, detail: `${reason}${clip(stderr) || clip(stdout)}` });
    });
    try {
      stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * A hook that spews cannot grow the server's memory or its log line: only the head of its output is
 * kept.
 *
 * @param {string} existing
 * @param {string | Buffer | any} chunk
 * @returns {string}
 */
function keepBounded(existing, chunk) {
  if (existing.length >= HOOK_OUTPUT_LIMIT) return existing;
  return existing + String(chunk);
}

/**
 * @param {string | null | undefined} value
 * @param {number} [limit]
 * @returns {string}
 */
function clip(value, limit = 200) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return `: ${text.length > limit ? `${text.slice(0, limit)}…` : text}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
