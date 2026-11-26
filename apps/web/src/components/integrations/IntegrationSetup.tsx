import { useTimeout } from "@anviq/chat-ui/hooks";
import type { IntegrationCatalogResult } from "@anviq/contracts";
import { signInMcpServers } from "@anviq/core";
import { Button, Input } from "@anviq/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { connectMcpEndpoint } from "../../lib/integrations/mcp-connect";
import { rpc } from "../../lib/query/rpc";
import type { ErrorDetails } from "../../lib/query/user-error";
import { errorDetails } from "../../lib/query/user-error";
import { ErrorNotice } from "../ErrorNotice";

const SEARCH_DELAY_MS = 400;

/** A pasted server address: searching it would find nothing, so it is offered as the server. */
function pastedUrl(text: string): string | null {
  const value = text.trim();
  return /^https?:\/\//i.test(value) && URL.canParse(value) ? value : null;
}

/** Personal MCP connections never configure deployment-wide provider credentials. */
export function IntegrationSetup({
  onDone,
  botId,
  initialQuery,
}: {
  onDone?: () => void;
  botId?: string;
  /** Searches the public catalog for this once on open. */
  initialQuery?: string;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const remoteResults = signInMcpServers(results);
  const url = pastedUrl(query);
  const lastSearched = useRef<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorDetails(err, t`Could not connect`));
    } finally {
      setBusy(false);
    }
  }

  // Only the latest search may show its answer, and searching never locks the Connect buttons.
  const latestSearch = useRef(0);
  async function search(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === lastSearched.current) return;
    lastSearched.current = trimmed;
    const id = ++latestSearch.current;
    setError(null);
    try {
      const response = await rpc.capabilities.catalogSearch({
        query: trimmed,
        usePublicCatalog: true,
      });
      if (id !== latestSearch.current) return;
      setResults(response.results);
      setSearched(true);
    } catch (err) {
      if (id === latestSearch.current) setError(errorDetails(err, t`Could not connect`));
    }
  }

  // Ref, not state: a development remount must not send the search twice.
  const searchedInitial = useRef(false);
  useEffect(() => {
    if (searchedInitial.current || !initialQuery?.trim()) return;
    searchedInitial.current = true;
    void search(initialQuery);
  }, []);

  useTimeout(() => void search(query), query.trim() && !url ? SEARCH_DELAY_MS : null, query);

  async function connect(name: string, endpoint: string) {
    await run(async () => {
      const result = await connectMcpEndpoint({ name, endpoint, botId });
      if (result !== "cancelled") setConnected((current) => [...current, endpoint]);
    });
  }

  function row(name: string, endpoint: string) {
    return (
      <div key={endpoint} className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">{name}</span>
        <Button
          variant="outline"
          disabled={busy || connected.includes(endpoint)}
          onClick={() => void connect(name, endpoint)}
        >
          {connected.includes(endpoint) ? t`Connected` : t`Connect`}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-display font-medium text-foreground">
        <Trans>Add MCP server</Trans>
      </h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <Input
          aria-label={t`Search apps`}
          placeholder={t`Search apps or paste a server URL`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>
      {url ? row(new URL(url).hostname, url) : null}
      {url ? null : remoteResults.map((result) => row(result.name, result.endpoint))}
      {!url && searched && !remoteResults.length ? (
        <p className="text-body text-muted-foreground">
          <Trans>No remote MCP servers found</Trans>
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {onDone ? (
        <Button disabled={busy} onClick={onDone}>
          <Trans>Continue</Trans>
        </Button>
      ) : null}
    </div>
  );
}
