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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
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
