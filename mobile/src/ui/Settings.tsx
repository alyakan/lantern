import { Children, Fragment, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { HStack, Host, Image, Menu, Button as MenuButton, Section as MenuSection, Slider, Spacer, Text as SwiftText } from "@expo/ui/swift-ui";
import { accessibilityLabel, disabled as off, font, foregroundStyle, lineLimit, padding } from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { Txt } from "./components";
import { PressScale } from "./motion";
import { Dots } from "./skeleton";
import { radius, space, useColors } from "./theme";
import { SheetBar } from "./Sheet";

/**
 * The settings sheets' one look, as iOS's own Settings: a small grey label over a card of rows, each row a coloured square with
 * a symbol in it, its name, and its value or control at the right; a hairline between rows that starts after the square.
 * A choice is a native menu over its row (a list of rows on Android), a scale a slider. Nothing expands, so a sheet sized to
 * what is in it never jumps.
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
      {/* Beside a name with a line under it, the square stays by the name, at the top. */}
      {look && <View style={detail ? { alignSelf: "flex-start" } : undefined}><Tile {...look} /></View>}
      <View style={{ flex: 1, gap: 1, paddingTop: detail ? 3 : 0 }}>
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

/** What is said under a choice's row: why one is off (unless the sheet says it already, `quiet`), or what the chosen one does. */
export function noteOf(choices: Choice[], selected: string, quiet?: string | null): string | null {
  return choices.find((c) => c.off && c.off !== quiet)?.off ?? choices.find((c) => c.value === selected)?.hint ?? null;
}

/**
 * A setting on a scale of a few steps (effort): its row, with the step at the right, and iOS's own slider under it, which
 * snaps to the steps. The step is sent once the thumb is let go (at once for VoiceOver, which moves it a step at a time).
 * Android has no such slider here: a menu instead.
 */
export function SliderRow({ look, title, choices, selected, onPick, disabled = false }: { look: Look; title: string; choices: Choice[]; selected: string; onPick: (value: string) => void; disabled?: boolean }) {
  const at = Math.max(0, choices.findIndex((c) => c.value === selected));
  // Where the thumb is while it is held, so the step at the right follows it.
  const [held, setHeld] = useState<number | null>(null);
  const editing = useRef(false);
  const last = useRef(at);
  if (Platform.OS !== "ios" || choices.length < 2) return <MenuRow look={look} title={title} value={choices[at]?.label ?? ""} choices={choices} selected={selected} onPick={onPick} disabled={disabled} />;
  const shown = choices[held ?? at];
  const send = (i: number) => {
    setHeld(null);
    if (choices[i] && i !== at) onPick(choices[i].value);
  };
  return (
    <View style={{ paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
        <Tile {...look} />
        <Txt variant="body" style={{ flex: 1 }}>
          {title}
        </Txt>
        <Txt variant="body" tone="ink3">
          {shown?.label}
        </Txt>
      </View>
      <Host style={{ marginLeft: TILE + 11, height: 30 }}>
        <Slider
          value={held ?? at}
          min={0}
          max={choices.length - 1}
          step={1}
          modifiers={[accessibilityLabel(title), ...(disabled ? [off(true)] : [])]}
          onEditingChanged={(on) => {
            editing.current = on;
            if (!on) send(last.current);
          }}
          onValueChange={(v) => {
            const i = Math.round(v);
            last.current = i;
            if (editing.current) setHeld(i);
            else send(i);
          }}
        />
      </Host>
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

/** A settings sheet's bar: its title, and Close in glass (see SheetBar). */
export function SheetHeader({ title, onDone }: { title?: string; onDone: () => void }) {
  return <SheetBar title={title} close={{ label: "Close", onPress: onDone }} />;
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
  badge: { symbol: "app.badge", glyph: "●", tint: "#d93b3b" },
} satisfies Record<string, Look>;
