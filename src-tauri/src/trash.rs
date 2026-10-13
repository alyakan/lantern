//! Moving a file or folder to the Trash instead of deleting it, so a delete can be undone from Finder.

use std::path::{Path, PathBuf};

/// Moves `path` into the user's Trash (`~/.Trash`) and returns where it went. A name already in the Trash gets a
/// number ("notes 2.md"), as Finder does. The Trash of another volume isn't used: a path on one can't be moved here.
pub fn move_to_trash(path: &Path) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("There is no home folder to find the Trash in.")?;
    trash_into(path, &Path::new(&home).join(".Trash"))
}

/// `move_to_trash` with the Trash folder given.
pub fn trash_into(path: &Path, trash: &Path) -> Result<PathBuf, String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Err(format!("{} doesn't exist.", path.display()));
    }
    let name = path.file_name().ok_or_else(|| format!("{} can't be moved to the Trash.", path.display()))?;
    std::fs::create_dir_all(trash).map_err(|e| format!("Could not open the Trash: {e}"))?;
    let target = free_name(trash, Path::new(name));
    std::fs::rename(path, &target).map_err(|e| match e.raw_os_error() {
        // EXDEV: the file is on another volume, which has its own Trash.
        Some(18) => format!("{} is on another volume, so it can't be moved to the Trash from here.", path.display()),
        _ => format!("Could not move {} to the Trash: {e}", path.display()),
    })?;
    Ok(target)
}

/// `name` in `dir`, or "stem 2.ext", "stem 3.ext"… if that is taken.
fn free_name(dir: &Path, name: &Path) -> PathBuf {
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|candidate| std::fs::symlink_metadata(candidate).is_err())
        .expect("an unbounded range has a free name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_goes_to_the_trash_and_keeps_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let (file, trash) = (dir.path().join("notes.md"), dir.path().join("trash"));
        std::fs::write(&file, "hello").unwrap();
        let moved = trash_into(&file, &trash).unwrap();
        assert!(!file.exists());
        assert_eq!(moved, trash.join("notes.md"));
        assert_eq!(std::fs::read_to_string(moved).unwrap(), "hello");
    }

    #[test]
    fn a_name_already_in_the_trash_gets_a_number() {
        let dir = tempfile::tempdir().unwrap();
        let trash = dir.path().join("trash");
        let mut moved = vec![];
        for body in ["one", "two", "three"] {
            let file = dir.path().join("notes.md");
            std::fs::write(&file, body).unwrap();
            moved.push(trash_into(&file, &trash).unwrap());
        }
        let names: Vec<_> = moved.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["notes.md", "notes 2.md", "notes 3.md"]);
        assert_eq!(std::fs::read_to_string(&moved[1]).unwrap(), "two");
    }

    #[test]
    fn a_folder_moves_whole_and_a_missing_path_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, trash) = (dir.path().join("skill"), dir.path().join("trash"));
        std::fs::create_dir_all(folder.join("sub")).unwrap();
        std::fs::write(folder.join("sub/SKILL.md"), "x").unwrap();
        let moved = trash_into(&folder, &trash).unwrap();
        assert!(moved.join("sub/SKILL.md").exists());
        assert!(trash_into(&dir.path().join("nope"), &trash).is_err());
    }

    #[test]
    fn a_symlink_is_moved_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let (target, link, trash) = (dir.path().join("real.txt"), dir.path().join("link.txt"), dir.path().join("trash"));
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        trash_into(&link, &trash).unwrap();
        assert!(!link.exists() && target.exists());
    }
}
