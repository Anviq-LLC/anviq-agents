import { Worker } from "node:worker_threads";
import { deadlineSignal, withAbort } from "@anviq/core";

const TOO_LONG = "The script took too long and was stopped.";
// The script stops itself at its limit; the parent ends the thread only if it has not.
const TERMINATE_GRACE_MS = 1_000;

export const SANDBOX_LIMITS = {
  timeoutMs: 15_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxCalls: 50,
  maxCallResultBytes: 1_000_000,
  maxResultBytes: 50_000,
  maxLogBytes: 10_000,
};

/** Runs one tool for the script. `tool` is "Source:name"; a throw reaches the script as an error. */
export type SandboxCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[]; calls: number }
  | { ok: false; error: string; logs: string[]; calls: number };

type WorkerMessage =
  | { type: "log"; line: string }
  | { type: "call"; id: number; tool: string; argsJson: string }
  | { type: "done"; ok: boolean; text: string };

// A development run loads the TypeScript file; the built server has it beside its entry.
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./code-sandbox.worker.ts" : "./code-sandbox.worker.js",
  import.meta.url,
);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a script in a QuickJS sandbox on its own thread. The script has no network, files or
 * environment: its only way out is `call`. Memory, time, tool calls and output are capped, and a
 * script that will not stop is ended with its thread, so nothing it does can hold up this process.
 * Tool calls start the moment the script makes them, so `Promise.all` runs them in parallel.
 */
export async function runInSandbox(
  code: string,
  call: SandboxCall,
  options: { signal?: AbortSignal; limits?: Partial<typeof SANDBOX_LIMITS> } = {},
): Promise<SandboxResult> {
  const limits = { ...SANDBOX_LIMITS, ...options.limits };
  const signal = deadlineSignal(limits.timeoutMs + TERMINATE_GRACE_MS, options.signal);
  const worker = new Worker(WORKER_URL, {
    workerData: { code, limits },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
  });
  const logs: string[] = [];
  let calls = 0;
  let open = true;
  const answer = (id: number, reply: { json?: string; error?: string }) => {
    if (open) worker.postMessage({ id, ...reply });
  };

  const finished = new Promise<SandboxResult>((resolve) => {
    const stop = (error: string) => resolve({ ok: false, error, logs, calls });
    worker.on("error", (error) => stop(messageOf(error)));
    worker.on("exit", () => stop("The script stopped unexpectedly."));
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "log") {
        logs.push(message.line);
        return;
      }
      if (message.type === "done") {
        if (!message.ok) return stop(message.text);
        if (message.text.length > limits.maxResultBytes) {
          return stop(
            `The result is ${message.text.length} bytes and only ${limits.maxResultBytes} fit. Return less: filter or summarize inside the script.`,
          );
        }
        return resolve({ ok: true, value: JSON.parse(message.text), logs, calls });
      }
      void (async () => {
        const { id, tool } = message;
        if (calls >= limits.maxCalls) {
          return answer(id, {
            error: `Too many tool calls: a script may make ${limits.maxCalls}.`,
          });
        }
        calls += 1;
        try {
          const args = JSON.parse(message.argsJson) as unknown;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            return answer(id, { error: "Tool arguments must be an object." });
          }
          const json = JSON.stringify(await call(tool, args as Record<string, unknown>)) ?? "null";
          if (json.length > limits.maxCallResultBytes) {
            return answer(id, {
              error: `${tool} returned too much data for a script (${json.length} bytes).`,
            });
          }
          answer(id, { json });
        } catch (error) {
          answer(id, { error: messageOf(error) });
        }
      })();
    });
  });

  try {
    return await withAbort(finished, signal, TOO_LONG);
  } catch {
    return { ok: false, error: TOO_LONG, logs, calls };
  } finally {
    open = false;
    await worker.terminate();
  }
}
