import { Image, ScrollView, useWindowDimensions, View } from "react-native";
import { Sheet, SheetBar } from "../ui/Sheet";

/** The photos of a message, one to a page, to look at whole: swipe for the next. */
export function PhotoViewer({ uris, first = 0, onClose }: { uris: string[]; first?: number; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const page = Math.min(width, 640);
  return (
    <Sheet size="large" onClose={onClose}>
      {(close) => (
        <View style={{ flex: 1 }}>
          <SheetBar title={uris.length > 1 ? "Photos" : "Photo"} close={{ label: "Close", onPress: close }} />
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} contentOffset={{ x: first * page, y: 0 }} style={{ flex: 1 }}>
            {uris.map((uri, i) => (
              <View key={uri} style={{ width: page, flex: 1, padding: 12 }}>
                <Image accessibilityLabel={`Photo ${i + 1} of ${uris.length}`} source={{ uri }} resizeMode="contain" style={{ flex: 1, width: "100%" }} />
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}
