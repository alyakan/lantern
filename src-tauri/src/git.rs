use std::path::Path;

/// Current branch of the repository at `folder`, read from `.git/HEAD` without spawning git.
/// Returns a short commit hash for a detached HEAD, and None when the folder isn't a plain git checkout.
pub fn current_branch(folder: &Path) -> Option<String> {
    let head = std::fs::read_to_string(folder.join(".git").join("HEAD")).ok()?;
    parse_head(&head)
}

fn parse_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        return reference.strip_prefix("refs/heads/").or(Some(reference)).map(String::from);
    }
    (head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head[..7].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_detached_head() {
        assert_eq!(parse_head("ref: refs/heads/feat/new-thing\n").as_deref(), Some("feat/new-thing"));
        assert_eq!(parse_head("5909c1c8a1b2c3d4e5f60718293a4b5c6d7e8f90\n").as_deref(), Some("5909c1c"));
        assert_eq!(parse_head("garbage"), None);
    }

    #[test]
    fn reads_head_from_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(current_branch(dir.path()), None);
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(current_branch(dir.path()).as_deref(), Some("main"));
    }
}
