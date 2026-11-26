import { Label, Switch } from "@anviq/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { errorText } from "../lib/query/user-error";
import { SettingsGroup, SettingsRow } from "./settings/SettingsRows";

/** Whether Connect apps lists marketplace plugins beyond the apps a connected provider offers. */
export function MarketplacePluginsSwitch() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const me = useQuery(queries.me.queryOptions()).data;
  const id = useId();
  const save = useSave({
    save: (hidden: boolean, client) => client.preferences.update({ hidePluginMarketplace: hidden }),
    stale: [queries.me.key()],
  });
  if (!me) return null;

  return (
    <div className="space-y-2">
      <SettingsGroup>
        <SettingsRow
          label={
            <Label htmlFor={id} className="text-body font-normal text-foreground">
              {t`Show marketplace plugins`}
            </Label>
          }
          control={
            <Switch
              id={id}
              checked={!(save.pending ? save.input : me.hidePluginMarketplace)}
              disabled={save.pending}
              onCheckedChange={(shown) => save.run(!shown)}
            />
          }
        />
      </SettingsGroup>
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(save.error)}
        </p>
      ) : null}
    </div>
  );
}
