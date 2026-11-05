# Touch-first mobile & iPad — planning notes

Status: **Cruise (P0) implemented; the rest is planning.** The gesture vocabulary, orb/dock and iPad rail
below are still proposals.

North star: **one thumb.** The phone should let you steer Claude the way you swipe through
cards — the keyboard is a fallback, the mic is a fallback, and the *default* is tap / swipe /
slide.

The phone already refuses to send tool input (it only ever sends answers and drafted
messages), so every idea below reduces to something the phone is already allowed to do:
send a draft message, answer a question, allow/deny, approve/decline, switch a mode, or
take a "next step" it was shown. That keeps the trust model intact.

---

## 1. The centerpiece: "Cruise" (the agent keeps suggesting)

The one feature the request names: a control that asks the agent to **keep proposing the
next step**, each one arriving as an approval-style card the user just taps.

### What it is

In a chat, under the message box, a pill/switch: **Cruise off · Cruise on**.

- **Off** = today: Claude finishes a turn and waits for you to type.
- **On** = when Claude goes idle, it does not stop. It drafts the next step and presents it
  as a card in the conversation:

  ```
  ┌────────────────────────────────────────┐
  │  NEXT · Carry on                        │
  │  "Run the tests, then fix the two reds." │
  │  [ ✓ Do it ]    [ ↻ Another ]   [ ✕ Stop ]│
  └────────────────────────────────────────┘
  ```

- **Tap ✓ Do it** → that message is sent to the chat, Claude works, and when it idles again
  it drafts the *next* step. The loop repeats until you stop it, you swipe the card away,
  or a decision that genuinely needs a human (a permission / approval / question) interrupts.
- **↻ Another** → same one-call throttle as today's "New ideas": ask for a different draft.
- **✕ Stop / swipe the card left** → Cruise drops back to off, chat returns to normal.

### Why it fits what exists

- It is literally the existing [`suggest.rs`](src-tauri/src/remote/suggest.rs) pipeline
  (Haiku, no tools, no MCP, hostile-output parsing, at-most-N items) pointed at **one chat
  instead of the Home list**. The Mac already returns `Suggestion { title, why, message,
  target }`; "Cruise" needs a `target.kind: "continue"` on the *open* chat plus a turn-idle
  trigger instead of a Home-screen trigger.
- The card is the same shape as [`Suggestions.tsx`](mobile/src/screens/Suggestions.tsx) cards
  and the `NeedsDeck` cards — it is a *draft the user reads and sends*, never auto-sent.

### The drafting model & context (the Sonnet question)

Yes — Sonnet is a one-line change. [`suggest.rs`](src-tauri/src/remote/suggest.rs) hardcodes
`--model haiku` in `args()` (line 39); [`desk.rs`](src-tauri/src/desk.rs) already makes the
same no-tools, no-session calls with `--model sonnet` (lines 101, 242, 404), so a Sonnet
Cruise call is architecturally identical. Make it a per-user setting (Haiku default, Sonnet
opt-in), since it is a cost choice.

**Context is the inversion of today's Home suggest.** Home passes **6 chats × (title + last
said + last replied)**; per-chat Cruise passes **1 chat × the last N turns**. The hub already
keeps the turn history (`hub.since(slot, 0)`), and turns are `UiEvent::UserText` /
`AssistantText` events, so "last 6–10 turns, clipped" is a small `digests()`-style helper.
Two rules to carry over:

- **Text only.** Send user text + assistant text, never tool calls, file contents or paths,
  and keep the existing hook filter (`post_text`) so a hook's message isn't read as your words.
- **Cache key must include the extra context**, or Cruise serves a stale draft when the last N
  turns change (today's `state_key` only hashes slot + last said/replied + state).

**Tradeoffs.** Sonnet ≈ 15× Haiku per token and is slower; keep the one-call-at-a-time and
one-per-minute throttle, add a per-chat-per-hour cap, and bump the 60 s timeout. Haiku is fine
for "the obvious next step"; Sonnet earns its cost when the next step needs judgment (e.g.
"the build failed for reason X, so do Y"). One thing to decide now: the draft call runs on the
*user's* Claude login, separate from the chat's working model — so a Codex/Gemini chat still
gets its "what next" from Claude Sonnet. That matches how suggest already works (it skips
off-Claude chats); using the chat's own provider is more plumbing, later.

### The rules that keep it safe and cheap

- **Never auto-send.** A Cruise card is always a draft; the user's tap is the send. (Same
  guarantee as Home suggestions.)
- **Bounded cost.** Reuse the existing throttle: one model call at a time, at most one per
  minute, no call while a real decision waits on the user, stop after 60 s. "Keep suggesting"
  must never become "keep burning usage."
- **A real decision always breaks the loop.** A permission, approval or question card takes
  over the Cruise slot; the loop resumes only after you answer it. Review is *unchanged*:
  Cruise only drafts the next message; it never auto-approves, never skips a diff, never
  answers a question. A file change still shows its diff and waits (swipe-to-allow when it
  fits inline, "Review the change" when it doesn't).
- **"Review every change" (recommended default).** Because Cruise drives without the user's
  typing, it defaults to stopping at *every* file edit — including the in-workspace edits
  Ask would normally auto-apply — so each diff is eyeballed before the loop continues. An
  "Auto (trust the classifier)" escape hatch keeps hands-off users on the current Ask/Auto
  semantics. This is the compensating control for removing the typed message.
- **Swipe = stop.** A left swipe on the Cruise card is the cheap, hard-to-miss off switch.

### Viewing the files & changes (hard requirement)

Viewing is **read-only and never gated by Cruise**. It already exists and Cruise does not
touch it:

- **Phone**: the "What changed" sheet ([`ChangesPane.tsx`](mobile/src/screens/ChangesPane.tsx),
  opened from `ChatScreen`), a list of the chat's changed files with a per-file diff.
- **iPad**: the Changes pane ([`ChangesDock.tsx`](mobile/src/screens/ChangesDock.tsx) wrapping
  `ChangesPane`) beside the chat — resizable by its divider, floatable as a big card, and the
  right pane on a landscape window 1200 pt or wider.

Both are explicitly **read-only — "nothing here writes anything"** — and they re-read the
Mac's list whenever the chat edits, so they update live while Cruise drives. So the user can
keep the pane open and watch each diff land, because *viewing* does not block the loop; only
a *permission/approval card* does. The two must not be conflated: the pane is inspection, the
card is consent.

### A small, important UI detail

Cruise should render its cards **in the message stream** (so there is history), but the
current one should also surface in the **composer**, where the thumb already lives, so you
don't have to scroll to act.

---

## 2. The gesture vocabulary (reusable primitives)

These are the "more stuff like that." Each is a small, independently shippable primitive.

### 2.1 Card-deck steering (swipe = decide)

`NeedsDeck` already stacks decisions with peeking cards but drives them with two buttons.
Make the deck **swipeable**:

- **Swipe right = allow / approve / do.**
- **Swipe left = deny / decline / skip.**
- **Tap = open the full diff / question first.**

The card follows the finger (PanResponder, same as `SwipeToAllow`), past a threshold or a
flick it commits, otherwise it springs back. A file change that is "too big to read inline"
still forces a tap-to-open first — the guard in `fitsInline` stays.

### 2.2 Directional flicks on suggestion cards

On a Cruise / suggestion card, a **short right flick = do it**, a **short left flick = skip /
regenerate**, a **long-press = expand** (full draft, edit before sending). This gives three
actions with no buttons and no typing.

### 2.3 Drag-to-answer (slider with detents)

`AskUserQuestion` options become a vertical track with a thumb. Drag the thumb to the option
you want and release; the options "snap" like a detented slider. One gesture, no tap
precision needed, and a screen-reader still gets a plain button list. (This is a natural
reuse of the `SwipeToAllow` knob mechanics with N stop-points instead of one.)

### 2.4 The lantern orb (floating status + actions)

A small floating orb (the lantern), bottom-right, thumb-reachable:

- **Glows/pulses** when a decision *or* a Cruise suggestion is ready.
- **Tap** = act on the top thing (approve the top card / do the top suggestion).
- **Drag up** = unfold a short tray: *Do it, Another, Approve all safe, Stop, New chat.*
- **Drag left/right** = cycle to the next waiting chat.

It collapses everything "needs me now" into one finger, so the top bar can stay a
status/context strip (which is where the navbar work is heading).

### 2.5 Long-press pie menu on the composer

Long-press the composer (or a chat bubble) for a **pie/radial menu** of 4–6 actions:
*Suggest next, Run the plan, Approve all safe, Stop, New chat, Voice.* Release toward the
action you want. Directional, no reach problem, and the same menu is the tablet's
command-palette replacement.

### 2.6 Shake / swipe-back to undo

A just-allowed action can be undone with a **swipe back** or a quick **shake** within a few
seconds ("Undo allowing that"). Reversible-feeling actions are what make swipe-to-approve
feel safe enough to be the default.

---

## 3. iPad: a decision rail, not a navigation problem

The iPad has room. Give the larger canvas a **persistent decision rail**:

- **Left**: the chat / diff, read-only.
- **Right (or trailing side of the chat column)**: a rail of everything that needs you —
  the waiting decision, the current Cruise suggestion, the plan's next step, the todo that's
  due — each a tappable/slidable card, always visible, no navigation.
- On landscape ≥1200 pt this replaces today's "open the changes pane" pattern with a
  **split: work on the left, steer on the right**.

The rail is the same `Deck`/`Suggestion` card components, laid out vertically; nothing new
to render, just a third layout in [`layout.ts`](mobile/src/view/layout.ts).

---

## 4. Reuse map (what this builds on)

| New idea | Already exists to extend |
| --- | --- |
| Cruise next-step drafts | [`suggest.rs`](src-tauri/src/remote/suggest.rs), [`Suggestions.tsx`](mobile/src/screens/Suggestions.tsx), `Suggestion` protocol type |
| Swipeable decision deck | [`NeedsDeck.tsx`](mobile/src/screens/NeedsDeck.tsx), `SwipeToAllow`'s PanResponder |
| Drag-to-answer | [`SwipeToAllow.tsx`](mobile/src/ui/SwipeToAllow.tsx) knob mechanics |
| Directional flicks | [`SwipeRow.tsx`](mobile/src/ui/SwipeRow.tsx) / [`rowSwipe.ts`](mobile/src/view/rowSwipe.ts) |
| Orb + tray | `TopBar`, `ModeSwitch`, `LiveActivity` "needs you" state |
| Pie menu | `PanelMenu` / `Sheet` primitives |
| Decision rail (iPad) | [`TabletShell.tsx`](mobile/src/shell/TabletShell.tsx), `layout.ts`, `ChangesPane` |

---

## 5. Suggested phasing

**P0 — the request itself**
- Cruise toggle + next-step card in the composer/stream (one-chat `suggest` target, turn-idle
  trigger, throttle). Smallest possible version: reuse the Home suggestion card as-is.

**P1 — one gesture for decisions**
- Swipeable `Deck` (right = allow, left = deny).
- Directional flicks on suggestion cards.

**P2 — the thumb layer**
- Lantern orb + tray.
- Drag-to-answer detents.
- Pie menu on composer long-press.

**P3 — iPad rail & polish**
- Persistent decision rail; orb and pie menu parity; undo via swipe-back.

---

## 6. Decisions & open questions

**Decided**
- **Per-chat only** (no desk-wide Cruise in v1).
- **Never auto-send** — a Cruise card is always a draft the user's tap sends.
- **Drafting model**: Sonnet-backed, with the last few turns as context (see §1); Haiku stays
  the default until the cost is felt, Sonnet as an opt-in setting.

**Still open**
- **Where the orb lives vs. the navbar work** — does the top capsule stay a status strip and
  the orb become the action surface? Needs a visual prototype before deciding; mock it as a
  throwaway sim screen (the same frame-strip method used for the iPad shell motion) and look
  at the two together.

---

## 7. Implemented (v1)

- **Rust** — `Request::Cruise { slot, refresh }`, and `"cruise"` in `FEATURES`.
  [`suggest.rs`](src-tauri/src/remote/suggest.rs) gained `CruiseDigest`, `cruise_digest` (the last 8 turns of one chat, text
  only; a hook's own message and subagents' insides left out), `cruise_prompt`, `cruise_parse` (only a `continue` for *this*
  chat), `Cruiser` (per-chat cache: 15 min TTL, one ask at a time, 30 s gap), and `ask_claude_cruise` (**Sonnet**).
  `Host::cruise_reply` defaults to `suggest_reply`; the real Host overrides it with Sonnet.
- **Mobile** — [`sync.ts`](mobile/src/sync/sync.ts) `cruise(slot, refresh)` (kept per chat for 2 min; refuses a Mac without
  the feature); [`view/cruise.ts`](mobile/src/view/cruise.ts) (`shouldAsk`, `draftAt`) + tests; [`screens/Cruise.tsx`](mobile/src/screens/Cruise.tsx)
  (`CruiseBar`: a pill → a card with **Do it / Another / Stop**, and "Waiting for this turn to end…" while the chat isn't at
  rest); wired into [`ChatScreen.tsx`](mobile/src/screens/ChatScreen.tsx) — asks once when a turn ends, sends the draft on Do it,
  never auto-sends.
- **Verified** — `cargo check`; `cargo test --lib remote::suggest` (28 pass); `tsc --noEmit`; `jest` for the view, sync and
  component (36 pass).
- **Not done yet** — the orb/dock/navbar layout (still open); the "review every change" setting; persisting the per-chat
  toggle; a fixture-gateway cruise reply; and nothing has been seen on a real device.
