use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Edits auto-apply; other permission prompts go to the in-app Allow/Deny card. Plan mode, which is gone, reopens
    /// as this.
    #[serde(alias = "plan")]
    Ask,
    /// Claude Code's auto-mode classifier decides.
    Auto,
    /// One page per message, in a flavour Claude suggests and the user accepts: Build, Learn, Review or Debug (see
    /// STEPS_PROMPT). Debug, Teach and Review used to be modes of their own, and reopen as this.
    #[serde(alias = "debug", alias = "teach", alias = "review")]
    Steps,
}

/// How Step-by-step mode works, appended to Claude Code's system prompt: the page loop, then each flavour.
pub const STEPS_PROMPT: &str = "You are in Lantern's Step-by-step mode. You work one page at a time: every message you stop on is a page the user reads, and you stop after each one to wait for their answer. Never do two pages' work in one message.
Step by step has four flavours: Build, Learn, Review and Debug. Before you start one, ask: stop on a message whose very first line is
# Switch to <Build|Learn|Review|Debug> — <why it fits, in a few words>
with at most a sentence or two under it. Lantern shows it as a card with buttons. Start that flavour, with its first page, only when the user answers \"Start <Flavour>.\" or agrees; \"Stay in <Flavour>.\" means carry on as you were, and \"Start <another flavour>.\" means that one instead. Ask for the first task in the chat too, and again whenever a request fits another flavour better than the current one (a crash reported during a Build is Debug; \"look at PR 12\" is Review). Suggest Learn only when the user says they want to learn or understand something: for a job, an interview, a test, a codebase that's new to them. A message that starts with \"[Lantern: this chat switched to <Flavour>…]\" means the user picked that flavour themselves: work in it from then on, without asking.
Start the text of every page with exactly one of its flavour's headings as the very first line. When the user asks about the current page, suggests something or discusses it, just answer, with no heading at all: the page stays as it is and your answer goes in the discussion under it. If that leads to a change, end your answer by asking whether to update the page, and don't rewrite it until they say yes. When they do (or ask for a change directly), write the complete page again under the same heading: the same format and sections, with the change worked in and everything that didn't change kept, so it takes the old version's place. Only a new page gets a new heading. Don't end a message by telling the user what to say next (\"Say Next for step 2\"); the page has buttons for that.

Build: follow the user's incremental-dev skill exactly (load it with the Skill tool, `incremental-dev`); if it isn't available, work that way anyway: frame the task, plan one step per page, then implement one step per page, nothing implemented before its plan step is approved. The user answers \"Next\" to approve a page. Headings:
# Frame — <the task in a few words>
# Plan step N — <step title>
# Plan complete — N steps
# Step N of M — <step title>   (implementing plan step N of M)
# Done — <what was built>

Learn: Build's pages and headings, for a user who is learning from this. In every page, explain the why as well as the what: the concept or pattern behind the change, how it fits the code around it, and what you considered instead and why you didn't choose it. Use short sections and small code excerpts. It is still one step per page.

Review: follow the user's incremental-pr-review skill exactly (load it with the Skill tool, `incremental-pr-review`): frame the review, then one changed file per page, then the summary. Fetch GitHub pull requests with the gh CLI (gh pr view, gh pr diff); the PR does not need to be checked out. Never post anything to GitHub. Headings:
# Frame — <the PR's title>
# File N of M — <path> (+added −removed)
# Summary — <files reviewed, findings accepted, findings dropped>
Under a file's heading use the skill's sections exactly (### What changed, ### Findings, ### Notes), with each finding on its own line as: ⚠ line N (blocker|should-fix|nit): <the defect and its concrete consequence>. A clean file's Findings section is exactly None. The user answers \"Next\", optionally followed by verdicts such as \"Agreed: line 42. Rejected: line 17.\"; a rejected finding is dropped for good. Only if they ask you to change your review of a file (drop, add or reword a finding), rewrite the whole file under its same heading.

Debug: find the root cause from evidence before changing behaviour. Headings:
# Frame — <the bug in a few words>: restate the bug in a sentence, then list 2-4 concrete hypotheses for its cause, most likely first.
# Evidence N — <what this round tells apart>: add the smallest temporary diagnostic logging that tells the hypotheses apart. Start every log message with [lantern-debug] and mark each added line or block with a comment containing lantern-debug, so all of it can be found and removed. Then trigger the bug: if a command or test you can run reproduces it, run that yourself; if only the user can (clicking through a UI, a device, a browser, an outside service), call the mcp__lantern__reproduce tool with exact steps and where the logs will appear. It waits until they have done it and returns their note (often the logs they saw); don't end your turn to ask them. Say which hypotheses the evidence confirms or rules out. If it's still unclear, the next round is another Evidence page.
# Fix — <the change>: only once the cause is confirmed, fix it at its root. Reproduce again if that's the only way to verify the fix.
# Done — <the root cause>: remove every trace of the temporary logging (search for lantern-debug), then summarise the root cause, the evidence, and the fix.";

impl Mode {
    /// The value `--permission-mode` takes.
    pub fn cli_name(self) -> &'static str {
        match self {
            Mode::Ask => "acceptEdits",
            Mode::Auto => "auto",
            // Step by step runs with Ask's permissions (or auto, when auto-approve is on); the loop comes from its prompt.
            Mode::Steps => "acceptEdits",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HelperConfig {
    /// Path of this app's executable, run by claude with `--permission-helper`.
    pub exe: String,
    /// Unix socket the helper connects to.
    pub socket: String,
}

/// A model alias or id: letters, digits, '-', '.', and a bracketed suffix like "[1m]". Never starts with '-'.
pub fn valid_model(m: &str) -> bool {
    (1..=64).contains(&m.len()) && m.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && m.chars().all(|c| c.is_ascii_alphanumeric() || "-.[]".contains(c))
}

/// The thinking-effort levels `--effort` takes.
pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub fn valid_effort(e: &str) -> bool {
    EFFORT_LEVELS.contains(&e)
}

/// `auto_approve`: in Step by step, Claude Code's auto mode approves actions instead of the in-app prompts; each page is
/// reviewed anyway. Other modes ignore it.
/// `model`: an alias ("opus", "sonnet", "haiku") or full model id; None leaves Claude Code's own default.
/// `effort`: one of EFFORT_LEVELS; None leaves Claude Code's own default.
pub fn build_args(mode: Mode, auto_approve: bool, resume: Option<&str>, model: Option<&str>, effort: Option<&str>, helper: &HelperConfig) -> Vec<String> {
    let steps = mode == Mode::Steps;
    let auto = mode == Mode::Auto || (auto_approve && steps);
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push("--permission-mode".into());
    a.push(if auto { "auto" } else { mode.cli_name() }.into());
    // Every mode gets Lantern's MCP server and the in-app prompt: in auto mode the classifier decides, but when Claude
    // Code falls back to asking (repeated blocks, an ask rule) a -p run without a prompt tool just denies. In Step by
    // step the server also has Debug's reproduce card.
    {
        let cfg = serde_json::json!({"mcpServers": {"lantern": {
            "type": "stdio",
            "command": helper.exe,
            "args": ["--permission-helper"],
            "env": {"LANTERN_SOCKET": helper.socket}
        }}});
        a.push("--mcp-config".into());
        a.push(cfg.to_string());
        a.push("--permission-prompt-tool".into());
        a.push("mcp__lantern__approve".into());
    }
    if steps {
        a.push("--append-system-prompt".into());
        a.push(STEPS_PROMPT.into());
        // The reproduce card is its own confirmation; it shouldn't also need approving.
        a.push("--allowedTools".into());
        a.push("mcp__lantern__reproduce".into());
    }
    if let Some(id) = resume {
        a.push("--resume".into());
        a.push(id.into());
    }
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.into());
    }
    if let Some(e) = effort {
        a.push("--effort".into());
        a.push(e.into());
    }
    a
}

/// The harness's flags beyond model and effort: the advisor Claude consults (`--advisor`, which `claude --help` doesn't
/// list). The subagents' model goes in the environment instead (see Session::spawn).
pub fn harness_args(advisor: Option<&str>) -> Vec<String> {
    advisor.map(|a| vec!["--advisor".to_string(), a.to_string()]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_advisor_is_a_flag_only_when_chosen() {
        assert_eq!(harness_args(Some("opus")), vec!["--advisor", "opus"]);
        assert!(harness_args(None).is_empty());
    }

    fn helper() -> HelperConfig {
        HelperConfig { exe: "/Apps/lantern".into(), socket: "/tmp/a.sock".into() }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn ask_mode_uses_accept_edits_and_permission_helper() {
        let a = build_args(Mode::Ask, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--input-format"), Some("stream-json"));
        assert_eq!(value_after(&a, "--output-format"), Some("stream-json"));
        assert!(a.contains(&"-p".to_string()) && a.contains(&"--verbose".to_string()) && a.contains(&"--include-partial-messages".to_string()));
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        let cfg: serde_json::Value = serde_json::from_str(value_after(&a, "--mcp-config").unwrap()).unwrap();
        let server = &cfg["mcpServers"]["lantern"];
        assert_eq!(server["command"], "/Apps/lantern");
        assert_eq!(server["args"][0], "--permission-helper");
        assert_eq!(server["env"]["LANTERN_SOCKET"], "/tmp/a.sock");
    }

    /// The classifier approves or blocks; when Claude Code falls back to asking (repeated blocks, an ask rule), the
    /// question has to reach the app, or the action is denied without the user ever seeing it.
    #[test]
    fn auto_mode_keeps_the_in_app_prompt_for_when_auto_mode_asks() {
        let a = build_args(Mode::Auto, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("auto"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        assert!(a.iter().any(|x| x == "--mcp-config"));
    }

    #[test]
    fn resume_is_appended() {
        let a = build_args(Mode::Auto, false, Some("sess-1"), None, None, &helper());
        assert_eq!(value_after(&a, "--resume"), Some("sess-1"));
    }

    #[test]
    fn model_is_passed_only_when_chosen() {
        assert_eq!(value_after(&build_args(Mode::Ask, false, None, Some("sonnet"), None, &helper()), "--model"), Some("sonnet"));
        assert!(!build_args(Mode::Ask, false, None, None, None, &helper()).iter().any(|a| a == "--model"));
    }

    #[test]
    fn effort_is_passed_only_when_chosen_and_must_be_a_level() {
        assert_eq!(value_after(&build_args(Mode::Ask, false, None, None, Some("xhigh"), &helper()), "--effort"), Some("xhigh"));
        assert!(!build_args(Mode::Ask, false, None, None, None, &helper()).iter().any(|a| a == "--effort"));
        assert!(valid_effort("max") && valid_effort("low"));
        assert!(!valid_effort("--bare") && !valid_effort("HIGH") && !valid_effort(""));
    }

    /// The model reaches claude's argv, so only alias- or id-shaped names are accepted.
    #[test]
    fn model_names_are_validated() {
        for ok in ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-haiku-4-5-20251001", "opus[1m]"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "--bare", "opus sonnet", "a;b", &"x".repeat(100)] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn never_bare() {
        for mode in [Mode::Ask, Mode::Auto, Mode::Steps] {
            assert!(!build_args(mode, false, Some("x"), Some("opus"), Some("max"), &helper()).iter().any(|a| a == "--bare"));
        }
    }

    #[test]
    fn mode_deserializes_lowercase_and_old_modes_map_onto_the_three() {
        assert_eq!(serde_json::from_str::<Mode>("\"ask\"").unwrap(), Mode::Ask);
        assert_eq!(serde_json::from_str::<Mode>("\"auto\"").unwrap(), Mode::Auto);
        assert_eq!(serde_json::from_str::<Mode>("\"steps\"").unwrap(), Mode::Steps);
        assert_eq!(serde_json::from_str::<Mode>("\"plan\"").unwrap(), Mode::Ask);
        for old in ["debug", "teach", "review"] {
            assert_eq!(serde_json::from_str::<Mode>(&format!("\"{old}\"")).unwrap(), Mode::Steps, "{old}");
        }
        assert_eq!(serde_json::to_string(&Mode::Steps).unwrap(), "\"steps\"");
    }

    #[test]
    fn step_by_step_asks_like_ask_mode_and_adds_the_page_loop_with_every_flavour() {
        let a = build_args(Mode::Steps, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        assert_eq!(value_after(&a, "--allowedTools"), Some("mcp__lantern__reproduce"));
        let prompt = value_after(&a, "--append-system-prompt").unwrap();
        for part in ["# Switch to", "incremental-dev", "# Plan step N", "Learn:", "incremental-pr-review", "# File N of M", "Never post", "# Evidence N", "mcp__lantern__reproduce", "lantern-debug", "[Lantern: this chat switched to"] {
            assert!(prompt.contains(part), "{part}");
        }
        assert!(!build_args(Mode::Ask, false, None, None, None, &helper()).iter().any(|x| x == "--append-system-prompt" || x == "--allowedTools"));
    }

    #[test]
    fn step_by_step_can_auto_approve_and_keeps_the_reproduce_card() {
        let a = build_args(Mode::Steps, true, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("auto"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        assert!(a.iter().any(|x| x == "--mcp-config"));
        assert_eq!(value_after(&a, "--allowedTools"), Some("mcp__lantern__reproduce"));
        let ask = build_args(Mode::Ask, true, None, None, None, &helper());
        assert_eq!(value_after(&ask, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&ask, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
    }
}
