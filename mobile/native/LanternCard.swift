import SwiftUI

// The lock-screen card and the Dynamic Island, in plain SwiftUI. It knows nothing of ActivityKit or WidgetKit, so the same
// file is drawn to a picture on a Mac (mobile/native/preview) before it ships. The Mac sends the card's words as a JSON
// string (`props`); ChatCardProps in src/widgets/lanternChat.tsx and Detail in src-tauri/src/remote/live_activity.rs say what
// is in it. Never a command, a file, a question or any of Claude's words.

struct LanternCardProps: Decodable {
  var project: String = "Lantern"
  var status: String = "working"
  /// When the turn began, ms since the epoch.
  var since: Double?
  var title: String?
  var steps_done: Double?
  var steps_total: Double?
  var needs: String?
  /// How much of the plan's five-hour window is used, 0 to 100.
  var plan: Double?

  /// What the Mac sent, or the plainest card when it sent nothing readable (a card must never come out blank).
  static func read(_ json: String?) -> LanternCardProps {
    guard let data = json?.data(using: .utf8), let props = try? JSONDecoder().decode(LanternCardProps.self, from: data) else {
      return LanternCardProps()
    }
    return props
  }

  enum CodingKeys: String, CodingKey { case project, status, since, title, steps_done, steps_total, needs, plan }

  init() {}

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    project = (try? c.decode(String.self, forKey: .project)) ?? "Lantern"
    status = (try? c.decode(String.self, forKey: .status)) ?? "working"
    since = try? c.decode(Double.self, forKey: .since)
    title = try? c.decode(String.self, forKey: .title)
    steps_done = try? c.decode(Double.self, forKey: .steps_done)
    steps_total = try? c.decode(Double.self, forKey: .steps_total)
    needs = try? c.decode(String.self, forKey: .needs)
    plan = try? c.decode(Double.self, forKey: .plan)
  }
}

/// What the card says, worked out once from the props and the two things the system says about the screen.
struct LanternCardLook {
  let props: LanternCardProps
  /// The Mac hasn't updated the card for a while (it went to sleep, say): it says so instead of going on saying Working.
  let stale: Bool
  /// Always-on and dimmed: colour gives way to white.
  let dimmed: Bool

  var live: Bool { props.status == "working" || props.status == "needs_you" }
  var working: Bool { props.status == "working" && !(stale && live) }
  var isStale: Bool { stale && live }

  var words: String {
    if isStale { return "Not updating" }
    switch props.status {
    case "working": return "Working"
    case "needs_you": return "Needs you"
    case "done": return "Done"
    default: return "Stopped"
    }
  }

  var hue: Color {
    if dimmed { return .white }
    if isStale { return Color(red: 0.56, green: 0.56, blue: 0.58) }
    switch props.status {
    case "working": return Color(red: 0.36, green: 0.56, blue: 1.0)
    case "needs_you": return Color(red: 1.0, green: 0.70, blue: 0.28)
    case "done": return Color(red: 0.30, green: 0.80, blue: 0.50)
    default: return Color(red: 1.0, green: 0.42, blue: 0.42)
    }
  }

  var symbol: String {
    if isStale { return "zzz" }
    switch props.status {
    case "working": return "ellipsis"
    case "needs_you": return "exclamationmark"
    case "done": return "checkmark"
    default: return "xmark"
    }
  }

  var since: Date? { props.since.map { Date(timeIntervalSince1970: $0 / 1000) } }

  var title: String { (props.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

  var stepsTotal: Int { (props.steps_total ?? 0) > 0 ? Int((props.steps_total ?? 0).rounded()) : 0 }
  var stepsDone: Int { stepsTotal > 0 ? min(max(Int((props.steps_done ?? 0).rounded()), 0), stepsTotal) : 0 }
  var stepsText: String { stepsDone == stepsTotal ? "All \(stepsTotal) steps done" : "\(stepsDone) of \(stepsTotal) steps" }

  var plan: Int? { props.plan.map { min(max(Int($0.rounded()), 0), 100) } }
  var planColour: Color {
    guard let plan else { return .secondary }
    if dimmed { return .white }
    return plan >= 100 ? Color(red: 1.0, green: 0.42, blue: 0.42) : plan >= 80 ? Color(red: 1.0, green: 0.70, blue: 0.28) : Color.white.opacity(0.55)
  }

  /// What a chat that needs you is asking for, in a few words (never the command, the file or the question).
  var asks: String {
    guard props.status == "needs_you", !isStale else { return "" }
    switch props.needs {
    case "command": return "Wants to run a command"
    case "edit": return "Wants to change a file"
    case "question": return "Has a question"
    case "approval": return "Needs your approval"
    case "tool": return "Wants to use a tool"
    default: return ""
    }
  }

  /// The line under the project's name: the chat's own title, else what is going on.
  var subtitle: String {
    if !title.isEmpty { return title }
    if !asks.isEmpty { return asks }
    switch props.status {
    case "working": return isStale ? "Waiting for your Mac" : "Claude is on it"
    case "needs_you": return "Waiting for you"
    case "done": return "Finished"
    default: return "Something went wrong"
    }
  }
}

// MARK: - The mark: Lantern's own icon, drawn small

private let markWidth: CGFloat = 425
private let markHeight: CGFloat = 628

/// A shape drawn in the icon's own coordinates (425 by 628), scaled to the frame it is given.
private struct MarkPart: Shape {
  let build: @Sendable (inout Path) -> Void

  func path(in rect: CGRect) -> Path {
    var p = Path()
    build(&p)
    return p.applying(CGAffineTransform(scaleX: rect.width / markWidth, y: rect.height / markHeight))
  }
}

struct LanternMark: View {
  let height: CGFloat
  var stale = false
  var dimmed = false

  private var top: Color { dimmed ? .white : stale ? Color(red: 0.62, green: 0.62, blue: 0.64) : Color(red: 1.0, green: 0.83, blue: 0.48) }
  private var bottom: Color { dimmed ? .white : stale ? Color(red: 0.48, green: 0.48, blue: 0.50) : Color(red: 1.0, green: 0.62, blue: 0.18) }
  private let ink = Color(red: 0.17, green: 0.19, blue: 0.23)
  private let paper = Color(red: 0.92, green: 0.87, blue: 0.79)

  var body: some View {
    let width = height * markWidth / markHeight
    ZStack {
      MarkPart { p in p.addRoundedRect(in: CGRect(x: 23, y: 132, width: 377, height: 496), cornerSize: CGSize(width: 48, height: 48)) }
        .fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
      MarkPart { p in
        p.addArc(center: CGPoint(x: 212, y: 85), radius: 66, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
      }
      .stroke(ink, style: StrokeStyle(lineWidth: 32 * width / markWidth, lineCap: .butt))
      MarkPart { p in
        p.addEllipse(in: CGRect(x: 114, y: 68, width: 34, height: 34))
        p.addEllipse(in: CGRect(x: 277, y: 68, width: 34, height: 34))
      }
      .fill(ink)
      MarkPart { p in
        for rect in [CGRect(x: 0, y: 132, width: 354, height: 142), CGRect(x: 70, y: 309, width: 355, height: 142), CGRect(x: 0, y: 486, width: 354, height: 142)] {
          p.addRoundedRect(in: rect, cornerSize: CGSize(width: 32, height: 32))
        }
      }
      .fill(ink)
      if height >= 28 {
        MarkPart { p in
          for (x, y) in [(38.0, 177.0), (108.0, 354.0), (38.0, 531.0)] {
            p.addRoundedRect(in: CGRect(x: x, y: y, width: 239, height: 17), cornerSize: CGSize(width: 8, height: 8))
            p.addRoundedRect(in: CGRect(x: x, y: y + 36, width: 168, height: 17), cornerSize: CGSize(width: 8, height: 8))
          }
        }
        .fill(paper)
      }
    }
    .frame(width: width, height: height)
    .accessibilityHidden(true)
  }
}

// MARK: - Pieces

/// The state as a small coloured pill: a dot and a word.
struct LanternStatusPill: View {
  let look: LanternCardLook

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(look.hue).frame(width: 7, height: 7)
      Text(look.words).font(.system(size: 13, weight: .semibold)).foregroundColor(look.hue)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(Capsule().fill(look.hue.opacity(0.18)))
    .fixedSize()
  }
}

/// How long the turn has been going (counts up by itself: the system draws it, no update needed).
struct LanternTimer: View {
  let look: LanternCardLook

  var body: some View {
    if look.working, let since = look.since {
      Text(since, style: .timer)
        .font(.system(size: 14, weight: .medium))
        .monospacedDigit()
        .foregroundColor(look.dimmed ? .white : Color.white.opacity(0.75))
        .multilineTextAlignment(.trailing)
        .frame(width: 64, alignment: .trailing)
    }
  }
}

struct LanternSteps: View {
  let look: LanternCardLook

  var body: some View {
    if look.stepsTotal > 0 {
      VStack(alignment: .leading, spacing: 5) {
        // Drawn, not ProgressView: it is the same on every screen and in the picture made on a Mac.
        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.14))
            Capsule().fill(look.hue).frame(width: max(geo.size.width * CGFloat(look.stepsDone) / CGFloat(look.stepsTotal), look.stepsDone > 0 ? 6 : 0))
          }
        }
        .frame(height: 6)
        Text(look.stepsText)
          .font(.system(size: 12))
          .monospacedDigit()
          .foregroundColor(Color.white.opacity(0.65))
      }
    }
  }
}

// MARK: - The card

/// The lock-screen banner.
struct LanternCardBanner: View {
  let look: LanternCardLook

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        LanternMark(height: 42, stale: look.isStale, dimmed: look.dimmed)
        VStack(alignment: .leading, spacing: 2) {
          Text(look.props.project)
            .font(.system(size: 17, weight: .bold))
            .foregroundColor(.white)
            .lineLimit(1)
          Text(look.subtitle)
            .font(.system(size: 13))
            .foregroundColor(Color.white.opacity(0.65))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
          LanternStatusPill(look: look)
          LanternTimer(look: look)
        }
      }
      LanternSteps(look: look)
      if let plan = look.plan {
        HStack {
          Text("Plan")
            .font(.system(size: 12))
            .foregroundColor(Color.white.opacity(0.5))
          Spacer()
          Text("\(plan)% used")
            .font(.system(size: 12, weight: .medium))
            .monospacedDigit()
            .foregroundColor(look.planColour)
        }
      }
    }
    .padding(16)
  }
}

/// The island's small forms.
struct LanternCompactLeading: View {
  let look: LanternCardLook
  var body: some View { LanternMark(height: 20, stale: look.isStale, dimmed: look.dimmed) }
}

struct LanternCompactTrailing: View {
  let look: LanternCardLook
  var body: some View {
    if look.working, look.stepsTotal > 0 {
      Text("\(look.stepsDone)/\(look.stepsTotal)").font(.system(size: 13, weight: .semibold)).monospacedDigit().foregroundColor(look.hue)
    } else {
      Image(systemName: look.symbol).font(.system(size: 12, weight: .bold)).foregroundColor(look.hue)
    }
  }
}

struct LanternMinimal: View {
  let look: LanternCardLook
  var body: some View { LanternMark(height: 20, stale: look.isStale, dimmed: look.dimmed) }
}

struct LanternExpandedLeading: View {
  let look: LanternCardLook
  var body: some View { LanternMark(height: 36, stale: look.isStale, dimmed: look.dimmed).padding(.leading, 4) }
}

struct LanternExpandedTrailing: View {
  let look: LanternCardLook
  var body: some View {
    VStack(alignment: .trailing, spacing: 4) {
      LanternStatusPill(look: look)
      LanternTimer(look: look)
    }
  }
}

struct LanternExpandedBottom: View {
  let look: LanternCardLook
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(look.props.project).font(.system(size: 16, weight: .bold)).foregroundColor(.white).lineLimit(1)
        Text(look.subtitle).font(.system(size: 13)).foregroundColor(Color.white.opacity(0.65)).lineLimit(1)
      }
      LanternSteps(look: look)
    }
  }
}

/// The small form (the Apple Watch's Smart Stack, from iOS 18): the mark, the state and the time, nothing more.
struct LanternCardSmall: View {
  let look: LanternCardLook

  var body: some View {
    HStack(spacing: 8) {
      LanternMark(height: 30, stale: look.isStale, dimmed: look.dimmed)
      VStack(alignment: .leading, spacing: 1) {
        Text(look.props.project).font(.system(size: 13, weight: .bold)).foregroundColor(.white).lineLimit(1)
        Text(look.words).font(.system(size: 12, weight: .semibold)).foregroundColor(look.hue).lineLimit(1)
      }
      Spacer(minLength: 4)
      if look.working, let since = look.since {
        Text(since, style: .timer)
          .font(.system(size: 12, weight: .medium))
          .monospacedDigit()
          .foregroundColor(Color.white.opacity(0.75))
          .multilineTextAlignment(.trailing)
          .frame(width: 46, alignment: .trailing)
      }
    }
    .padding(10)
  }
}
