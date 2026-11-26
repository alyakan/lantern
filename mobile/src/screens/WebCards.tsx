import { useState } from "react";
import { Pressable, View } from "react-native";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemoteWebCard } from "../protocol/generated/RemoteWebCard";
import { useController } from "../shell/hooks";
import { Button, Tag, Txt } from "../ui/components";
import { FadeSlideIn } from "../ui/motion";
import { radius, shadow, space, useColors } from "../ui/theme";

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "That didn't work.");

/** What a card is about, under its title: its canvas (or that it has none) and where it runs. */
function where(card: RemoteWebCard): string {
  const about = card.answer ? "Answers a chat's question" : card.canvas ? "About a design canvas" : "No design";
  const into = card.answer && card.chat ? `goes to ${card.chat}` : card.project_name ? `in ${card.project_name}` : "pick a project to run it in";
  return `${about} · ${into}`;
}

/**
 * The work web Claude sent from claude.ai, waiting for the user's Run as its card on the Mac does: its message, then Run (in its project,
 * or one picked here when it has none) or Decline. Nothing runs until Run is tapped.
 */
export function WebCards({ cards, gutter }: { cards: RemoteWebCard[]; gutter: number }) {
  if (cards.length === 0) return null;
  return (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      <Txt variant="small" style={{ fontWeight: "700", paddingHorizontal: gutter, paddingTop: 6 }}>
        From web Claude
      </Txt>
      {cards.map((c) => (
        <WebCard key={c.id} card={c} />
      ))}
    </View>
  );
}

function WebCard({ card }: { card: RemoteWebCard }) {
  const colors = useColors();
  const controller = useController();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A card with no project: Run first lists the projects to run it in.
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const needsProject = !card.project && !card.answer;

  const decide = (run: boolean, project: string | null = null) => {
    setBusy(true);
    setError(null);
    controller.sync.webRun(card.id, run, project).then(
      // The card goes once the Mac says it was answered.
      () => setBusy(false),
      (e) => {
        setBusy(false);
        setError(errText(e));
      },
    );
  };
  const run = () => {
    if (!needsProject) return decide(true);
    setError(null);
    controller.sync.projects().then(
      (list) => setProjects(list),
      (e) => setError(errText(e)),
    );
  };

  return (
    <FadeSlideIn from={12} style={[{ marginHorizontal: space.lg, backgroundColor: colors.card, borderRadius: radius.card, padding: 18, gap: 4 }, shadow.card]}>
      <Tag>{card.answer ? "Web Claude answered" : "Web Claude"}</Tag>
      <Txt variant="heading" style={{ marginTop: 8 }}>
        {card.title}
      </Txt>
      <Txt variant="small" tone="ink2">
        {where(card)}
      </Txt>
      <Pressable accessibilityRole="button" accessibilityLabel={open ? "Show less of the message" : "Show all of the message"} onPress={() => setOpen((o) => !o)} style={{ backgroundColor: colors.paper, borderRadius: radius.inner, padding: 10, marginTop: 8 }}>
        <Txt variant="body" numberOfLines={open ? undefined : 4} testID="web-card-message">
          {card.message}
        </Txt>
      </Pressable>
      {error && (
        <Txt variant="small" tone="stop" accessibilityRole="alert" style={{ marginTop: 6 }}>
          {error}
        </Txt>
      )}
      {projects ? (
        <View style={{ gap: 8, marginTop: 12 }}>
          <Txt variant="small" tone="ink2">
            Run it in:
          </Txt>
          {projects.length === 0 && <Txt variant="small">Your Mac has no projects to start a chat in.</Txt>}
          {projects.map((p) => (
            <Button key={p.id} label={p.name} kind="ghost" disabled={busy} onPress={() => decide(true, p.id)} />
          ))}
          <Button label="Cancel" kind="ghost" link disabled={busy} onPress={() => setProjects(null)} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button label="Decline" kind="ghost" style={{ flex: 1 }} disabled={busy} onPress={() => decide(false)} />
          <Button label={needsProject ? "Run in…" : "Run"} style={{ flex: 1 }} disabled={busy} onPress={run} />
        </View>
      )}
    </FadeSlideIn>
  );
}
