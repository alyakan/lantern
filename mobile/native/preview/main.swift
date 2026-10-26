import AppKit
import SwiftUI

// Draws the card in each of its states to one picture, so it can be looked at without a phone:
//   mobile/native/preview/render.sh /tmp/card.png
// The lock screen's own background and corner radius are drawn as the system draws them (a dark panel); the real thing may
// differ a little in material, never in layout.

let panel = Color(red: 0.10, green: 0.13, blue: 0.17)

func card(_ json: String, stale: Bool = false, dimmed: Bool = false) -> some View {
  let look = LanternCardLook(props: LanternCardProps.read(json), stale: stale, dimmed: dimmed)
  return LanternCardBanner(look: look)
    .frame(width: 360)
    .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(panel))
}

/// The watch's Smart Stack form, at the width the watch gives it.
func small(_ json: String, width: CGFloat = 170) -> some View {
  let look = LanternCardLook(props: LanternCardProps.read(json), stale: false, dimmed: false)
  return LanternCardSmall(look: look)
    .frame(width: width)
    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(panel))
}

func island(_ json: String) -> some View {
  let look = LanternCardLook(props: LanternCardProps.read(json), stale: false, dimmed: false)
  return HStack(spacing: 10) {
    HStack(spacing: 6) { LanternCompactLeading(look: look); Spacer(); LanternCompactTrailing(look: look) }
      .padding(.horizontal, 12)
      .frame(width: 150, height: 36)
      .background(Capsule().fill(Color.black))
    LanternMinimal(look: look).frame(width: 36, height: 36).background(Circle().fill(Color.black))
    LanternMark(height: 64)
  }
}

let since = Int((Date().timeIntervalSince1970 - 3 * 60 - 7) * 1000)

struct Sheet: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      card(#"{"project":"lantern","status":"working","since":\#(since)}"#)
      card(#"{"project":"lantern","status":"working","since":\#(since),"title":"Release 0.1.66","steps_done":3,"steps_total":5,"plan":42}"#)
      card(#"{"project":"lantern","status":"needs_you","since":\#(since),"title":"Release 0.1.66","steps_done":3,"steps_total":5,"needs":"command","plan":86}"#)
      card(#"{"project":"lantern","status":"done","since":\#(since),"title":"Release 0.1.66","steps_done":5,"steps_total":5,"plan":91}"#)
      card(#"{"project":"lantern","status":"failed","since":\#(since)}"#)
      card(#"{"project":"lantern","status":"working","since":\#(since),"title":"A long title that goes on and on past the room it has","steps_done":1,"steps_total":4}"#, stale: true)
      card(#"{"project":"lantern","status":"working","since":\#(since),"title":"Release 0.1.66","steps_done":3,"steps_total":5,"plan":42}"#, dimmed: true)
      card("not json at all")
      island(#"{"project":"lantern","status":"working","since":\#(since),"steps_done":3,"steps_total":5}"#)
      small(#"{"project":"lantern","status":"working","since":\#(since),"title":"Release 0.1.66","steps_done":3,"steps_total":5}"#)
      small(#"{"project":"lantern","status":"needs_you","since":\#(since),"needs":"command","steps_done":3,"steps_total":5}"#)
      small(#"{"project":"lantern","status":"done","since":\#(since)}"#)
      small(#"{"project":"lantern","status":"working","since":\#(since)}"#, width: 150)
    }
    .padding(20)
    .background(Color(red: 0.30, green: 0.45, blue: 0.50))
    .environment(\.colorScheme, .dark)
  }
}

@MainActor
func render(to path: String) {
  let renderer = ImageRenderer(content: Sheet())
  renderer.scale = 3
  guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
    print("could not draw")
    exit(1)
  }
  try? png.write(to: URL(fileURLWithPath: path))
  print("wrote \(path)")
}

MainActor.assumeIsolated { render(to: CommandLine.arguments.dropFirst().first ?? "/tmp/lantern-card.png") }
