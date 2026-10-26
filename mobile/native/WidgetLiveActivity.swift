import SwiftUI
import WidgetKit
import ExpoModulesCore
import ActivityKit

// expo-widgets 58.0.23's own file, with one change: the card named "LanternChat" is drawn by LanternCard.swift (plain SwiftUI,
// next to this file) instead of by the layout the widget's JavaScript hands back. Anything else still goes the old way.
// plugins/withLanternCard.js puts both files into the package before the pods are installed, and refuses a different
// expo-widgets version, because this file must be made again from that version's own.

struct LiveActivityAttributes: ActivityAttributes {
  // The deep link URL passed to start(). Stored in the static attributes so it is
  // scoped to this activity and survives content updates, unlike ContentState.
  var url: String?

  public struct ContentState: Codable, Hashable {
    var name: String
    var props: String?
  }

  init(url: String? = nil) {
    self.url = url
  }
}

private let lanternCardName = "LanternChat"
private let lanternPanel = Color(red: 0.10, green: 0.13, blue: 0.17)

/// The card's own look, from what the Mac sent and what the system says about the screen.
private func lanternLook(_ context: ActivityViewContext<LiveActivityAttributes>, dimmed: Bool) -> LanternCardLook {
  LanternCardLook(props: LanternCardProps.read(context.state.props), stale: context.isStale, dimmed: dimmed)
}

private struct LanternBanner: View {
  let context: ActivityViewContext<LiveActivityAttributes>
  @Environment(\.isLuminanceReduced) var dimmed

  var body: some View {
    if #available(iOS 18.0, *) {
      LanternBannerForFamily(look: lanternLook(context, dimmed: dimmed))
    } else {
      LanternCardBanner(look: lanternLook(context, dimmed: dimmed))
    }
  }
}

/// From iOS 18 a card is also drawn small (the watch's Smart Stack).
@available(iOS 18.0, *)
private struct LanternBannerForFamily: View {
  let look: LanternCardLook
  @Environment(\.activityFamily) var family

  var body: some View {
    if family == .small {
      LanternCardSmall(look: look)
    } else {
      LanternCardBanner(look: look)
    }
  }
}

private struct LanternIslandPiece: View {
  enum Piece { case compactLeading, compactTrailing, minimal, expandedLeading, expandedTrailing, expandedBottom }
  let context: ActivityViewContext<LiveActivityAttributes>
  let piece: Piece
  @Environment(\.isLuminanceReduced) var dimmed

  var body: some View {
    let look = lanternLook(context, dimmed: dimmed)
    switch piece {
    case .compactLeading: LanternCompactLeading(look: look)
    case .compactTrailing: LanternCompactTrailing(look: look)
    case .minimal: LanternMinimal(look: look)
    case .expandedLeading: LanternExpandedLeading(look: look)
    case .expandedTrailing: LanternExpandedTrailing(look: look)
    case .expandedBottom: LanternExpandedBottom(look: look)
    }
  }
}

public struct WidgetLiveActivity: Widget {
  @Environment(\.self) var env

  let widgetContext: AppContext = AppContext()

  public init() {}

  public var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveActivityAttributes.self) { context in
      if context.state.name == lanternCardName {
        let card = LanternBanner(context: context)
          .activityBackgroundTint(lanternPanel)
          .activitySystemActionForegroundColor(.white)
        if let url = context.attributes.url.flatMap(URL.init(string:)) {
          card.widgetURL(url)
        } else {
          card
        }
      } else {
        let nodes = getLiveActivityNodes(
          forName: context.state.name,
          props: context.state.props,
          environment: getLiveActivityEnvironment(for: env, in: context)
        )
        // Only apply widgetURL when the activity has one: a hierarchy with more than one
        // widgetURL modifier is undefined behavior, and layouts can set their own through
        // the widgetURL modifier from @expo/ui.
        let banner = LiveActivityBannerView(context: context, nodes: nodes)
        if let url = context.attributes.url.flatMap(URL.init(string:)) {
          banner.widgetURL(url)
        } else {
          banner
        }
      }
    } dynamicIsland: { context in
      let nodes = context.state.name == lanternCardName ? [:] : getLiveActivityNodes(
        forName: context.state.name,
        props: context.state.props,
        environment: getLiveActivityEnvironment(for: env, in: context)
      )
      let ours = context.state.name == lanternCardName
      let island = DynamicIsland {
        DynamicIslandExpandedRegion(.center) {
          LiveActivitySectionView(context: context, nodes: nodes, sectionName: "expandedCenter")
        }
        DynamicIslandExpandedRegion(.leading) {
          if ours { LanternIslandPiece(context: context, piece: .expandedLeading) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "expandedLeading") }
        }
        DynamicIslandExpandedRegion(.trailing) {
          if ours { LanternIslandPiece(context: context, piece: .expandedTrailing) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "expandedTrailing") }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if ours { LanternIslandPiece(context: context, piece: .expandedBottom) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "expandedBottom") }
        }
      } compactLeading: {
        if ours { LanternIslandPiece(context: context, piece: .compactLeading) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "compactLeading") }
      } compactTrailing: {
        if ours { LanternIslandPiece(context: context, piece: .compactTrailing) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "compactTrailing") }
      } minimal: {
        if ours { LanternIslandPiece(context: context, piece: .minimal) } else { LiveActivitySectionView(context: context, nodes: nodes, sectionName: "minimal") }
      }
      if let url = context.attributes.url.flatMap(URL.init(string:)) {
        return island.widgetURL(url)
      }
      return island
    }
    .supplementalActivityFamiliesIfAvailable()
  }
}

private struct LiveActivitySectionView: View {
  let context: ActivityViewContext<LiveActivityAttributes>
  let nodes: [String: Any]
  let sectionName: String

  var body: some View {
    if let node = nodes[sectionName] as? [String: Any] {
      WidgetsDynamicView(name: context.activityID, kind: .liveActivity, node: node)
    } else {
      EmptyView()
    }
  }
}

private struct LiveActivityBannerView: View {
  var context: ActivityViewContext<LiveActivityAttributes>
  let nodes: [String: Any]

  var body: some View {
    if #available(iOS 18.0, *) {
      LiveActivityBanner(context: context, nodes: nodes)
    } else if let node = nodes["banner"] as? [String: Any] {
      WidgetsDynamicView(name: context.activityID, kind: .liveActivity, node: node)
    } else {
      EmptyView()
    }
  }
}

extension WidgetConfiguration {
  func supplementalActivityFamiliesIfAvailable() -> some WidgetConfiguration {
    if #available(iOS 18.0, iOSApplicationExtension 18.0, *) {
      return self.supplementalActivityFamilies([.small, .medium])
    } else {
      return self
    }
  }
}
