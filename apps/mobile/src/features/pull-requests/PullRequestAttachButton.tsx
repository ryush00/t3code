import type { MenuAction } from "@react-native-menu/menu";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";

export function PullRequestAttachButton(props: {
  readonly disabled?: boolean;
  readonly uploading: boolean;
  readonly uploadingCount?: number;
  readonly variant?: "row" | "icon";
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const gt = useGT();
  const { scale } = useAndroidControlSizing();
  const isDisabled = Boolean(props.disabled);
  const label = props.uploading
    ? props.uploadingCount && props.uploadingCount > 1
      ? gt("Uploading {count} files…", { count: props.uploadingCount })
      : gt("Uploading file…")
    : gt("Attach file");
  const actions: MenuAction[] = [
    { id: "photos", title: gt("Photo Library"), image: "photo" },
    { id: "files", title: gt("Choose Files"), image: "folder" },
  ];

  const trigger =
    props.variant === "icon" ? (
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        disabled={isDisabled}
        className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      >
        {props.uploading ? (
          <AppActivityIndicator size="small" />
        ) : (
          <SymbolView
            name="paperclip"
            size={Math.round(18 * scale)}
            weight="regular"
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        )}
      </Pressable>
    ) : (
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        disabled={isDisabled}
        className="self-start rounded-full bg-grouped-card px-3 py-2 active:opacity-70 disabled:opacity-50"
      >
        <View className="flex-row items-center gap-1.5">
          {props.uploading ? (
            <AppActivityIndicator size="small" />
          ) : (
            <SymbolView
              name="paperclip"
              size={Math.round(14 * scale)}
              weight="regular"
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          )}
          <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
        </View>
      </Pressable>
    );

  if (isDisabled) {
    return trigger;
  }

  return (
    <Menu
      accessible
      accessibilityLabel={label}
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {trigger}
    </Menu>
  );
}
