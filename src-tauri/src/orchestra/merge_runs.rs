//! The merge card's tests: moved out of orchestra.rs as they were.

use super::*;

/// The merge card's tests: run in the worker's worktree when the user asks (or the setting asks for them as a merge is
/// proposed), cancellable, and remembered with what the branch was when they ran.
impl Orchestra {
    /// "Run tests when a merge is proposed" (the user's setting).
    pub fn set_auto_tests(&self, on: bool) {
        self.auto_tests.store(on, Ordering::SeqCst);
    }

    /// Whether a worker's tests are going, what runs them, and the last result with whether it still describes the branch.
    pub async fn merge_tests_info(self: &Arc<Self>, worker: &str) -> Result<TestsInfo, String> {
        let (main, wt, running, last) = {
            let inner = self.inner.lock().unwrap();
            let w = inner.workers.get(worker).ok_or(GONE)?;
            let running = w.tests.running.as_ref().map(|r| (r.command.clone(), r.started.elapsed(), r.live.clone()));
            let last = w.tests.last.as_ref().map(|l| (l.report.clone(), l.fingerprint.clone(), l.moved));
            (w.parent.clone(), w.worktree.clone().ok_or("That agent shares your folder, so there is no branch to test.")?, running, last)
        };
        let repo = self.host.main_folder(&main)?;
        let env = self.host.path_env().await;
        let (r, root, branch) = (repo.clone(), wt.root.clone(), wt.branch.clone());
        let (detected, last) = tokio::task::spawn_blocking(move || {
            let detected = merge_tests::detect(&root);
            let last = last.map(|(report, fingerprint, moved)| {
                // Not the same branch and loose work as when the tests ran: what they said may not be true of it now.
                let stale = moved || git::verify_worktree(&r, &root, env.as_deref()).and_then(|c| git::fingerprint(&r, &c, &branch, env.as_deref())).map_or(true, |(_, now)| now != fingerprint);
                LastInfo { report, stale }
            });
            (detected, last)
        })
        .await
        .map_err(|e| e.to_string())?;
        let running = running.map(|(command, elapsed, live)| RunningInfo { command, elapsed_ms: elapsed.as_millis() as u64, last_line: live.lock().unwrap().last_line() });
        Ok(TestsInfo { project: repo.display().to_string(), detected, running, last })
    }

    /// Marks the worker's tests as going, before anything runs: a second ask finds them going, and a card that appears
    /// right after sees them. `command`: what the user typed (already split), else what the worktree says to run.
    pub(super) fn begin_tests(&self, worker: &str, command: Option<Vec<String>>) -> Result<BegunTests, String> {
        let mut inner = self.inner.lock().unwrap();
        let w = inner.workers.get_mut(worker).ok_or(GONE)?;
        let wt = w.worktree.clone().ok_or("That agent shares your folder, so there is no branch to test.")?;
        if w.merge != Merge::Proposed {
            return Err("There is no merge waiting for that agent, so there is nothing to test.".into());
        }
        if w.tests.running.is_some() {
            return Err("The tests are already running.".into());
        }
        let command = match command {
            Some(c) => {
                merge_tests::check_words(&c)?;
                c
            }
            None => merge_tests::detect(&wt.root).ok_or("Lantern can't tell how this project is tested. Type the command to run.")?.command,
        };
        let (cancel, live) = (Arc::new(tokio::sync::Notify::new()), Arc::new(Mutex::new(Capped::default())));
        w.tests.running = Some(RunningTests { started: Instant::now(), command: command.clone(), cancel: cancel.clone(), live: live.clone() });
        Ok(BegunTests { main: w.parent.clone(), wt, command, cancel, live })
    }

    /// Runs the project's tests in the worker's worktree, for its merge card, and returns how they went (None: the user
    /// cancelled). The command is the user's, as words (see `merge_tests::split_command`), or what the worktree says.
    pub async fn run_merge_tests(self: &Arc<Self>, worker: &str, command: Option<Vec<String>>) -> Result<Option<LastInfo>, String> {
        let begun = self.begin_tests(worker, command)?;
        self.finish_tests(worker, begun).await
    }

    pub(super) async fn finish_tests(self: &Arc<Self>, worker: &str, begun: BegunTests) -> Result<Option<LastInfo>, String> {
        let outcome = self.run_tests_in(&begun.main, &begun.wt, &begun.command, begun.cancel, begun.live).await;
        // Whatever came of it, they are not going any more.
        if let Some(w) = self.inner.lock().unwrap().workers.get_mut(worker) {
            w.tests.running = None;
            if let Ok(Some((report, fingerprint, moved))) = &outcome {
                w.tests.last = Some(LastTests { report: report.clone(), fingerprint: fingerprint.clone(), moved: *moved });
            }
        }
        // Looked at again from here so the card gets the same answer as any other asking would.
        outcome.map(|done| done.map(|(report, _, moved)| LastInfo { report, stale: moved }))
    }

    /// The run itself: the worktree is checked to be Lantern's own first, and what the branch was before and after is
    /// kept, so a result can later say whether it still holds. A cancelled run leaves nothing.
    async fn run_tests_in(self: &Arc<Self>, main: &str, wt: &git::Worktree, command: &[String], cancel: Arc<tokio::sync::Notify>, live: Arc<Mutex<Capped>>) -> Result<Option<(Report, String, bool)>, String> {
        let repo = self.host.main_folder(main)?;
        let env = self.host.path_env().await;
        let (before, _) = look(repo.clone(), wt.root.clone(), wt.branch.clone(), env.clone()).await?;
        let finished = merge_tests::run(&wt.root, command, env.as_deref(), merge_tests::DEFAULT_LIMIT, cancel, live).await?;
        let missing_packages = command.first().is_some_and(|c| c == "npm") && wt.root.join("package.json").exists() && !wt.root.join("node_modules").exists();
        let Some(mut report) = merge_tests::report(command, &finished, merge_tests::DEFAULT_LIMIT, missing_packages) else { return Ok(None) };
        // The run may have written files of its own (coverage, build output): they are said, and not counted as the branch changing.
        let (after, fingerprint) = look(repo, wt.root.clone(), wt.branch.clone(), env).await?;
        report.new_files = after.loose.iter().filter(|f| !before.loose.contains(f)).take(20).cloned().collect();
        Ok(Some((report, fingerprint, before.tip != after.tip)))
    }

    /// The user cancels the tests going for this worker; they stop with everything they started.
    pub fn cancel_merge_tests(&self, worker: &str) {
        if let Some(r) = self.inner.lock().unwrap().workers.get(worker).and_then(|w| w.tests.running.as_ref()) {
            r.cancel.notify_one();
        }
    }
}

/// A worker's branch and loose work as git sees them now (the worktree is checked to be Lantern's own first): what a test
/// run is compared with.
async fn look(repo: PathBuf, root: PathBuf, branch: String, env: Option<String>) -> Result<(git::Snapshot, String), String> {
    tokio::task::spawn_blocking(move || git::verify_worktree(&repo, &root, env.as_deref()).and_then(|c| git::fingerprint(&repo, &c, &branch, env.as_deref()))).await.map_err(|e| e.to_string())?
}
