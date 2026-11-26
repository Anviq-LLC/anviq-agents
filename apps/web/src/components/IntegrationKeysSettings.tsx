import { Disclosure, Label, Switch } from "@anviq/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { errorText } from "../lib/query/user-error";
import { ProviderSettingsForm } from "./models/ProviderSettingsForm";
import { SettingsGroup, SettingsRow } from "./settings/SettingsRows";

/** Each person connects apps with their own provider accounts, so these credentials are theirs alone. */
export function IntegrationKeysSettings() {
  const { t } = useLingui();
  const spaceQueries = useSpaceQueries();
  const state = useQuery(spaceQueries.integrationSetup.get.queryOptions());
  const save = useSave({
    save: (config: { provider: string; [key: string]: string }, client) =>
      client.integrationSetup.save(config),
    stale: [spaceQueries.integrationSetup.get.queryKey()],
  });
  const providers = state.data?.providers ?? [];
  const me = useQuery(spaceQueries.me.queryOptions()).data;
  const switchId = useId();
  const marketplace = useSave({
    save: (hidden: boolean, client) => client.preferences.update({ hidePluginMarketplace: hidden }),
    stale: [spaceQueries.me.key()],
  });

  return (
    <div className="space-y-6">
      {me ? (
        <SettingsGroup>
          <SettingsRow
            label={
              <Label htmlFor={switchId} className="text-body font-normal text-foreground">
                {t`Show marketplace plugins`}
              </Label>
            }
            control={
              <Switch
                id={switchId}
                checked={!(marketplace.pending ? marketplace.input : me.hidePluginMarketplace)}
                disabled={marketplace.pending}
                onCheckedChange={(shown) => marketplace.run(!shown)}
              />
            }
          />
        </SettingsGroup>
      ) : null}
      {providers.map((provider, index) => (
        <Disclosure
          key={`${provider.id}:${provider.configured}`}
          defaultOpen={index === 0}
          className="text-sm text-muted-foreground"
          summary={provider.displayName ?? provider.id}
        >
          <div className="mt-3">
            <ProviderSettingsForm
              fields={provider.fields ?? []}
              busy={save.pending}
              connectLabel={t`Save`}
              advancedSettings={null}
              onSubmit={(draft) =>
                save.run({
                  provider: provider.id,
                  ...draft.settings,
                  ...draft.credentials,
                })
              }
            />
          </div>
        </Disclosure>
      ))}
      {marketplace.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(marketplace.error)}
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(save.error)}
        </p>
      ) : null}
    </div>
  );
}
