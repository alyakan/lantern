use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Edits auto-apply; other permission prompts go to the in-app Allow/Deny card.
    Ask,
    /// Claude Code's auto-mode classifier decides.
    Auto,
    /// Claude researches and writes a plan without changing anything; approving it (ExitPlanMode, which goes to the
    /// in-app card) switches the session to Ask or Auto in-band.
    Plan,
    /// Like Ask, plus a debugging loop: hypotheses, temporary logs, the user reproduces (a card in the app), then the
    /// fix and clean-up.
    Debug,
    /// Like Ask, but the work goes one step per message (the incremental-dev skill): the app shows each message as a
    /// page, and Next approves it.
    Steps,
    /// Steps, explained for learning: why each change, the concept behind it, the alternatives.
    Teach,
    /// Step by step for reviewing a pull request (the incremental-pr-review skill): a page per file.
    Review,
}

/// How Step-by-step mode works, appended to Claude Code's system prompt.
pub const STEPS_PROMPT: &str = "You are in Lantern's Step-by-step mode. Follow the user's incremental-dev skill exactly (load it with the Skill tool, `incremental-dev`): frame the task, then plan one step per message, then implement one step per message, and stop after every message to wait for the user's answer. If the skill isn't available, work that way anyway: one step per message, never two, nothing implemented before its plan step is approved.
Lantern shows each of your messages as a page with Previous and Next buttons. The user answers \"Next\" to approve that step only, or tells you what to change; then revise that step and stop again.
Start the text of every message you stop on with exactly one of these headings, as the very first line:
# Frame — <the task in a few words>
# Plan step N — <step title>
# Plan complete — N steps
# Step N of M — <step title>   (implementing plan step N of M)
# Done — <what was built>
Keep each message to the one step its heading names. Lantern shows the step on its page and a discussion under it. When the user asks a question about the current step, suggests something or discusses it, just answer, with no heading at all: the step stays as it is and your answer goes in the discussion. If that leads to a change to the step, end your answer by asking whether to update the step with it, and don't rewrite it until they say yes. When they do (or ask for a change directly), write the complete step again under that same heading: the same format and sections as before, with the change worked in and everything that didn't change kept, so it takes the old version's place on the page. Only a new step gets a new heading.";

/// How Step by step reviews a pull request, appended to Claude Code's system prompt.
pub const REVIEW_PROMPT: &str = "You are in Lantern's Step-by-step Review mode. Follow the user's incremental-pr-review skill exactly (load it with the Skill tool, `incremental-pr-review`): frame the review, then one changed file per message, then the summary, and stop after every message for the user's answer. Fetch GitHub pull requests with the gh CLI (gh pr view, gh pr diff); the PR does not need to be checked out. Never post anything to GitHub.
Lantern shows each of your messages as a page. Start the text of every message you stop on with exactly one of these headings, as the very first line:
# Frame — <the PR's title>
# File N of M — <path> (+added −removed)
# Summary — <files reviewed, findings accepted, findings dropped>
Under a file's heading use the skill's sections exactly (### What changed, ### Findings, ### Notes), with each finding on its own line as: ⚠ line N (blocker|should-fix|nit): <the defect and its concrete consequence>. A clean file's Findings section is exactly None.
The user answers \"Next\", optionally followed by verdicts such as \"Agreed: line 42. Rejected: line 17.\"; a rejected finding is dropped for good. If they ask about the current file, just answer, with no heading: the file's page stays as it is and your answer goes in the discussion under it. Only if they ask you to change your review of the file (drop, add or reword a finding), rewrite the whole file under its same heading. Don't end a message by telling them what to say next (\"Say Next for file 2\"); the page has buttons for that.";

/// Added to STEPS_PROMPT in Teach mode.
pub const TEACH_PROMPT: &str = "
Teach mode: the user is learning from this. In every step, explain the why as well as the what: the concept or pattern behind the change, how it fits the code around it, and what you considered instead and why you didn't choose it. Use short sections and small code excerpts. It is still one step per message.";

/// How Debug mode works, appended to Claude Code's system prompt.
pub const DEBUG_PROMPT: &str = "You are in Lantern's Debug mode. Find the root cause from evidence before changing behaviour. Work in this loop:
1. Restate the bug in a sentence, then list 2-4 concrete hypotheses for its cause, most likely first.
2. Add the smallest temporary diagnostic logging that tells those hypotheses apart. Start every log message with [lantern-debug] and mark each added line or block with a comment containing lantern-debug, so all of it can be found and removed.
3. Trigger the bug. If a command or test you can run reproduces it, run that yourself. If only the user can (clicking through a UI, a device, a browser, an outside service), call the mcp__lantern__reproduce tool with exact steps and where the logs will appear; it waits until they have done it and returns their note (often the logs they saw). Don't end your turn to ask them.
4. Read the evidence: the logs, the note, anything the app wrote. Say which hypotheses it confirms or rules out. If it's still unclear, adjust the logging and reproduce again.
5. Only once the cause is confirmed, fix it at its root. Reproduce again if that's the only way to verify the fix.
6. Remove every trace of the temporary logging (search for lantern-debug), then summarise the root cause, the evidence, and the fix.";

impl Mode {
    /// The value `--permission-mode` and `set_permission_mode` take.
    pub fn cli_name(self) -> &'static str {
        match self {
            Mode::Ask => "acceptEdits",
            Mode::Auto => "auto",
            Mode::Plan => "plan",
            // Debug and Step-by-step run with Ask's permissions; the loop comes from their prompts.
            Mode::Debug | Mode::Steps | Mode::Teach | Mode::Review => "acceptEdits",
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

/// `auto_approve`: in Step by step (Build or Teach), Claude Code's auto mode approves actions instead of the in-app
/// prompts; each step is reviewed as a page anyway. Other modes ignore it.
/// `model`: an alias ("opus", "sonnet", "haiku") or full model id; None leaves Claude Code's own default.
/// `effort`: one of EFFORT_LEVELS; None leaves Claude Code's own default.
pub fn build_args(mode: Mode, auto_approve: bool, resume: Option<&str>, model: Option<&str>, effort: Option<&str>, helper: &HelperConfig) -> Vec<String> {
    let auto = mode == Mode::Auto || (auto_approve && matches!(mode, Mode::Steps | Mode::Teach | Mode::Review));
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push("--permission-mode".into());
    a.push(if auto { "auto" } else { mode.cli_name() }.into());
    // Every mode gets the in-app prompt. Plan mode approves its plan there; in auto mode the classifier decides, but
    // when Claude Code falls back to asking (repeated blocks, an ask rule) a -p run without a prompt tool just denies.
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
    if mode == Mode::Debug {
        a.push("--append-system-prompt".into());
        a.push(DEBUG_PROMPT.into());
        // The reproduce card is its own confirmation; it shouldn't also need approving.
        a.push("--allowedTools".into());
        a.push("mcp__lantern__reproduce".into());
    }
    if matches!(mode, Mode::Steps | Mode::Teach | Mode::Review) {
        a.push("--append-system-prompt".into());
        a.push(match mode {
            Mode::Teach => format!("{STEPS_PROMPT}{TEACH_PROMPT}"),
            Mode::Review => REVIEW_PROMPT.to_string(),
            _ => STEPS_PROMPT.to_string(),
        });
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

#[cfg(test)]
mod tests {
    use super::*;

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
        for mode in [Mode::Ask, Mode::Auto, Mode::Plan, Mode::Debug, Mode::Steps, Mode::Teach, Mode::Review] {
            assert!(!build_args(mode, false, Some("x"), Some("opus"), Some("max"), &helper()).iter().any(|a| a == "--bare"));
        }
    }

    #[test]
    fn mode_deserializes_lowercase() {
        assert_eq!(serde_json::from_str::<Mode>("\"ask\"").unwrap(), Mode::Ask);
        assert_eq!(serde_json::from_str::<Mode>("\"auto\"").unwrap(), Mode::Auto);
        assert_eq!(serde_json::from_str::<Mode>("\"plan\"").unwrap(), Mode::Plan);
    }

    #[test]
    fn debug_mode_asks_like_ask_mode_and_adds_the_loop_and_the_reproduce_tool() {
        let a = build_args(Mode::Debug, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        assert!(value_after(&a, "--append-system-prompt").unwrap().contains("mcp__lantern__reproduce"));
        assert_eq!(value_after(&a, "--allowedTools"), Some("mcp__lantern__reproduce"));
        assert!(!build_args(Mode::Ask, false, None, None, None, &helper()).iter().any(|x| x == "--append-system-prompt"));
    }

    #[test]
    fn step_modes_ask_like_ask_mode_and_add_the_step_loop() {
        let steps = build_args(Mode::Steps, false, None, None, None, &helper());
        assert_eq!(value_after(&steps, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&steps, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
        let prompt = value_after(&steps, "--append-system-prompt").unwrap();
        assert!(prompt.contains("incremental-dev") && prompt.contains("# Plan step N") && !prompt.contains("Teach mode"));
        let teach = build_args(Mode::Teach, false, None, None, None, &helper());
        assert!(value_after(&teach, "--append-system-prompt").unwrap().contains("Teach mode"));
        assert_eq!(serde_json::from_str::<Mode>("\"steps\"").unwrap(), Mode::Steps);
        assert_eq!(serde_json::from_str::<Mode>("\"teach\"").unwrap(), Mode::Teach);
    }

    #[test]
    fn step_modes_can_auto_approve_but_keep_their_loop_and_other_modes_ignore_it() {
        for mode in [Mode::Steps, Mode::Teach] {
            let a = build_args(mode, true, None, None, None, &helper());
            assert_eq!(value_after(&a, "--permission-mode"), Some("auto"));
            assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
            assert!(value_after(&a, "--append-system-prompt").unwrap().contains("incremental-dev"));
        }
        let ask = build_args(Mode::Ask, true, None, None, None, &helper());
        assert_eq!(value_after(&ask, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&ask, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
    }

    #[test]
    fn review_mode_follows_the_pr_review_skill_a_page_per_file() {
        let a = build_args(Mode::Review, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("acceptEdits"));
        let prompt = value_after(&a, "--append-system-prompt").unwrap();
        assert!(prompt.contains("incremental-pr-review") && prompt.contains("# File N of M") && prompt.contains("Never post"));
        assert_eq!(serde_json::from_str::<Mode>("\"review\"").unwrap(), Mode::Review);
    }

    #[test]
    fn plan_mode_plans_and_asks_through_the_app() {
        let a = build_args(Mode::Plan, false, None, None, None, &helper());
        assert_eq!(value_after(&a, "--permission-mode"), Some("plan"));
        assert_eq!(value_after(&a, "--permission-prompt-tool"), Some("mcp__lantern__approve"));
    }
}
