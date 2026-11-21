import type { ConnectorTool } from "@anviq/adapter-kit";

export const RUN_CODE = "run_code";

export const MAX_SCRIPT_LENGTH = 20_000;

export const codeTools: ConnectorTool[] = [
  {
    name: RUN_CODE,
    description:
      'Run a JavaScript script over your connected apps and return only what you need. Use it for many reads or large results: fetch, filter and combine in the script, then return a small value. Call tools as `await tools["Source"].tool_name({ ...args })`, with names from catalog search and parameters from loading the tool. Promise.all runs reads in parallel. Read-only tools only: to change something, call that tool directly so the user can approve it. 15 seconds and 50 calls at most; no network or files.',
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SCRIPT_LENGTH,
          description: "Body of an async function; return a JSON value.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    readOnly: true,
  },
];
