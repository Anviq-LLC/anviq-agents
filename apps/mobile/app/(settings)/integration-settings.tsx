import { useLingui } from "@lingui/react/macro";
import { Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  SettingsGroup,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { useThemedStyles } from "../../lib/native/native";
import { accountRpcQuery, queryClient, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { createSettingsPageStyles } from "../../lib/settings/settings-page-styles";

export default function IntegrationSettings() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const meRead = accountRpcQuery("me");
  const me = useScreenQuery(meRead).data;
  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (hidden: boolean, send) => {
      // The answer is the account as saved, so the switch keeps it if the read after it fails.
      queryClient.setQueryData(
        meRead.queryKey,
        await send("preferences/update", { hidePluginMarketplace: hidden }),
      );
    },
    stale: [meRead.queryKey],
    onFailed: (cause) => Alert.alert(t`Integration settings`, errorText(cause, t`Could not save`)),
  });
  // The switch shows the change being saved until the read after it is back.
  const hidden = change.pending ? change.input : me?.hidePluginMarketplace;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {me ? (
          <SettingsGroup>
            <SettingsSwitch
              label={t`Show marketplace plugins`}
              value={!hidden}
              disabled={change.pending}
              onChange={(shown) => change.run(!shown)}
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
