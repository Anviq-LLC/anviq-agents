import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_NAME_MAX_LENGTH } from "@anviq/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import type { MobileBot, MobileGroup } from "../lib/api";
import { rpc } from "../lib/api";
import { notifyArchivedChatsChanged } from "../lib/archived-chats";
import { confirmDeleteGroup } from "../lib/bot-lifecycle";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function GroupSettingsScreen() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [people, setPeople] = useState<Array<{ userId: string; name: string }>>([]);

  useEffect(() => {
    if (!groupId) return;
    void Promise.all([
      rpc("groups/list").then((groups) => groups.find((row) => row.id === groupId) ?? null),
      rpc("bots/list"),
      rpc("spaces/people").catch(() => []),
    ])
      .then(([nextGroup, nextBots, nextPeople]) => {
        if (!nextGroup) throw new Error(t("Group not found"));
        setGroup(nextGroup);
        setName(nextGroup.name);
        setSelected(nextGroup.members.map((member) => member.botId));
        setBots(nextBots.filter((bot) => !bot.archivedAt));
        setPeople(nextPeople);
      })
      .catch((err) => setError(errorText(err, t("Could not load group"))));
  }, [groupId]);

  const guests = (group?.participants ?? []).filter((person) => !person.host);
  const chosen = new Set(guests.map((person) => person.userId));

  async function share(userIds: string[]) {
    if (!groupId || pending) return;
    setPending(true);
    setError(null);
    try {
      const updated = await rpc("groups/setParticipants", { groupId, userIds });
      setGroup(updated);
    } catch (err) {
      setError(errorText(err, t("Could not save group")));
    } finally {
      setPending(false);
    }
  }

  async function setMyBots(botIds: string[]) {
    if (!groupId || pending) return;
    setPending(true);
    setError(null);
    try {
      setGroup(await rpc("groups/setMyBots", { groupId, botIds }));
    } catch (err) {
      setError(errorText(err, t("Could not save group")));
    } finally {
      setPending(false);
    }
  }

  async function leave() {
    if (!groupId || pending) return;
    setPending(true);
    try {
      await rpc("groups/leave", { groupId });
      notifyArchivedChatsChanged();
      router.replace("/");
    } catch (err) {
      setError(errorText(err, t("Could not save group")));
      setPending(false);
    }
  }

  async function save() {
    if (!groupId || !group || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: { groupId: string; name?: string; botIds?: string[] } = { groupId };
      if (name.trim() !== group.name) input.name = name.trim();
      const memberIds = group.members.map((member) => member.botId).join(",");
      if (selected.join(",") !== memberIds) input.botIds = selected;
      if (input.name || input.botIds) await rpc("groups/update", input);
      router.back();
    } catch (err) {
      setError(errorText(err, t("Could not save group")));
    } finally {
      setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group) return;
    confirmDeleteGroup({ id: groupId, name: group.name }, () => {
      notifyArchivedChatsChanged();
      router.replace("/");
    });
  }

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Group settings"))} />
      <ScrollView
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {group?.canManage === false ? (
          <>
            <SettingsGroup label={t("People")}>
              {(group.participants ?? []).map((person) => (
                <SettingsRow key={person.userId} title={person.name} />
              ))}
            </SettingsGroup>
            {bots.length > 0 ? (
              <SettingsGroup label={t("Your bots")}>
                {bots.map((bot) => {
                  const inChat = group.members.some((member) => member.botId === bot.id);
                  return (
                    <SettingsRow
                      key={bot.id}
                      title={bot.name}
                      trailing={
                        <NativeSwitch
                          accessibilityLabel={t("Add {name} to the chat", { name: bot.name })}
                          value={inChat}
                          disabled={pending}
                          onValueChange={(next) => {
                            const mine = new Set(
                              group.members
                                .filter((member) => bots.some((own) => own.id === member.botId))
                                .map((member) => member.botId),
                            );
                            if (next) mine.add(bot.id);
                            else mine.delete(bot.id);
                            void setMyBots([...mine]);
                          }}
                        />
                      }
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}
            {error ? (
              <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
            ) : null}
            <NativeActionButton
              label={t("Leave chat")}
              onPress={() => void leave()}
              prominence="destructive"
              disabled={pending}
              style={{ marginTop: 24 }}
            />
          </>
        ) : null}
        {group?.canManage === false ? null : (
          <>
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={GROUP_NAME_MAX_LENGTH}
              placeholder={t("Group name")}
              placeholderTextColor={tokens.mutedForeground}
              returnKeyType="done"
              style={{
                marginTop: 8,
                backgroundColor: native.fill,
                borderRadius: 11,
                padding: 14,
                color: tokens.foreground,
                fontSize: 16,
              }}
            />
            {group ? (
              <BotMemberPicker
                key={group.id}
                bots={bots}
                selected={selected}
                onChange={setSelected}
                onOpenBot={(bot) =>
                  router.push({
                    pathname: "/bot-profile",
                    params: { botId: bot.id, name: bot.name },
                  })
                }
                disabled={pending}
              />
            ) : null}
            {people.length > 0 ? (
              <SettingsGroup label={t("People")}>
                {people.map((person) => (
                  <SettingsRow
                    key={person.userId}
                    title={person.name}
                    trailing={
                      <NativeSwitch
                        accessibilityLabel={t("Add {name} to the chat", { name: person.name })}
                        value={chosen.has(person.userId)}
                        disabled={pending}
                        onValueChange={(next) => {
                          const ids = new Set(chosen);
                          if (next) ids.add(person.userId);
                          else ids.delete(person.userId);
                          void share([...ids]);
                        }}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
            ) : null}
            {error ? (
              <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
            ) : null}
            <NativeActionButton
              disabled={
                !name.trim() ||
                selected.length < GROUP_MEMBER_MIN ||
                selected.length > GROUP_MEMBER_MAX ||
                pending
              }
              label={pending ? t("Saving…") : t("Save")}
              onPress={() => void save()}
              style={{ marginTop: 24 }}
            />
            {groupId ? (
              <NativeActionButton
                label={t("Pages")}
                onPress={() => router.push({ pathname: "/pages", params: { groupId } })}
                style={{ marginTop: 16 }}
              />
            ) : null}
            <NativeActionButton
              label={t("Delete group")}
              onPress={remove}
              prominence="destructive"
              style={{ marginTop: 16 }}
            />
          </>
        )}
      </ScrollView>
    </>
  );
}
