// Runs one script in QuickJS inside a worker thread, so the parent can stop it at any moment.
// Plain syntax only: Node runs this file directly in development, and it is its own build entry.
import { parentPort, workerData } from "node:worker_threads";
import type { QuickJSDeferredPromise } from "quickjs-emscripten";
import { getQuickJS } from "quickjs-emscripten";

type Limits = {
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxLogBytes: number;
};

const TOO_LONG = "The script took too long and was stopped.";

// The script sees `tools["Source"].name(args)` and `console.log`, nothing else of the host. The
// host functions live in the setup closure, out of the user code's reach.
function scriptSource(code: string): string {
  return `const __run = async () => {
${code}
};
(async () => {
  const finish = (() => {
    const call = globalThis.__call;
    const log = globalThis.__log;
    const done = globalThis.__finish;
    delete globalThis.__call;
    delete globalThis.__log;
    delete globalThis.__finish;
    const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));
    globalThis.console = { log: (...parts) => log(parts.map(text).join(" ")) };
    const named = (key) => typeof key === "string" && key !== "then";
    globalThis.tools = new Proxy({}, {
      get: (_, source) => !named(source) ? undefined : new Proxy({}, {
        get: (_, name) => !named(name) ? undefined : async (args) => {
          try {
            return JSON.parse(await call(source + ":" + name, JSON.stringify(args ?? {})));
          } catch (error) {
            throw new Error(String(error));
          }
        },
      }),
    });
    return done;
  })();
  try {
    const value = await __run();
    finish(true, value === undefined ? "null" : JSON.stringify(value));
  } catch (error) {
    finish(false, String((error && error.message) || error));
  }
})();`;
}

function messageOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const source = cause && typeof cause === "object" ? cause : error;
  const message = (source as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(source);
}

const port = parentPort;
if (!port) throw new Error("This file runs in a worker thread.");
const { code, limits } = workerData as { code: string; limits: Limits };

const answers = new Map<number, { json?: string; error?: string }>();
const waiting = new Map<number, () => void>();
port.on("message", (message: { id: number; json?: string; error?: string }) => {
  answers.set(message.id, message);
  waiting.get(message.id)?.();
});

const runtime = (await getQuickJS()).newRuntime();
runtime.setMemoryLimit(limits.memoryBytes);
runtime.setMaxStackSize(limits.stackBytes);
const deadline = Date.now() + limits.timeoutMs;
runtime.setInterruptHandler(() => Date.now() > deadline);
const vm = runtime.newContext();
const pending: QuickJSDeferredPromise[] = [];
let logBytes = 0;
let nextId = 0;
let closed = false;
let finish: (outcome: { ok: boolean; text: string }) => void = () => {};
const finished = new Promise<{ ok: boolean; text: string }>((resolve) => {
  finish = resolve;
});

function expose(name: string, implementation: Parameters<typeof vm.newFunction>[1]) {
  const handle = vm.newFunction(name, implementation);
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}

try {
  expose("__log", (line) => {
    const text = vm.getString(line);
    if (logBytes + text.length > limits.maxLogBytes) return;
    logBytes += text.length;
    port.postMessage({ type: "log", line: text });
  });
  expose("__finish", (ok, text) => {
    finish({ ok: vm.dump(ok) === true, text: vm.getString(text) });
  });
  expose("__call", (toolHandle, argsHandle) => {
    const id = nextId++;
    const deferred = vm.newPromise();
    pending.push(deferred);
    // The script resumes once the parent answers.
    void deferred.settled.then(() => {
      if (!closed) runtime.executePendingJobs();
    });
    const settle = () => {
      waiting.delete(id);
      const answer = answers.get(id);
      answers.delete(id);
      if (closed || !answer) return;
      if (answer.error !== undefined) deferred.reject(vm.newString(answer.error));
      else deferred.resolve(vm.newString(answer.json ?? "null"));
    };
    waiting.set(id, settle);
    port.postMessage({
      type: "call",
      id,
      tool: vm.getString(toolHandle),
      argsJson: vm.getString(argsHandle),
    });
    return deferred.handle;
  });

  vm.unwrapResult(vm.evalCode(scriptSource(code), "script.js")).dispose();
  runtime.executePendingJobs();
  const outcome = await finished;
  const stopped = !outcome.ok && Date.now() > deadline;
  port.postMessage({ type: "done", ok: outcome.ok, text: stopped ? TOO_LONG : outcome.text });
} catch (error) {
  port.postMessage({
    type: "done",
    ok: false,
    text: Date.now() > deadline ? TOO_LONG : messageOf(error),
  });
} finally {
  closed = true;
  for (const deferred of pending) if (deferred.alive) deferred.dispose();
  vm.dispose();
  runtime.dispose();
}
