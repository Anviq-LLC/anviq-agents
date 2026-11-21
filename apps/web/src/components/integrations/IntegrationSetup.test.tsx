// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationSetup } from "./IntegrationSetup";

const api = vi.hoisted(() => ({ capabilities: { catalogSearch: vi.fn() } }));

vi.mock("../../lib/query/rpc", () => ({ rpc: api }));
const connectMcpEndpoint = vi.hoisted(() => vi.fn());

vi.mock("../../lib/integrations/mcp-connect", () => ({ connectMcpEndpoint }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.capabilities.catalogSearch.mockReset().mockResolvedValue({ enabled: true, results: [] });
  connectMcpEndpoint.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("does not search on open without a query", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup />
      </StrictMode>,
    ),
  );
  expect(host.querySelector("input")?.value).toBe("");
  expect(host.textContent).not.toContain("No remote MCP servers found");
  expect(api.capabilities.catalogSearch).not.toHaveBeenCalled();
});

it("searches the public catalog once for a query it opens with", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup initialQuery="canva" />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("No remote MCP servers found"));
  expect(host.querySelector("input")?.value).toBe("canva");
  expect(api.capabilities.catalogSearch.mock.calls).toEqual([
    [{ query: "canva", usePublicCatalog: true }],
  ]);
});

async function type(value: string) {
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("searches while typing, without a button", async () => {
  await act(async () => root.render(<IntegrationSetup />));
  await type(" canva ");
  await vi.waitFor(() =>
    expect(api.capabilities.catalogSearch.mock.calls).toEqual([
      [{ query: "canva", usePublicCatalog: true }],
    ]),
  );
  expect(host.textContent).not.toContain("Search integrations");
});

it("offers a pasted server address as the server to connect, without searching", async () => {
  connectMcpEndpoint.mockResolvedValue("connected");
  await act(async () => root.render(<IntegrationSetup botId="bot-1" />));
  await type("https://mcp.tracker.example/mcp");
  const connect = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect",
  );
  expect(host.textContent).toContain("mcp.tracker.example");
  await act(async () => connect?.click());
  expect(connectMcpEndpoint).toHaveBeenCalledWith({
    name: "mcp.tracker.example",
    endpoint: "https://mcp.tracker.example/mcp",
    botId: "bot-1",
  });
  expect(api.capabilities.catalogSearch).not.toHaveBeenCalled();
});

async function connectTracker() {
  api.capabilities.catalogSearch.mockResolvedValue({
    enabled: true,
    results: [
      {
        domain: "tracker.example",
        name: "Tracker",
        description: "",
        pageUrl: null,
        surfaces: [
          {
            slug: "tracker-mcp",
            kind: "mcp",
            source: "https://mcp.tracker.example/mcp",
            auth: { type: "oauth", headerName: null, note: null },
          },
        ],
      },
    ],
  });
  await act(async () => root.render(<IntegrationSetup botId="bot-1" initialQuery="tracker" />));
  await vi.waitFor(() => expect(host.textContent).toContain("Tracker"));
  const connect = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect" && !button.closest("details"),
  );
  await act(async () => connect?.click());
}

it("signs in to a catalog server for the bot", async () => {
  connectMcpEndpoint.mockResolvedValue("connected");
  await connectTracker();
  expect(connectMcpEndpoint).toHaveBeenCalledWith({
    name: "Tracker",
    endpoint: "https://mcp.tracker.example/mcp",
    botId: "bot-1",
  });
  expect(host.textContent).toContain("Connected");
});

it("connects a catalog server that needs no sign-in", async () => {
  connectMcpEndpoint.mockResolvedValue("authorization_not_requested");
  await connectTracker();
  expect(host.textContent).toContain("Connected");
});

it("leaves a catalog server unconnected when sign-in is cancelled", async () => {
  connectMcpEndpoint.mockResolvedValue("cancelled");
  await connectTracker();
  expect(host.textContent).not.toContain("Connected");
});

it("does not offer a catalog server that needs a key", async () => {
  api.capabilities.catalogSearch.mockResolvedValue({
    enabled: true,
    results: [
      {
        domain: "keyed.example",
        name: "Keyed",
        description: "",
        pageUrl: null,
        surfaces: [
          {
            slug: "keyed-mcp",
            kind: "mcp",
            source: "https://mcp.keyed.example/mcp",
            auth: { type: "bearer", headerName: null, note: null },
          },
        ],
      },
    ],
  });
  await act(async () => root.render(<IntegrationSetup initialQuery="keyed" />));
  await vi.waitFor(() => expect(host.textContent).toContain("No remote MCP servers found"));
});
