//! Agent roles: a ready-made brief, model, place to work and access for an agent (a Reviewer, a Builder…). The built-in
//! ones are in src/lib/roles.json, which the window reads too; the user's own are per project and kept by the window,
//! which tells each Lead of that project's team about them (see `Orchestra::set_roles`).

use serde::{Deserialize, Serialize};

/// Where the brief puts the user's (or the Lead's) task.
pub const TASK_MARK: &str = "{task}";
const MAX_ROLES: usize = 40;
const MAX_BRIEF: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDef {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// What the agent is told, with `{task}` where its task goes.
    pub brief: String,
    pub model: String,
    /// "worktree" or "shared".
    pub isolation: String,
    /// It may read but not edit: its edit tools are switched off (see args::launch_args).
    pub read_only: bool,
}

/// What an agent card and the list of agents say about its role, and what a restored agent is started with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleTag {
    pub id: String,
    pub label: String,
    pub read_only: bool,
}

impl RoleTag {
    /// A tag the window sent, checked: its label is shown on the card and in notes to the Lead.
    pub fn checked(self) -> Result<RoleTag, String> {
        let label = self.label.trim().to_string();
        if !valid_id(&self.id) || label.is_empty() || label.chars().count() > 60 || label.chars().any(char::is_control) {
            return Err("That role isn't usable.".into());
        }
        Ok(RoleTag { label, ..self })
    }
}

impl RoleDef {
    pub fn tag(&self) -> RoleTag {
        RoleTag { id: self.id.clone(), label: self.label.clone(), read_only: self.read_only }
    }

    /// The brief with `task` in its place (at the end when the brief has no place for it).
    pub fn brief_for(&self, task: &str) -> String {
        if self.brief.contains(TASK_MARK) {
            self.brief.replace(TASK_MARK, task)
        } else {
            format!("{}\n\n{task}", self.brief)
        }
    }
}

pub fn builtin() -> Vec<RoleDef> {
    serde_json::from_str(include_str!("../../src/lib/roles.json")).expect("src/lib/roles.json is a list of roles")
}

/// A role id: lowercase letters, digits and dashes, never starting with a dash.
pub fn valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The user's own roles as the window sent them, checked: they end up on claude's command line and in a Lead's tool calls.
pub fn checked_custom(roles: Vec<RoleDef>) -> Result<Vec<RoleDef>, String> {
    if roles.len() > MAX_ROLES {
        return Err(format!("At most {MAX_ROLES} roles."));
    }
    let builtin = builtin();
    let mut seen: Vec<&str> = Vec::new();
    for r in &roles {
        let name = r.label.trim();
        if !valid_id(&r.id) || builtin.iter().any(|b| b.id == r.id) || seen.contains(&r.id.as_str()) {
            return Err(format!("{:?} is not a usable role id.", r.id));
        }
        if name.is_empty() || name.chars().count() > 60 || r.description.chars().count() > 300 {
            return Err(format!("Role {:?} needs a name of up to 60 characters.", r.id));
        }
        if r.brief.trim().is_empty() || r.brief.len() > MAX_BRIEF {
            return Err(format!("Role {:?} needs a brief of up to {MAX_BRIEF} characters.", r.id));
        }
        if !crate::args::valid_model(&r.model) {
            return Err(format!("{:?} is not a model name.", r.model));
        }
        if !["worktree", "shared"].contains(&r.isolation.as_str()) {
            return Err("`isolation` is \"worktree\" or \"shared\".".into());
        }
        seen.push(&r.id);
    }
    Ok(roles)
}

/// What the Lead's spawn_agent says of the built-in roles.
pub fn builtin_summary() -> String {
    builtin()
        .iter()
        .map(|r| format!("{} ({}; {}; {})", r.id, r.description.trim_end_matches('.'), r.isolation, if r.read_only { "read only" } else { "can edit" }))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(id: &str) -> RoleDef {
        RoleDef { id: id.into(), label: "API reviewer".into(), description: String::new(), brief: "Review the API: {task}".into(), model: "sonnet".into(), isolation: "shared".into(), read_only: true }
    }

    #[test]
    fn the_built_in_roles_are_the_five_the_window_offers_and_the_readers_cannot_edit() {
        let roles = builtin();
        assert_eq!(roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["builder", "reviewer", "qa", "docs", "security"]);
        let by = |id: &str| roles.iter().find(|r| r.id == id).unwrap().clone();
        assert!(by("reviewer").read_only && by("security").read_only);
        assert!(!by("builder").read_only && !by("qa").read_only && !by("docs").read_only);
        for r in &roles {
            assert!(valid_id(&r.id) && crate::args::valid_model(&r.model), "{}", r.id);
            assert!(["worktree", "shared"].contains(&r.isolation.as_str()), "{}", r.id);
            assert!(r.brief.contains(TASK_MARK) && r.brief.to_lowercase().contains("report in exactly this format"), "{}", r.id);
            // A reader has only the tools that read (see args::READ_ONLY_TOOLS), so its brief never sends it to run commands.
            if r.read_only {
                let brief = r.brief.to_lowercase();
                assert!(brief.contains("cannot run commands") && !brief.contains("git diff") && !brief.contains("git log") && !brief.contains("run commands that only read"), "{}", r.id);
            }
            // A reader works where it can read what the others made: not in a worktree of its own.
            assert_eq!(r.read_only, r.isolation == "shared", "{}", r.id);
        }
    }

    #[test]
    fn a_tag_from_the_window_is_checked_and_its_label_trimmed() {
        let tag = |id: &str, label: &str| RoleTag { id: id.into(), label: label.into(), read_only: true };
        assert_eq!(tag("reviewer", "  Reviewer ").checked().unwrap().label, "Reviewer");
        for (id, label) in [("Bad Id", "x"), ("a", "  "), ("a", &"x".repeat(61)), ("a", "line\nbreak")] {
            assert!(tag(id, label).checked().is_err(), "{id} {label}");
        }
    }

    #[test]
    fn the_task_goes_where_the_brief_has_a_place_for_it_and_at_the_end_otherwise() {
        let r = custom("api");
        assert_eq!(r.brief_for("the login form"), "Review the API: the login form");
        let plain = RoleDef { brief: "Review carefully.".into(), ..r };
        assert_eq!(plain.brief_for("the login form"), "Review carefully.\n\nthe login form");
    }

    #[test]
    fn a_custom_role_is_checked_before_it_is_kept() {
        assert!(checked_custom(vec![custom("api-reviewer")]).is_ok());
        for bad in ["", "Api", "-api", "api reviewer", "api;rm", "reviewer", "qa"] {
            assert!(checked_custom(vec![custom(bad)]).unwrap_err().contains("not a usable role id"), "{bad}");
        }
        assert!(checked_custom(vec![custom("a"), custom("a")]).is_err());
        assert!(checked_custom(vec![RoleDef { model: "--bare".into(), ..custom("a") }]).unwrap_err().contains("not a model name"));
        assert!(checked_custom(vec![RoleDef { isolation: "moon".into(), ..custom("a") }]).unwrap_err().contains("isolation"));
        assert!(checked_custom(vec![RoleDef { label: "  ".into(), ..custom("a") }]).is_err());
        assert!(checked_custom(vec![RoleDef { brief: " ".into(), ..custom("a") }]).is_err());
        assert!(checked_custom(vec![RoleDef { brief: "x".repeat(MAX_BRIEF + 1), ..custom("a") }]).is_err());
        assert!(checked_custom((0..=MAX_ROLES).map(|i| custom(&format!("r{i}"))).collect()).is_err());
    }
}
