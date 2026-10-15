//! Keeping the Mac awake while Claude works, so a long turn isn't cut short by the Mac going to sleep when the user walks
//! away. macOS holds an idle-sleep assertion for as long as a `caffeinate` process runs, so that's all this does: start
//! one while anything is working, end it when nothing is. Only idle system sleep is prevented (`-i`): the display may
//! still sleep, and closing the lid still sleeps the Mac.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Something that keeps the Mac awake for as long as it exists. Dropping it lets the Mac sleep again.
pub trait Hold: Send {
    /// It is still holding (a `caffeinate` somebody killed isn't).
    fn alive(&mut self) -> bool;
}

/// Starts a hold. None when it couldn't be started (the Mac then sleeps as usual; the next update tries again).
pub type Spawner = Box<dyn Fn() -> Option<Box<dyn Hold>> + Send + Sync>;

/// `caffeinate -i -w <pid>`: holds the assertion until it is killed, or until the process `-w` names (Lantern) is gone,
/// so even a crash or a force quit can't leave the Mac held awake.
struct Caffeinate(Child);

impl Hold for Caffeinate {
    fn alive(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }
}

impl Drop for Caffeinate {
    fn drop(&mut self) {
        let _ = self.0.kill();
        // Reaped, so it doesn't linger as a zombie until Lantern exits.
        let _ = self.0.wait();
    }
}

/// The real thing: macOS's own `caffeinate`, tied to this process.
pub fn caffeinate() -> Spawner {
    Box::new(|| {
        let child = Command::new("/usr/bin/caffeinate").args(["-i", "-w", &std::process::id().to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok()?;
        Some(Box::new(Caffeinate(child)) as Box<dyn Hold>)
    })
}

/// The one hold Lantern keeps, and how to start it.
pub struct Awake {
    spawn: Spawner,
    hold: Mutex<Option<Box<dyn Hold>>>,
}

impl Awake {
    pub fn new(spawn: Spawner) -> Self {
        Self { spawn, hold: Mutex::new(None) }
    }

    /// The window's word on it: `working` (any chat or agent is) and `allowed` (the setting). One hold while both are
    /// true, however many chats work; none otherwise. A hold that died on its own is started again.
    pub fn update(&self, working: bool, allowed: bool) {
        let mut hold = self.hold.lock().unwrap_or_else(|e| e.into_inner());
        if !(working && allowed) {
            *hold = None;
            return;
        }
        if hold.as_mut().is_some_and(|h| h.alive()) {
            return;
        }
        *hold = (self.spawn)();
    }

    /// Lantern is exiting: lets go at once.
    pub fn stop(&self) {
        self.update(false, false);
    }

    /// The Mac is being held awake right now.
    pub fn holding(&self) -> bool {
        self.hold.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}

impl Default for Awake {
    fn default() -> Self {
        Self::new(caffeinate())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A fake hold that counts how many were started and how many were let go of.
    struct Fake {
        alive: Arc<AtomicBool>,
        ended: Arc<AtomicUsize>,
    }

    impl Hold for Fake {
        fn alive(&mut self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.ended.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Probe {
        started: Arc<AtomicUsize>,
        ended: Arc<AtomicUsize>,
        alive: Arc<AtomicBool>,
        awake: Awake,
    }

    fn probe(fails: bool) -> Probe {
        let (started, ended, alive) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(true)));
        let (s, e, a) = (started.clone(), ended.clone(), alive.clone());
        let awake = Awake::new(Box::new(move || {
            if fails {
                return None;
            }
            s.fetch_add(1, Ordering::SeqCst);
            a.store(true, Ordering::SeqCst);
            Some(Box::new(Fake { alive: a.clone(), ended: e.clone() }) as Box<dyn Hold>)
        }));
        Probe { started, ended, alive, awake }
    }

    #[test]
    fn starts_once_however_many_chats_work() {
        let p = probe(false);
        for _ in 0..4 {
            p.awake.update(true, true);
        }
        assert_eq!(p.started.load(Ordering::SeqCst), 1);
        assert!(p.awake.holding());
    }

    #[test]
    fn stops_when_the_last_one_finishes() {
        let p = probe(false);
        p.awake.update(true, true);
        p.awake.update(false, true);
        assert_eq!(p.ended.load(Ordering::SeqCst), 1);
        assert!(!p.awake.holding());
        // Work starting again holds again, once.
        p.awake.update(true, true);
        assert_eq!(p.started.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn does_not_start_when_the_setting_is_off() {
        let p = probe(false);
        p.awake.update(true, false);
        assert_eq!(p.started.load(Ordering::SeqCst), 0);
        assert!(!p.awake.holding());
    }

    #[test]
    fn turning_the_setting_off_lets_go_mid_work() {
        let p = probe(false);
        p.awake.update(true, true);
        p.awake.update(true, false);
        assert_eq!(p.ended.load(Ordering::SeqCst), 1);
        assert!(!p.awake.holding());
    }

    #[test]
    fn idle_with_nothing_held_starts_nothing() {
        let p = probe(false);
        p.awake.update(false, true);
        assert_eq!(p.started.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_hold_that_died_is_started_again() {
        let p = probe(false);
        p.awake.update(true, true);
        p.alive.store(false, Ordering::SeqCst);
        p.awake.update(true, true);
        assert_eq!(p.started.load(Ordering::SeqCst), 2);
        // The dead one was dropped, not leaked.
        assert_eq!(p.ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_hold_that_cannot_start_holds_nothing() {
        let p = probe(true);
        p.awake.update(true, true);
        assert!(!p.awake.holding());
    }

    #[test]
    fn stop_lets_go() {
        let p = probe(false);
        p.awake.update(true, true);
        p.awake.stop();
        assert_eq!(p.ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_it_lets_go() {
        let p = probe(false);
        p.awake.update(true, true);
        let ended = p.ended.clone();
        drop(p.awake);
        assert_eq!(ended.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_hold_is_a_caffeinate_that_ends_with_it() {
        let awake = Awake::default();
        awake.update(true, true);
        assert!(awake.holding());
        awake.stop();
        assert!(!awake.holding());
    }
}
