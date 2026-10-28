import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { FlatList, ScrollView, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import { Txt } from "../ui/components";
import { Glass } from "../ui/Glass";
import { PressScale } from "../ui/motion";
import { control, useColors } from "../ui/theme";
import type { StepPage } from "../view/stepPages";
import type { Row } from "../view/timeline";

/** One page, read top to bottom. The newest one goes down to what was just said, as a chat does. */
function PageScroll({ page, n, width, newest, renderRow, padTop, padBottom, footer }: { page: StepPage; n: number; width: number; newest: boolean; renderRow: (r: { item: Row }) => ReactElement; padTop: number; padBottom: number; footer: ReactNode }) {
  const scroll = useRef<ScrollViewInstance>(null);
  const count = useRef(page.rows.length);
  useEffect(() => {
    if (newest && page.rows.length > count.current) scroll.current?.scrollToEnd({ animated: true });
    count.current = page.rows.length;
  }, [newest, page.rows.length]);
  return (
    <ScrollView ref={scroll} testID={`step-page-${n}`} style={{ width }} contentContainerStyle={{ paddingTop: padTop, paddingBottom: padBottom + 8 }} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
      {page.rows.map((r) => (
        <View key={r.key}>{renderRow({ item: r })}</View>
      ))}
      {newest && footer}
    </ScrollView>
  );
}

/** Step by step's pages side by side, one on screen: a swipe goes to the one before or after, as the Mac's Previous and Next do. */
export function StepPager({ pages, index, onIndex, renderRow, padTop = 0, padBottom = 0, footer }: { pages: StepPage[]; index: number; onIndex: (i: number) => void; renderRow: (r: { item: Row }) => ReactElement; padTop?: number; padBottom?: number; /** Under the newest page: what Claude is doing. */ footer?: ReactNode }) {
  const screen = useWindowDimensions().width;
  const [width, setWidth] = useState(screen);
  const list = useRef<FlatList<StepPage>>(null);
  // The page asked for (a button, a new page, a search) slides into view; a swipe already put it there.
  const shown = useRef(index);
  useEffect(() => {
    if (shown.current === index) return;
    shown.current = index;
    list.current?.scrollToIndex({ index, animated: true });
  }, [index]);
  // A page on screen stays on screen when the width changes (the chats slid in beside it, the tablet turned).
  const laidOut = useRef(width);
  useEffect(() => {
    if (laidOut.current === width) return;
    laidOut.current = width;
    list.current?.scrollToOffset({ offset: shown.current * width, animated: false });
  }, [width]);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width || screen)}>
      <FlatList
        ref={list}
        testID="step-pager"
        horizontal
        pagingEnabled
        data={pages}
        extraData={renderRow}
        keyExtractor={(p) => p.key}
        initialScrollIndex={index}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        showsHorizontalScrollIndicator={false}
        windowSize={3}
        onMomentumScrollEnd={(e) => {
          const i = Math.max(0, Math.min(pages.length - 1, Math.round(e.nativeEvent.contentOffset.x / width)));
          shown.current = i;
          if (i !== index) onIndex(i);
        }}
        renderItem={({ item, index: i }) => <PageScroll page={item} n={i} width={width} newest={i === pages.length - 1} renderRow={renderRow} padTop={padTop} padBottom={padBottom} footer={footer} />}
      />
    </View>
  );
}

function Arrow({ label, flip, on, onPress, children }: { label: string; flip?: boolean; on: boolean; onPress: () => void; children?: ReactNode }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !on }} disabled={!on} onPress={onPress} hitSlop={6} scaleTo={0.9} opacity={on ? 1 : 0.35}>
      <View style={{ height: control - 8, minWidth: control - 8, paddingHorizontal: children ? 12 : 0, borderRadius: (control - 8) / 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: children ? colors.cobalt : "transparent" }}>
        {children}
        <View accessibilityElementsHidden style={{ width: 10, height: 10, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: children ? colors.white : colors.ink, borderRadius: 1.5, transform: [{ rotate: flip ? "-135deg" : "45deg" }], marginLeft: flip ? -3 : 3 }} />
      </View>
    </PressScale>
  );
}

/** Under the title: which page is on screen, and the way to the one before and after. (Reading it as one list is in the chat's settings.) */
export function StepNav({ pages, index, onIndex, fresh }: { pages: StepPage[]; index: number; onIndex: (i: number) => void; /** A page came while an older one was on screen. */ fresh: boolean }) {
  const page = pages[index];
  const last = pages.length - 1;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
      <Glass style={{ flex: 1, height: control - 4, borderRadius: (control - 4) / 2, flexDirection: "row", alignItems: "center", paddingHorizontal: 4 }}>
        <Arrow label="Previous page" on={index > 0} onPress={() => onIndex(index - 1)} />
        <View style={{ flex: 1, alignItems: "center" }} accessibilityRole="header">
          <Txt variant="small" tone="cobalt" numberOfLines={1} style={{ fontWeight: "700" }}>
            {page ? `${page.kicker} · ${index + 1} of ${pages.length}` : ""}
          </Txt>
        </View>
        {fresh ? (
          <Arrow label="New page" flip on onPress={() => onIndex(last)}>
            <Txt variant="small" tone="white" style={{ fontWeight: "700" }}>
              New page
            </Txt>
          </Arrow>
        ) : (
          <Arrow label="Next page" flip on={index < last} onPress={() => onIndex(index + 1)} />
        )}
      </Glass>
    </View>
  );
}
