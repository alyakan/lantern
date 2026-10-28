//! What Codex is told about Lantern: its note about the app, Step by step's page loop, and a worker's brief. It goes to
//! Codex as the thread's `developerInstructions` (thread/start and thread/resume), which the app-server adds to Codex's own
//! instructions rather than replacing them (that is `baseInstructions`).
//!
//! Claude's texts (args.rs) can't be sent as they are: they name the `claude` CLI, its auto mode, advisor and subagents, its
//! skills, and a `mcp__lantern__reproduce` tool a Codex session doesn't have. The page loop is shared: STEPS_PROMPT with
//! those few sentences swapped (the test below fails if one of them moves, rather than letting Codex read a stale tool name).

use crate::args::{worker_prompt, Mode, Role, STEPS_PROMPT};

/// A read-only agent's line: Claude's (READ_ONLY_PROMPT) names Claude Code's tools; Codex runs in its read-only sandbox.
const READ_ONLY_PROMPT: &str = "You are read-only: you share another agent's folder, and your sandbox lets you read files and run commands that only read (such as git log, git diff, git show, grep, ls), but nothing you run can change, create, move or delete a file, nor commit. Don't try to work around it. Read what the task names, use git to see what changed (git diff main...the-branch, git log) when the task is a branch or a commit, then report what you find.";

/// Each sentence of STEPS_PROMPT that depends on Claude Code, and what Codex is told in its place.
const STEPS_SWAPS: &[(&str, &str)] = &[
    (
        "follow the user's incremental-dev skill exactly (load it with the Skill tool, `incremental-dev`); if it isn't available, work that way anyway: frame the task",
        "work incrementally: frame the task",
    ),
    ("follow the user's incremental-pr-review skill exactly (load it with the Skill tool, `incremental-pr-review`): frame the review", "frame the review"),
    ("use the skill's sections exactly", "use these sections exactly"),
    ("answer the skill's commit question", "answer the commit question"),
    // The Base: line already tells Lantern what to compare; Codex has no review_target tool to say it twice.
    (
        " Call mcp__lantern__review_target when the review starts ({\"pr\": N} for a pull request, {\"base\": \"<branch>\"} for a local branch stacked on another, {} for one cut from the default branch) and again whenever what you review changes, such as right after you open a pull request for the branch with gh pr create: the Changes pane shows it at once.",
        "",
    ),
    (
        "call the mcp__lantern__reproduce tool with exact steps and where the logs will appear: it waits for them and returns their note (often the logs they saw), so don't end your turn to ask.",
        "end your turn on a page with the exact steps and where the logs will appear, and ask them to reply with what they saw (often the logs).",
    ),
];

fn steps_prompt() -> String {
    STEPS_SWAPS.iter().fold(STEPS_PROMPT.to_string(), |text, (from, to)| text.replacen(from, to, 1))
}

/// The instructions for a Codex chat in `mode` as `role`. Lantern's Auto has no Codex equivalent and is never offered for
/// it, so its Permissions read as Ask here, as it runs.
pub fn instructions(mode: Mode, role: &Role) -> String {
    let workflow = if mode == Mode::Steps { "Step by step" } else { "Chat" };
    let mut text = format!(
        "You are running inside Lantern, a macOS desktop app for coding agents (github.com/alyakan/lantern), as Codex. The user sees each turn as cards and diffs, with tabs for Changes (every file you touched, as diffs), Files (an editor: the user can change and save files themselves, so a file may differ from what you last read) and Tests. They pick the settings and the model; you can't change them. Every chat has two settings:
Permissions: Ask. Edits inside the workspace apply as you make them; a command outside the sandbox, network access or a file outside the workspace shows the user an Allow/Deny card, and you carry on with their answer.
Workflow: Chat, where you work as usual, or Step by step, one page per message in a flavour (Build, Review, Debug or Design).
This chat's Permissions are Ask and its Workflow is {workflow}. A message the user starts with `!` in Lantern's box is a shell command they ran themselves in this folder; its output reaches you with their next message as <bash-input> and <bash-stdout>. If they ask how Lantern works, its README lists what it does."
    );
    if mode == Mode::Steps {
        text.push_str("\n\n");
        text.push_str(&steps_prompt());
    }
    if let Role::Worker { name, read_only } = role {
        text.push_str("\n\n");
        text.push_str(&worker_prompt(name));
        if *read_only {
            text.push(' ');
            text.push_str(READ_ONLY_PROMPT);
        } else {
            text.push_str(" Your sandbox may not let you write a git worktree's own git folder, which sits outside your folder: a commit then asks the user for approval, which is expected.");
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_claude_specific_sentence_of_the_page_loop_is_swapped_out_for_codex() {
        for (from, _) in STEPS_SWAPS {
            assert!(STEPS_PROMPT.contains(from), "STEPS_PROMPT changed; update the swap: {from}");
        }
        let text = steps_prompt();
        for stale in ["mcp__lantern", "Skill tool", "incremental-dev", "incremental-pr-review", "the skill's"] {
            assert!(!text.contains(stale), "{stale} reached Codex");
        }
        assert!(text.contains("# Frame") && text.contains("# Evidence N"));
    }

    #[test]
    fn the_note_names_codex_and_the_modes_it_has_and_never_mentions_claude_only_things() {
        let ask = instructions(Mode::Ask, &Role::Normal);
        assert!(ask.contains("as Codex") && ask.contains("Permissions are Ask and its Workflow is Chat."));
        assert!(!ask.contains("# Frame"), "Ask has no page loop");
        for stale in ["claude", "classifier", "advisor", "subagent"] {
            assert!(!ask.to_lowercase().contains(stale), "{stale}");
        }
        // Auto can't run on Codex: it reads as Ask.
        assert!(instructions(Mode::Auto, &Role::Normal).contains("Permissions are Ask and its Workflow is Chat."));
    }

    #[test]
    fn step_by_step_adds_the_page_loop_and_a_worker_its_brief() {
        let steps = instructions(Mode::Steps, &Role::Normal);
        assert!(steps.contains("its Workflow is Step by step.") && steps.contains("# Frame"));
        let worker = instructions(Mode::Ask, &Role::Worker { name: "scout".into(), read_only: false });
        assert!(worker.contains("named \"scout\"") && worker.contains("git worktree"));
        assert!(!instructions(Mode::Ask, &Role::Normal).contains("worker agent"));
        let reader = instructions(Mode::Ask, &Role::Worker { name: "r".into(), read_only: true });
        assert!(reader.contains("You are read-only") && !reader.contains("mcp__lantern") && !reader.contains("Grep and Glob"));
    }
}
