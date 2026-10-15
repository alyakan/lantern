//! Who is on the other end of a socket: whether a process descends from another one. It is how the orchestra tools know a
//! call comes from the main agent's own helper and not from some other process of the same user (a worker's shell, say),
//! which can read everything a secret passed on a command line or in a file would be in.

/// The parent of `pid`, if it is running.
#[cfg(target_os = "macos")]
fn parent_of(pid: u32) -> Option<u32> {
    // SAFETY: `info` is plain data the kernel fills in, and the size passed is its own.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let got = libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        (got == size).then_some(info.pbi_ppid)
    }
}

#[cfg(not(target_os = "macos"))]
fn parent_of(_pid: u32) -> Option<u32> {
    None
}

/// The executable file `pid` is running, if it is running.
#[cfg(target_os = "macos")]
pub fn exe_of(pid: u32) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; 4096];
    // SAFETY: the buffer is ours, and its length is passed.
    let n = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    (n > 0).then(|| std::path::PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..n as usize])))
}

#[cfg(not(target_os = "macos"))]
pub fn exe_of(_pid: u32) -> Option<std::path::PathBuf> {
    None
}

/// `pid` is running the program `exe` (the app's own executable is what the helper is: `lantern --permission-helper`).
/// A shell with a single command runs it in place of itself, so a command claude ran can be its direct child too; it is
/// another program, and so not a helper.
pub fn runs_program(pid: u32, exe: &std::path::Path) -> bool {
    let real = |p: &std::path::Path| std::fs::canonicalize(p).ok();
    match (exe_of(pid).and_then(|p| real(&p)), real(exe)) {
        (Some(theirs), Some(wanted)) => theirs == wanted,
        _ => false,
    }
}

/// `pid` is running this very program.
#[cfg(test)]
pub fn runs_this_program(pid: u32) -> bool {
    std::env::current_exe().is_ok_and(|exe| runs_program(pid, &exe))
}

/// `pid` is `ancestor` or one of the processes it started, directly or through others. A process that has gone has no
/// parent to follow, so it counts as no one's descendant.
pub fn descends_from(pid: u32, ancestor: u32) -> bool {
    let mut current = pid;
    // A process tree this deep is not one claude started; the bound also keeps a cycle from looping.
    for _ in 0..64 {
        if current == ancestor {
            return true;
        }
        match parent_of(current) {
            Some(parent) if parent > 1 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

/// `parent` started `pid` itself, not through anything in between. This is what tells claude's own helper (which claude
/// starts directly) from a command the main agent ran in a shell, which is a grandchild at best.
pub fn is_child_of(pid: u32, parent: u32) -> bool {
    parent > 1 && parent_of(pid) == Some(parent)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn a_process_is_known_by_its_executable() {
        let me = std::process::id();
        assert_eq!(std::fs::canonicalize(exe_of(me).unwrap()).unwrap(), std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap());
        assert!(runs_this_program(me));
        let mut child = std::process::Command::new("sleep").arg("5").stdin(std::process::Stdio::null()).spawn().unwrap();
        assert!(!runs_this_program(child.id()), "another program passed for this one");
        assert!(exe_of(child.id()).unwrap().ends_with("sleep"));
        let _ = (child.kill(), child.wait());
        assert!(!runs_this_program(999_999));
    }

    #[test]
    fn only_a_direct_child_is_a_child() {
        let me = std::process::id();
        let mut child = std::process::Command::new("sleep").arg("5").stdin(std::process::Stdio::null()).spawn().unwrap();
        assert!(is_child_of(child.id(), me));
        assert!(!is_child_of(me, child.id()));
        assert!(!is_child_of(child.id(), 1));
        assert!(!is_child_of(me, me));
        // A grandchild, through a shell, is not.
        let mut shell = std::process::Command::new("sh").args(["-c", "sleep 5 & echo $!; wait"]).stdout(std::process::Stdio::piped()).stdin(std::process::Stdio::null()).spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(shell.stdout.take().unwrap()), &mut line).unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        assert!(is_child_of(grandchild, shell.id()));
        assert!(!is_child_of(grandchild, me));
        assert!(descends_from(grandchild, me));
        let _ = (child.kill(), child.wait(), shell.kill(), shell.wait());
        let _ = std::process::Command::new("kill").arg(grandchild.to_string()).status();
    }
    use std::process::{Command, Stdio};

    #[test]
    fn a_process_descends_from_itself_and_from_whatever_started_it() {
        let me = std::process::id();
        assert!(descends_from(me, me));
        let mut child = Command::new("sleep").arg("5").stdin(Stdio::null()).spawn().unwrap();
        assert!(descends_from(child.id(), me));
        assert!(!descends_from(me, child.id()), "a parent descends from its child");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn a_grandchild_counts_and_an_unrelated_process_does_not() {
        let me = std::process::id();
        // A shell that starts a sleeper and prints its pid: the sleeper is a grandchild of this test.
        let mut shell = Command::new("sh").args(["-c", "sleep 5 & echo $!; wait"]).stdout(Stdio::piped()).stdin(Stdio::null()).spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(shell.stdout.take().unwrap()), &mut line).unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        assert!(descends_from(grandchild, me));
        assert!(descends_from(grandchild, shell.id()));
        // Another, unrelated child of this test is not a descendant of the shell.
        let mut other = Command::new("sleep").arg("5").stdin(Stdio::null()).spawn().unwrap();
        assert!(!descends_from(other.id(), shell.id()));
        assert!(!descends_from(grandchild, other.id()));
        // launchd, and a pid that isn't running.
        assert!(!descends_from(1, me));
        assert!(!descends_from(999_999, me));
        let _ = other.kill();
        let _ = other.wait();
        let _ = shell.kill();
        let _ = shell.wait();
        let _ = Command::new("kill").arg(grandchild.to_string()).status();
    }
}
