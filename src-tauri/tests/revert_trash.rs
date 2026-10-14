//! A revert that creates a file's removal goes to the real Trash function, which finds the Trash under HOME. This lives in
//! its own test binary: HOME is set for the whole process, and the unit tests read it.

use lantern_lib::revert::{apply, Status};

#[test]
fn a_created_file_is_moved_into_the_home_trash() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::fs::write(project.path().join("notes.md"), "draft\n").unwrap();

    let out = apply(project.path(), "notes.md", None, Some("draft\n"), &lantern_lib::trash::move_to_trash);

    assert_eq!(out.status, Status::Trashed);
    assert!(!project.path().join("notes.md").exists());
    assert_eq!(std::fs::read_to_string(home.path().join(".Trash/notes.md")).unwrap(), "draft\n");
}
