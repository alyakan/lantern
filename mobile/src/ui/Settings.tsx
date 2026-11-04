import { Children, Fragment, useReducer, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { HStack, Host, Image, Menu, Button as MenuButton, Picker, Section as MenuSection, Spacer, Text as SwiftText } from "@expo/ui/swift-ui";
import { accessibilityLabel, disabled as off, font, foregroundStyle, labelsHidden, lineLimit, padding, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { Txt } from "./components";
import { PressScale } from "./motion";
import { Dots } from "./skeleton";
import { radius, space, useColors } from "./theme";

/**
 * The settings sheets' one look, as iOS's own Settings: a small grey label over a card of rows, each row a coloured square with
 * a symbol in it, its name, and its value or control at the right; a hairline between rows that starts after the square.
 * Choices of two to four are a segmented control, changed in place; longer lists are a native menu over the row (a list of
 * rows on Android). Nothing expands, so a sheet sized to what is in it never jumps.
 */

/** How tall a row is, and how wide its square: the hairline between rows starts past the square. */
const ROW = 46;
const TILE = 28;
const PAD = 12;

/** A row's coloured square, with an SF Symbol in it on iOS (a letter or sign elsewhere). Hidden from VoiceOver: the row's name says it. */
export function Tile({ symbol, glyph, tint, size = TILE }: { symbol: SFSymbol; glyph: string; tint: string; size?: number }) {
  const icon = Math.round(size * 0.54);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size * 0.29, backgroundColor: tint, alignItems: "center", justifyContent: "center" }}>
      {Platform.OS === "ios" ? (
        <Host style={{ width: icon + 4, height: icon + 4 }} alignment="center">
          <Image systemName={symbol} size={icon} color="#ffffff" />
        </Host>
      ) : (
        <Txt variant="small" tone="white" style={{ fontWeight: "700" }}>
          {glyph}
        </Txt>
      )}
    </View>
  );
}

/** A label over a card of rows, with a line under it when there is something to say. */
export function SettingsSection({ label, footer, children }: { label?: string; footer?: string | null; children: ReactNode }) {
  const colors = useColors();
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      {!!label && (
        <Txt variant="tiny" tone="ink3" accessibilityRole="header" style={{ fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginLeft: 6, marginTop: 10 }}>
          {label}
        </Txt>
      )}
      <View style={{ backgroundColor: colors.wash, borderRadius: radius.inner, overflow: "hidden" }}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <View style={{ height: 1, marginLeft: PAD + TILE + 11, backgroundColor: colors.rule }} />}
            {row}
          </Fragment>
        ))}
      </View>
      {!!footer && (
        <Txt variant="tiny" tone="ink3" style={{ marginHorizontal: 6 }}>
          {footer}
        </Txt>
      )}
    </View>
  );
}

export interface Look {
  symbol: SFSymbol;
  glyph: string;
  tint: string;
}

/**
 * A row: its square, its name (and a line under it), and at the right its value with a chevron (a row that opens something),
 * or what `right` gives (a switch). Pressable when `onPress` is given.
 */
export function SettingsRow({ look, title, detail, value, right, onPress, chevron = !!onPress, tone = "ink", accessibilityHint }: { look?: Look; title: string; detail?: string | null; value?: string | null; right?: ReactNode; onPress?: () => void; chevron?: boolean; tone?: "ink" | "stop"; accessibilityHint?: string }) {
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 11, minHeight: ROW, paddingHorizontal: PAD, paddingVertical: 8 }}>
      {look && <Tile {...look} />}
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body" tone={tone} style={tone === "stop" ? { fontWeight: "600" } : undefined}>
          {title}
        </Txt>
        {!!detail && (
          <Txt variant="tiny" tone="ink3">
            {detail}
          </Txt>
        )}
      </View>
      {!!value && (
        <Txt variant="body" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, maxWidth: "55%" }}>
          {value}
        </Txt>
      )}
      {right}
      {chevron && (
        <Txt variant="body" tone="ink3" accessibilityElementsHidden>
          ›
        </Txt>
      )}
    </View>
  );
  if (!onPress) return body;
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={value ? `${title}, ${value}` : title} accessibilityHint={accessibilityHint} onPress={onPress} haptic="select" scaleTo={0.99}>
      {body}
    </PressScale>
  );
}

export interface Choice {
  value: string;
  label: string;
  /** What it does, said under the row while it is the one chosen (and to VoiceOver). */
  hint?: string;
  /** Why it can't be chosen now: the choice is shown, but off. */
  off?: string | null;
}

/**
 * A setting of two to four choices, changed in place: its row, with the choices as segments under the name. On iOS they are
 * iOS's own segmented control (a Liquid Glass pill on iOS 26); elsewhere, drawn segments. While it is switching, a few dots say
 * so. Under it: why a choice is off, or what the chosen one does.
 *
 * iOS's control can't turn off one segment: a choice that is off is dimmed, and picking it springs back to the one chosen.
 */
export function Segmented({ look, title, choices, selected, onPick, busy = false, quiet }: { look: Look; title: string; choices: Choice[]; selected: string; onPick: (value: string) => void; busy?: boolean; /** A reason the sheet already says at its top (the chat is busy): not said again here. */ quiet?: string | null }) {
  const colors = useColors();
  const chosen = choices.find((c) => c.value === selected);
  const why = choices.find((c) => c.off && c.off !== quiet)?.off ?? null;
  const under = why ?? chosen?.hint ?? null;
  // Remounting iOS's control puts it back on the one chosen, after a pick that didn't take.
  const [resets, reset] = useReducer((n: number) => n + 1, 0);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={title} style={{ paddingHorizontal: PAD, paddingVertical: 10, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
        <Tile {...look} />
        <Txt variant="body" style={{ flex: 1 }}>
          {title}
        </Txt>
        {busy && <Dots />}
      </View>
      {Platform.OS === "ios" ? (
        <Host key={resets} style={{ marginLeft: TILE + 11, height: 34 }} matchContents={{ vertical: false, horizontal: false }}>
          <Picker
            selection={selected}
            onSelectionChange={(v: string) => {
              const c = choices.find((x) => x.value === v);
              if (!c || c.off || busy || v === selected) return reset();
              onPick(v);
            }}
            modifiers={[pickerStyle("segmented"), labelsHidden(), accessibilityLabel(title), ...(busy ? [off(true)] : [])]}
          >
            {choices.map((c) => (
              <SwiftText key={c.value} modifiers={[tag(c.value), ...(c.off ? [foregroundStyle(colors.ink3), off(true)] : [])]}>
                {c.label}
              </SwiftText>
            ))}
          </Picker>
        </Host>
      ) : (
      <View style={{ flexDirection: "row", marginLeft: TILE + 11, padding: 2, borderRadius: 10, backgroundColor: colors.wash }}>
        {choices.map((c) => {
          const on = c.value === selected;
          const disabled = !!c.off || busy;
          return (
            <PressScale
              key={c.value}
              accessibilityRole="radio"
              accessibilityLabel={c.label}
              accessibilityHint={c.off ?? c.hint}
              accessibilityState={{ selected: on, checked: on, disabled }}
              disabled={disabled}
              opacity={c.off ? 0.45 : 1}
              haptic="select"
              scaleTo={0.97}
              onPress={() => !on && onPick(c.value)}
              // Raised, as iOS draws the chosen segment: white by day, a lighter grey by night.
              style={{ flex: 1, minHeight: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, backgroundColor: on ? (colors.isDark ? "#ffffff2e" : colors.card) : "transparent", shadowColor: "#000", shadowOpacity: on ? 0.12 : 0, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } }}
            >
              <Txt variant="small" tone={on ? "ink" : "ink2"} numberOfLines={1} style={{ fontWeight: on ? "700" : "600" }}>
                {c.label}
              </Txt>
            </PressScale>
          );
        })}
      </View>
      )}
      {!!under && (
        <Txt variant="tiny" tone={why ? "cobalt" : "ink3"} style={{ marginLeft: TILE + 11 }}>
          {under}
        </Txt>
      )}
    </View>
  );
}

/**
 * A setting picked from a list: its row, with the value at the right, and the list as iOS's own menu over the row (a press
 * anywhere on the row opens it, with a tick by the one chosen). Choices past `shown` go in a menu of their own at the end
 * ("Older models"). Android has no such menu: the row opens the list under it.
 */
export function MenuRow({ look, title, value, detail, choices, selected, onPick, shown, moreLabel = "More", disabled = false }: { look: Look; title: string; value: string; detail?: string | null; choices: Choice[]; selected: string; onPick: (value: string) => void; shown?: number; moreLabel?: string; disabled?: boolean }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const first = shown === undefined ? choices : choices.filter((c, i) => i < shown || c.value === selected);
  const rest = shown === undefined ? [] : choices.filter((c, i) => i >= shown && c.value !== selected);
  const item = (c: Choice) => <MenuButton key={c.value} label={c.label} systemImage={c.value === selected ? "checkmark" : undefined} onPress={() => c.value !== selected && onPick(c.value)} modifiers={c.off || disabled ? [off(true)] : undefined} />;
  if (Platform.OS === "ios") {
    return (
      <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 11, minHeight: ROW, paddingLeft: PAD }}>
        <Tile {...look} />
        <Host style={{ flex: 1, height: ROW }} alignment="leading">
          <Menu
            modifiers={[accessibilityLabel(`${title}, ${value}`), ...(disabled ? [off(true)] : [])]}
            label={
              <HStack spacing={8} modifiers={[padding({ trailing: PAD })]}>
                <SwiftText modifiers={[font({ size: 15 }), foregroundStyle(colors.ink)]}>{title}</SwiftText>
                <Spacer />
                <SwiftText modifiers={[font({ size: 15 }), foregroundStyle(colors.ink3), lineLimit(1)]}>{value}</SwiftText>
                <Image systemName="chevron.up.chevron.down" size={11} color={colors.ink3} />
              </HStack>
            }
          >
            {first.map(item)}
            {rest.length > 0 && <MenuSection>{[<Menu key="more" label={moreLabel}>{rest.map(item)}</Menu>]}</MenuSection>}
          </Menu>
        </Host>
      </View>
      {!!detail && (
        <Txt variant="tiny" tone="ink3" style={{ paddingLeft: PAD + TILE + 11, paddingRight: PAD, paddingBottom: 9, marginTop: -6 }}>
          {detail}
        </Txt>
      )}
      </View>
    );
  }
  return (
    <View>
      <PressScale accessibilityRole="button" accessibilityLabel={`${title}, ${value}`} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => setOpen(!open)} haptic="select" scaleTo={0.99}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 11, minHeight: ROW, paddingHorizontal: PAD }}>
          <Tile {...look} />
          <Txt variant="body" style={{ flex: 1 }}>
            {title}
          </Txt>
          <Txt variant="body" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, maxWidth: "55%" }}>
            {value}
          </Txt>
        </View>
      </PressScale>
      {open &&
        [...first, ...rest].map((c) => (
          <PressScale key={c.value} accessibilityRole="radio" accessibilityLabel={c.label} accessibilityState={{ checked: c.value === selected, disabled: !!c.off }} disabled={!!c.off} opacity={c.off ? 0.45 : 1} onPress={() => { setOpen(false); if (c.value !== selected) onPick(c.value); }} style={{ paddingVertical: 10, paddingLeft: PAD + TILE + 11, paddingRight: PAD, flexDirection: "row" }}>
            <Txt variant="body" style={{ flex: 1 }}>
              {c.label}
            </Txt>
            {c.value === selected && <Txt variant="body" tone="cobalt">✓</Txt>}
          </PressScale>
        ))}
      {!!detail && (
        <Txt variant="tiny" tone="ink3" style={{ paddingLeft: PAD + TILE + 11, paddingBottom: 8 }}>
          {detail}
        </Txt>
      )}
    </View>
  );
}

/** A row held for a setting that is still being asked of the Mac, so the sheet doesn't grow when it comes. */
export function PendingRow({ look, title }: { look: Look; title: string }) {
  return (
    <View accessibilityLabel={`${title}, loading`} accessible style={{ flexDirection: "row", alignItems: "center", gap: 11, minHeight: ROW, paddingHorizontal: PAD }}>
      <Tile {...look} />
      <Txt variant="body" tone="ink3" style={{ flex: 1 }}>
        {title}
      </Txt>
      <Dots />
    </View>
  );
}

/** What can't be undone, in red, on its own card at the bottom, with a line under it. */
export function DangerButton({ label, onPress, footer }: { label: string; onPress: () => void; footer?: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 6, marginTop: 14 }}>
      <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} haptic="select" scaleTo={0.98} style={{ minHeight: ROW, borderRadius: radius.inner, backgroundColor: colors.wash, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="body" tone="stop" style={{ fontWeight: "600" }}>
          {label}
        </Txt>
      </PressScale>
      {!!footer && (
        <Txt variant="tiny" tone="ink3" style={{ marginHorizontal: 6 }}>
          {footer}
        </Txt>
      )}
    </View>
  );
}

/** A sheet's title and its round Done button (✕), which VoiceOver hears as Done. */
export function SheetHeader({ title, onDone }: { title?: string; onDone: () => void }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 4, gap: 8 }}>
      <Txt variant="body" accessibilityRole="header" style={{ flex: 1, fontWeight: "700" }}>
        {title ?? ""}
      </Txt>
      <PressScale accessibilityRole="button" accessibilityLabel="Done" onPress={onDone} hitSlop={10} haptic="select" scaleTo={0.9} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.wash, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="small" tone="ink2" style={{ fontWeight: "700" }}>
          ✕
        </Txt>
      </PressScale>
    </View>
  );
}

/** The usual squares: each setting's colour and symbol, so the same setting looks the same in every sheet. */
export const LOOKS = {
  permissions: { symbol: "hand.raised.fill", glyph: "✋", tint: "#1f9d55" },
  workflow: { symbol: "list.bullet.rectangle", glyph: "≡", tint: "#2f5bff" },
  provider: { symbol: "sparkles", glyph: "✳", tint: "#d4693f" },
  model: { symbol: "cpu", glyph: "◆", tint: "#7c4fd0" },
  effort: { symbol: "gauge.with.dots.needle.67percent", glyph: "↯", tint: "#1f8a8a" },
  preset: { symbol: "slider.horizontal.3", glyph: "⚙", tint: "#5b6472" },
  show: { symbol: "rectangle.split.3x1", glyph: "▤", tint: "#c8501f" },
  todos: { symbol: "checklist", glyph: "✓", tint: "#2f5bff" },
  storage: { symbol: "internaldrive", glyph: "▦", tint: "#5b6472" },
  pair: { symbol: "qrcode", glyph: "⧉", tint: "#1f8a8a" },
  lock: { symbol: "faceid", glyph: "☺", tint: "#1f9d55" },
  voice: { symbol: "waveform", glyph: "♪", tint: "#7c4fd0" },
  whatsNew: { symbol: "sparkles", glyph: "✦", tint: "#d4693f" },
  support: { symbol: "heart.fill", glyph: "♥", tint: "#d14d7a" },
} satisfies Record<string, Look>;
