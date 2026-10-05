//! Reads test results out of a command's output, for the Tests pane: which tests ran, which failed and why.
//! Each framework gets a small line-based parser; the first one that finds its own summary or case lines wins.
//! Nothing is run here: this only reads what Claude's Bash commands printed.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestCase {
    pub name: String,
    /// The file, class or describe block it belongs to, when the output says.
    pub suite: Option<String>,
    pub status: CaseStatus,
    pub duration_ms: Option<f64>,
    /// Why it failed: the assertion and whatever the framework printed with it.
    pub message: Option<String>,
    /// `path:line` of the failure, when the output points at one.
    pub location: Option<String>,
}

/// How the run went overall. A run can fail with no failed test: a suite that couldn't load, a build error.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Passed,
    Failed,
    /// Nothing ran and nothing said it failed (e.g. "0 total").
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestRun {
    pub framework: String,
    pub outcome: Outcome,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub duration_ms: Option<f64>,
    /// Failed cases always (when the output names them); passed and skipped ones when it lists them.
    pub cases: Vec<TestCase>,
    /// The end of the output, for when the cases couldn't be read.
    pub tail: String,
}

const MAX_CASES: usize = 5000;
const MAX_MESSAGE: usize = 4000;
const TAIL_LINES: usize = 120;

fn re(s: &str) -> Regex {
    Regex::new(s).expect("valid test-output regex")
}

static ANSI: LazyLock<Regex> = LazyLock::new(|| re(r"\x1b\[[0-9;?]*[ -/]*[@-~]"));

/// Words a test command contains: "test" covers npm test, pytest, cargo/go/swift test, xcodebuild test, …
const TEST_WORDS: &[&str] = &["test", "spec", "jest", "mocha"];

/// A test run, if `command` looks like one and its output reads like a test framework's.
pub fn detect(command: &str, output: &str) -> Option<TestRun> {
    let lower = command.to_lowercase();
    if !TEST_WORDS.iter().any(|w| lower.contains(w)) {
        return None;
    }
    let clean = ANSI.replace_all(output, "");
    let lines: Vec<&str> = clean.lines().map(|l| l.trim_end_matches('\r')).collect();
    let parsers: [(&str, Parser); 8] = [
        ("swift", swift),
        ("cargo", cargo),
        ("go", go),
        ("pytest", pytest),
        ("django", django),
        ("playwright", playwright),
        ("vitest", vitest),
        ("jest", jest),
    ];
    let (framework, parsed) = parsers.iter().find_map(|(name, parse)| parse(&lines).map(|p| (*name, p)))?;
    Some(parsed.into_run(framework, &lines))
}

type Parser = fn(&[&str]) -> Option<Parsed>;

/// What a parser found: the summary counts when the output had them, and the cases it could read.
#[derive(Default)]
struct Parsed {
    counts: Option<(u32, u32, u32)>,
    duration_ms: Option<f64>,
    cases: Vec<TestCase>,
    /// The output said the run failed beyond any failed test (a suite didn't load, the build broke).
    broken: bool,
    /// The output said the run succeeded (e.g. "** TEST SUCCEEDED **"), even if it listed no counts.
    succeeded: bool,
}

impl Parsed {
    fn into_run(mut self, framework: &str, lines: &[&str]) -> TestRun {
        self.cases.truncate(MAX_CASES);
        for c in &mut self.cases {
            if let Some(m) = &mut c.message {
                *m = clip(m.trim_matches('\n'), MAX_MESSAGE);
            }
        }
        let count = |s: CaseStatus| self.cases.iter().filter(|c| c.status == s).count() as u32;
        let (passed, failed, skipped) = self.counts.unwrap_or((count(CaseStatus::Passed), count(CaseStatus::Failed), count(CaseStatus::Skipped)));
        let tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
        let any_failed = failed > 0 || self.cases.iter().any(|c| c.status == CaseStatus::Failed);
        let outcome = if any_failed || self.broken {
            Outcome::Failed
        } else if passed > 0 || self.succeeded {
            Outcome::Passed
        } else {
            Outcome::Unknown
        };
        TestRun { framework: framework.to_string(), outcome, passed, failed, skipped, duration_ms: self.duration_ms, cases: self.cases, tail }
    }

    fn case(&mut self, name: &str, suite: Option<String>, status: CaseStatus, duration_ms: Option<f64>) -> usize {
        self.cases.push(TestCase { name: name.to_string(), suite, status, duration_ms, message: None, location: None });
        self.cases.len() - 1
    }

    /// The failed case this name (or its tail end) refers to, adding one if the output only named it in its failure.
    fn failed_case(&mut self, name: &str, suite: Option<String>) -> usize {
        match self.cases.iter().rposition(|c| c.name == name && (suite.is_none() || c.suite == suite)) {
            Some(i) => {
                self.cases[i].status = CaseStatus::Failed;
                i
            }
            None => self.case(name, suite, CaseStatus::Failed, None),
        }
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

fn num<T: std::str::FromStr>(s: Option<regex::Match>) -> Option<T> {
    s.and_then(|m| m.as_str().parse().ok())
}

fn secs(s: Option<regex::Match>) -> Option<f64> {
    num::<f64>(s).map(|x| x * 1000.0)
}

/// "12ms", "1.5s", "2m" → milliseconds.
fn span(value: Option<regex::Match>, unit: Option<regex::Match>) -> Option<f64> {
    let v: f64 = num(value)?;
    Some(match unit.map(|u| u.as_str()).unwrap_or("ms") {
        "s" => v * 1000.0,
        "m" => v * 60_000.0,
        _ => v,
    })
}

/// Lines from `from` up to (not including) the first one `stop` matches.
fn block<'a>(lines: &[&'a str], from: usize, stop: impl Fn(&str) -> bool) -> Vec<&'a str> {
    lines[from..].iter().take_while(|l| !stop(l)).copied().collect()
}

// ---------- Rust: cargo test ----------

static CARGO_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^test (\S+) \.\.\. (ok|FAILED|ignored)"));
static CARGO_RESULT: LazyLock<Regex> = LazyLock::new(|| re(r"^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?finished in ([\d.]+)s"));
static CARGO_FAIL_OUT: LazyLock<Regex> = LazyLock::new(|| re(r"^---- (\S+) stdout ----$"));
static CARGO_PANIC: LazyLock<Regex> = LazyLock::new(|| re(r"panicked at (\S+?:\d+):\d+:?"));

fn split_path(full: &str) -> (String, Option<String>) {
    match full.rsplit_once("::") {
        Some((suite, name)) => (name.to_string(), Some(suite.to_string())),
        None => (full.to_string(), None),
    }
}

fn cargo(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut found = false;
    let (mut passed, mut failed, mut ignored, mut ms) = (0, 0, 0, 0.0);
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = CARGO_CASE.captures(line) {
            let (name, suite) = split_path(&c[1]);
            let status = match &c[2] {
                "ok" => CaseStatus::Passed,
                "FAILED" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            p.case(&name, suite, status, None);
        } else if line.starts_with("error: could not compile `") {
            found = true;
            p.broken = true;
        } else if let Some(c) = CARGO_RESULT.captures(line) {
            found = true;
            p.broken |= line.starts_with("test result: FAILED");
            passed += num::<u32>(c.get(1)).unwrap_or(0);
            failed += num::<u32>(c.get(2)).unwrap_or(0);
            ignored += num::<u32>(c.get(3)).unwrap_or(0);
            ms += secs(c.get(4)).unwrap_or(0.0);
        } else if let Some(c) = CARGO_FAIL_OUT.captures(line) {
            let (name, suite) = split_path(&c[1]);
            let body = block(lines, i + 1, |l| l.starts_with("---- ") || l == "failures:" || l.starts_with("test result:"));
            let text: Vec<&str> = body.into_iter().filter(|l| !l.starts_with("note: run with `RUST_BACKTRACE")).collect();
            let at = p.failed_case(&name, suite);
            p.cases[at].location = text.iter().find_map(|l| CARGO_PANIC.captures(l)).map(|c| c[1].to_string());
            p.cases[at].message = Some(text.join("\n"));
        }
    }
    (found || !p.cases.is_empty()).then(|| {
        if found {
            p.counts = Some((passed, failed, ignored));
            p.duration_ms = Some(ms);
        }
        p
    })
}

// ---------- Go: go test ----------

static GO_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)"));
static GO_PKG: LazyLock<Regex> = LazyLock::new(|| re(r"^(ok|FAIL)\s+(\S+)\s+(?:([\d.]+)s|\(cached\))"));
static GO_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*=== RUN\s+(\S+)"));
static GO_LOC: LazyLock<Regex> = LazyLock::new(|| re(r"(\S+\.go:\d+)"));

fn go(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut packages: Vec<(String, bool, Option<f64>)> = vec![];
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = GO_CASE.captures(line) {
            let status = match &c[1] {
                "PASS" => CaseStatus::Passed,
                "FAIL" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            let at = p.case(&c[2], None, status, secs(c.get(3)));
            if status == CaseStatus::Failed {
                // Without -v its log lines follow the FAIL line, indented; with -v they come after its "=== RUN".
                let indent = line.len() - line.trim_start().len();
                let mut msg: Vec<&str> = block(lines, i + 1, |l| l.trim().is_empty() || l.len() - l.trim_start().len() <= indent);
                if msg.is_empty() {
                    if let Some(start) = lines[..i].iter().rposition(|l| GO_RUN.captures(l).is_some_and(|r| r[1] == c[2])) {
                        msg = lines[start + 1..i].iter().filter(|l| !l.trim_start().starts_with("=== ")).copied().collect();
                    }
                }
                p.cases[at].location = msg.iter().find_map(|l| GO_LOC.captures(l)).map(|m| m[1].to_string());
                p.cases[at].message = (!msg.is_empty()).then(|| msg.iter().map(|l| l.trim()).collect::<Vec<_>>().join("\n"));
            }
        } else if let Some(c) = GO_PKG.captures(line) {
            packages.push((c[2].to_string(), &c[1] == "ok", secs(c.get(3))));
            p.broken |= &c[1] == "FAIL";
        } else if line.ends_with("[build failed]") {
            p.broken = true;
        }
    }
    if p.cases.is_empty() && packages.is_empty() {
        return None;
    }
    // Without -v, go only reports packages: list those.
    if p.cases.is_empty() {
        for (name, ok, ms) in &packages {
            p.case(name, None, if *ok { CaseStatus::Passed } else { CaseStatus::Failed }, *ms);
        }
    }
    p.duration_ms = Some(packages.iter().filter_map(|x| x.2).sum());
    Some(p)
}

// ---------- Python: pytest ----------

static PYTEST_SUMMARY: LazyLock<Regex> = LazyLock::new(|| re(r"^=*\s*((?:\d+ \w+(?:, )?)+) in ([\d.]+)s(?: \([^)]*\))?\s*=*$"));
static PYTEST_COUNT: LazyLock<Regex> = LazyLock::new(|| re(r"(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)"));
static PYTEST_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\S+\.py::\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b"));
static PYTEST_XDIST: LazyLock<Regex> = LazyLock::new(|| re(r"^\[gw\d+\] \[\s*\d+%\] (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS) (\S+\.py::\S+)"));
static PYTEST_SHORT: LazyLock<Regex> = LazyLock::new(|| re(r"^(FAILED|ERROR) (\S+\.py::\S+?)(?: - (.*))?$"));
static PYTEST_SECTION: LazyLock<Regex> = LazyLock::new(|| re(r"^_{3,} (?:ERROR at \w+ of )?(.+?) _{3,}$"));
static PYTEST_LOC: LazyLock<Regex> = LazyLock::new(|| re(r"^(\S+\.py):(\d+): (\w+)"));

/// "tests/test_x.py::TestFoo::test_y[1]" → ("test_y[1]", "tests/test_x.py::TestFoo").
fn node(id: &str) -> (String, Option<String>) {
    split_path(id)
}

fn pytest(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut found = false;
    for (i, line) in lines.iter().enumerate() {
        let status_of = |s: &str| match s {
            "PASSED" | "XPASS" => CaseStatus::Passed,
            "FAILED" | "ERROR" => CaseStatus::Failed,
            _ => CaseStatus::Skipped,
        };
        if let Some(c) = PYTEST_CASE.captures(line) {
            let (name, suite) = node(&c[1]);
            p.case(&name, suite, status_of(&c[2]), None);
        } else if let Some(c) = PYTEST_XDIST.captures(line) {
            let (name, suite) = node(&c[2]);
            p.case(&name, suite, status_of(&c[1]), None);
        } else if let Some(c) = PYTEST_SHORT.captures(line) {
            let (name, suite) = node(&c[2]);
            let at = p.failed_case(&name, suite);
            if p.cases[at].message.is_none() {
                p.cases[at].message = c.get(3).map(|m| m.as_str().to_string());
            }
        } else if let Some(c) = PYTEST_SECTION.captures(line) {
            // "____ TestFoo.test_y ____": the traceback of a failure, up to the next section.
            let title = c[1].replace('.', "::");
            let body = block(lines, i + 1, |l| PYTEST_SECTION.is_match(l) || l.starts_with("====="));
            let Some(at) = p.cases.iter().rposition(|x| format!("{}::{}", x.suite.as_deref().unwrap_or(""), x.name).ends_with(&title)) else { continue };
            let located = body.iter().rev().find_map(|l| PYTEST_LOC.captures(l));
            p.cases[at].location = located.as_ref().map(|m| format!("{}:{}", &m[1], &m[2]));
            let errors: Vec<&str> = body.iter().filter(|l| l.starts_with("E ")).map(|l| l[1..].trim()).collect();
            let message = if errors.is_empty() { body.join("\n") } else { errors.join("\n") };
            p.cases[at].message = Some(message);
        } else if let Some(c) = PYTEST_SUMMARY.captures(line) {
            if !PYTEST_COUNT.is_match(&c[1]) || !["passed", "failed", "error", "skipped"].iter().any(|w| c[1].contains(w)) {
                continue;
            }
            found = true;
            let (mut passed, mut failed, mut skipped) = (0, 0, 0);
            for m in PYTEST_COUNT.captures_iter(&c[1]) {
                let n: u32 = m[1].parse().unwrap_or(0);
                match &m[2] {
                    "passed" | "xpassed" => passed += n,
                    "failed" | "error" | "errors" => failed += n,
                    "skipped" | "xfailed" => skipped += n,
                    _ => {}
                }
            }
            p.counts = Some((passed, failed, skipped));
            p.duration_ms = secs(c.get(2));
        }
    }
    found.then_some(p)
}

// ---------- Python: Django's manage.py test (unittest) ----------

static DJANGO_RAN: LazyLock<Regex> = LazyLock::new(|| re(r"^Ran (\d+) tests? in ([\d.]+)s"));
static DJANGO_RESULT: LazyLock<Regex> = LazyLock::new(|| re(r"^(OK|FAILED)(?: \((.*)\))?$"));
static DJANGO_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\w+) \(([\w.]+)\)(?:\s*\n?.*?)? \.\.\. (ok|FAIL|ERROR|skipped|expected failure|unexpected success)"));
static DJANGO_FAIL: LazyLock<Regex> = LazyLock::new(|| re(r"^(FAIL|ERROR): (\w+) \(([\w.]+)\)"));
static PY_FILE: LazyLock<Regex> = LazyLock::new(|| re(r#"File "([^"]+)", line (\d+)"#));

/// unittest names a test "test_x (app.tests.FooTests)" or, since Python 3.11, "test_x (app.tests.FooTests.test_x)".
fn unittest_suite(name: &str, suite: &str) -> Option<String> {
    Some(suite.strip_suffix(&format!(".{name}")).unwrap_or(suite).to_string())
}

fn django(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut ran: Option<(u32, Option<f64>)> = None;
    let mut result: Option<(bool, String)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = DJANGO_CASE.captures(line) {
            let status = match &c[3] {
                "ok" | "unexpected success" => CaseStatus::Passed,
                "FAIL" | "ERROR" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            p.case(&c[1], unittest_suite(&c[1], &c[2]), status, None);
        } else if let Some(c) = DJANGO_FAIL.captures(line) {
            // The traceback sits between two rules; its last line is the error.
            let start = if lines.get(i + 1).is_some_and(|l| l.starts_with("----")) { i + 2 } else { i + 1 };
            let body = block(lines, start, |l| l.starts_with("======") || l.starts_with("------"));
            let at = p.failed_case(&c[2], unittest_suite(&c[2], &c[3]));
            p.cases[at].location = body.iter().rev().find_map(|l| PY_FILE.captures(l)).map(|m| format!("{}:{}", &m[1], &m[2]));
            p.cases[at].message = Some(body.join("\n"));
        } else if let Some(c) = DJANGO_RAN.captures(line) {
            ran = Some((num(c.get(1)).unwrap_or(0), secs(c.get(2))));
        } else if let Some(c) = DJANGO_RESULT.captures(line) {
            if ran.is_some() {
                result = Some((&c[1] == "OK", c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default()));
            }
        }
    }
    let (total, ms) = ran?;
    p.broken = result.as_ref().is_some_and(|r| !r.0);
    p.succeeded = result.as_ref().is_some_and(|r| r.0);
    let detail = result.map(|r| r.1).unwrap_or_default();
    let count = |key: &str| Regex::new(&format!(r"\b{key}=(\d+)")).ok().and_then(|r| r.captures(&detail)).and_then(|c| c[1].parse::<u32>().ok()).unwrap_or(0);
    let failed = count("failures") + count("errors");
    let skipped = count("skipped") + count("expected failures");
    p.counts = Some((total.saturating_sub(failed + skipped), failed, skipped));
    p.duration_ms = ms;
    Some(p)
}

// ---------- JS: jest ----------

static JEST_TESTS: LazyLock<Regex> = LazyLock::new(|| re(r"^Tests:\s+(.*?)(\d+) total"));
static JEST_SUITES: LazyLock<Regex> = LazyLock::new(|| re(r"^Test Suites:\s+(\d+) failed"));
static JEST_TIME: LazyLock<Regex> = LazyLock::new(|| re(r"^Time:\s+([\d.]+)\s*(ms|s|m)"));
static JEST_FILE: LazyLock<Regex> = LazyLock::new(|| re(r"^(PASS|FAIL) (\S+)"));
static JEST_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s+(✓|✕|√|×|○) (?:skipped |todo )?(.+?)(?: \((\d+(?:\.\d+)?) ?(ms|s)\))?$"));
static JEST_FAILURE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*● (.+)$"));
static JS_LOC: LazyLock<Regex> = LazyLock::new(|| re(r"\(?((?:\.{0,2}/)?[\w@./-]+\.[cm]?[jt]sx?):(\d+):\d+\)?"));
static COUNT_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"(\d+) (passed|failed|skipped|todo|pending)"));

/// The first `path:line` in a stack that isn't inside node_modules.
fn js_location(body: &[&str]) -> Option<String> {
    body.iter().flat_map(|l| JS_LOC.captures_iter(l)).find(|c| !c[1].contains("node_modules")).map(|c| format!("{}:{}", &c[1], &c[2]))
}

fn jest(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut file: Option<String> = None;
    let mut found = false;
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = JEST_FILE.captures(line) {
            file = Some(c[2].to_string());
        } else if let Some(c) = JEST_SUITES.captures(line) {
            // A suite that fails to load has no failed tests ("Tests: 0 total") but fails the run.
            p.broken |= num::<u32>(c.get(1)).unwrap_or(0) > 0;
        } else if let Some(c) = JEST_TESTS.captures(line) {
            found = true;
            let (mut passed, mut failed, mut skipped) = (0, 0, 0);
            for m in COUNT_WORD.captures_iter(&c[1]) {
                let n: u32 = m[1].parse().unwrap_or(0);
                match &m[2] {
                    "passed" => passed += n,
                    "failed" => failed += n,
                    _ => skipped += n,
                }
            }
            p.counts = Some((passed, failed, skipped));
        } else if let Some(c) = JEST_TIME.captures(line) {
            p.duration_ms = span(c.get(1), c.get(2));
        } else if let Some(c) = JEST_FAILURE.captures(line) {
            // "● Suite › test name", then the message and stack until the next failure or file.
            let title = c[1].to_string();
            let body = block(lines, i + 1, |l| JEST_FAILURE.is_match(l) || JEST_FILE.is_match(l) || l.starts_with("Test Suites:"));
            let (suite, name) = match title.rsplit_once(" › ") {
                Some((s, n)) => (Some(s.to_string()), n.to_string()),
                None => (file.clone(), title.clone()),
            };
            let at = match p.cases.iter().rposition(|x| x.name == name) {
                Some(at) => {
                    p.cases[at].status = CaseStatus::Failed;
                    at
                }
                None => p.case(&name, suite, CaseStatus::Failed, None),
            };
            p.cases[at].location = js_location(&body);
            let message: Vec<&str> = body.iter().filter(|l| !l.trim_start().starts_with("at ")).map(|l| l.trim()).collect();
            p.cases[at].message = Some(message.join("\n").trim().to_string());
        } else if let Some(c) = JEST_CASE.captures(line) {
            let status = match &c[1] {
                "✓" | "√" => CaseStatus::Passed,
                "✕" | "×" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            p.case(&c[2], file.clone(), status, span(c.get(3), c.get(4)));
        }
    }
    found.then_some(p)
}

// ---------- JS: vitest ----------

static VITEST_TESTS: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*Tests\s+(.*)\((\d+)\)\s*$"));
static VITEST_FILES: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*Test Files\s+"));
static VITEST_FILES_FAILED: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*Test Files\s+(\d+) failed"));
static VITEST_DURATION: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*Duration\s+([\d.]+)(ms|s|m)"));
static VITEST_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s+(✓|×|↓|✗) (.+?)(?: (\d+(?:\.\d+)?)(ms|s))?$"));
static VITEST_FAIL: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*FAIL\s+(\S+) > (.+)$"));
static VITEST_LOC: LazyLock<Regex> = LazyLock::new(|| re(r"❯ (\S+?):(\d+):\d+"));

fn vitest(lines: &[&str]) -> Option<Parsed> {
    if !lines.iter().any(|l| VITEST_FILES.is_match(l)) {
        return None;
    }
    let mut p = Parsed::default();
    let mut found = false;
    for (i, line) in lines.iter().enumerate() {
        if VITEST_FILES_FAILED.is_match(line) || line.contains("Unhandled Error") {
            p.broken = true;
        }
        if let Some(c) = VITEST_TESTS.captures(line) {
            found = true;
            let (mut passed, mut failed, mut skipped) = (0, 0, 0);
            for m in COUNT_WORD.captures_iter(&c[1]) {
                let n: u32 = m[1].parse().unwrap_or(0);
                match &m[2] {
                    "passed" => passed += n,
                    "failed" => failed += n,
                    _ => skipped += n,
                }
            }
            p.counts = Some((passed, failed, skipped));
        } else if let Some(c) = VITEST_DURATION.captures(line) {
            p.duration_ms = span(c.get(1), c.get(2));
        } else if let Some(c) = VITEST_FAIL.captures(line) {
            let (suite, name) = match c[2].rsplit_once(" > ") {
                Some((s, n)) => (format!("{} > {}", &c[1], s), n.to_string()),
                None => (c[1].to_string(), c[2].to_string()),
            };
            let body = block(lines, i + 1, |l| VITEST_FAIL.is_match(l) || l.trim_start().starts_with("⎯"));
            let at = match p.cases.iter().rposition(|x| x.name == name) {
                Some(at) => {
                    p.cases[at].status = CaseStatus::Failed;
                    at
                }
                None => p.case(&name, Some(suite), CaseStatus::Failed, None),
            };
            p.cases[at].location = body.iter().find_map(|l| VITEST_LOC.captures(l)).map(|m| format!("{}:{}", &m[1], &m[2]));
            let message: Vec<&str> = body.iter().map(|l| l.trim_end()).filter(|l| !l.trim_start().starts_with('❯') && !l.trim().is_empty()).collect();
            p.cases[at].message = Some(message.iter().take(40).copied().collect::<Vec<_>>().join("\n"));
        } else if let Some(c) = VITEST_CASE.captures(line) {
            // A file line reads "✓ src/a.test.ts (5 tests) 12ms"; those aren't cases.
            if c[2].contains(" test") && c[2].ends_with(')') || c[2].contains(" tests)") || c[2].contains(" test)") {
                continue;
            }
            let status = match &c[1] {
                "✓" => CaseStatus::Passed,
                "×" | "✗" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            let (suite, name) = match c[2].rsplit_once(" > ") {
                Some((s, n)) => (Some(s.to_string()), n.to_string()),
                None => (None, c[2].to_string()),
            };
            p.case(&name, suite, status, span(c.get(3), c.get(4)));
        }
    }
    found.then_some(p)
}

// ---------- JS: playwright (list and line reporters) ----------

static PW_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s+(✓|✘|-|ok|x)\s+\d+ (?:\[[^\]]+\] › )?(\S+?:\d+):\d+ › (.+?)(?: \(([\d.]+)(ms|s|m)\))?$"));
static PW_SUMMARY: LazyLock<Regex> = LazyLock::new(|| re(r"^\s+(\d+) (passed|failed|skipped|flaky|did not run)(?: \(([\d.]+)(ms|s|m)\))?$"));
static PW_FAILURE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s+\d+\) (?:\[[^\]]+\] › )?(\S+?:\d+):\d+ › (.+?) ─*$"));

fn playwright(lines: &[&str]) -> Option<Parsed> {
    if !lines.iter().any(|l| l.trim_start().starts_with("Running ") && l.contains(" using ")) {
        return None;
    }
    let mut p = Parsed::default();
    let (mut passed, mut failed, mut skipped, mut found) = (0, 0, 0, false);
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = PW_CASE.captures(line) {
            let status = match &c[1] {
                "✓" | "ok" => CaseStatus::Passed,
                "✘" | "x" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            let at = p.case(&c[3], Some(c[2].rsplit_once(':').map(|x| x.0).unwrap_or(&c[2]).to_string()), status, span(c.get(4), c.get(5)));
            if status == CaseStatus::Failed {
                p.cases[at].location = Some(c[2].to_string());
            }
        } else if let Some(c) = PW_FAILURE.captures(line) {
            let body = block(lines, i + 1, |l| PW_FAILURE.is_match(l) || PW_SUMMARY.is_match(l));
            let name = c[2].rsplit(" › ").next().unwrap_or(&c[2]).to_string();
            let at = p.failed_case(&name, None);
            p.cases[at].location = Some(c[1].to_string());
            let message: Vec<&str> = body.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).take(40).collect();
            p.cases[at].message = Some(message.join("\n"));
        } else if let Some(c) = PW_SUMMARY.captures(line) {
            found = true;
            let n: u32 = c[1].parse().unwrap_or(0);
            match &c[2] {
                "passed" | "flaky" => passed += n,
                "failed" => failed += n,
                _ => skipped += n,
            }
            if c.get(3).is_some() {
                p.duration_ms = span(c.get(3), c.get(4));
            }
        }
    }
    found.then(|| {
        p.counts = Some((passed, failed, skipped));
        p
    })
}

// ---------- Swift: XCTest (xcodebuild, swift test) and Swift Testing ----------

static XC_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^Test [Cc]ase '(?:-\[(\S+) (\S+)\]|(\S+?)\.(\S+?))' (passed|failed|skipped)(?: on '[^']*')? \(([\d.]+) seconds\)"));
static XC_ISSUE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\S+?):(\d+): error: (?:-\[(\S+) (\S+)\]|(\S+?)\.(\S+?)) : (.*)$"));
static XC_EXECUTED: LazyLock<Regex> = LazyLock::new(|| re(r"Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures? .*?in ([\d.]+) "));
// Swift Testing starts each line with a symbol ("✔", "✘", or an SF Symbol) and says how long a test took.
static ST_CASE: LazyLock<Regex> = LazyLock::new(|| re(r"^\S{1,2} Test (.+?) (?:(passed|failed) after ([\d.]+) seconds|(skipped))"));
static ST_ISSUE: LazyLock<Regex> = LazyLock::new(|| re(r"^\S{1,2} Test (.+?) recorded an issue at (\S+?):(\d+):\d+: (.*)$"));
static ST_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"^\S{1,2} Test run with (\d+) tests? (?:in \d+ suites? )?(passed|failed) after ([\d.]+) seconds(?: with (\d+) issues?)?"));

fn swift(lines: &[&str]) -> Option<Parsed> {
    let mut p = Parsed::default();
    let mut found = false;
    let mut executed: Option<(u32, u32, u32, Option<f64>)> = None;
    let mut st_run: Option<(u32, Option<f64>)> = None;
    for line in lines {
        if let Some(c) = XC_CASE.captures(line) {
            found = true;
            let (suite, name) = match (c.get(1), c.get(2)) {
                (Some(s), Some(n)) => (s.as_str(), n.as_str()),
                _ => (c.get(3).map_or("", |m| m.as_str()), c.get(4).map_or("", |m| m.as_str())),
            };
            let status = match &c[5] {
                "passed" => CaseStatus::Passed,
                "failed" => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            let name = name.trim_end_matches("()");
            match p.cases.iter().rposition(|x| x.name == name && x.suite.as_deref() == Some(suite) && x.status == CaseStatus::Failed && x.duration_ms.is_none()) {
                // Its failure was reported first: fill in the rest.
                Some(at) => {
                    p.cases[at].status = status;
                    p.cases[at].duration_ms = secs(c.get(6));
                }
                None => {
                    p.case(name, Some(suite.to_string()), status, secs(c.get(6)));
                }
            }
        } else if let Some(c) = XC_ISSUE.captures(line) {
            let (suite, name) = match (c.get(3), c.get(4)) {
                (Some(s), Some(n)) => (s.as_str(), n.as_str()),
                _ => (c.get(5).map_or("", |m| m.as_str()), c.get(6).map_or("", |m| m.as_str())),
            };
            let name = name.trim_end_matches("()");
            let at = p.failed_case(name, Some(suite.to_string()));
            p.cases[at].location.get_or_insert_with(|| format!("{}:{}", &c[1], &c[2]));
            let m = p.cases[at].message.get_or_insert_with(String::new);
            if !m.is_empty() {
                m.push('\n');
            }
            m.push_str(&c[7]);
        } else if let Some(c) = XC_EXECUTED.captures(line) {
            found = true;
            let total: u32 = num(c.get(1)).unwrap_or(0);
            // xcodebuild prints one of these per suite and a last one for everything: keep the biggest.
            if executed.is_none_or(|e| total >= e.0) {
                executed = Some((total, num(c.get(2)).unwrap_or(0), num(c.get(3)).unwrap_or(0), secs(c.get(4))));
            }
        } else if let Some(c) = ST_ISSUE.captures(line) {
            found = true;
            let at = p.failed_case(c[1].trim_matches('"'), None);
            p.cases[at].location.get_or_insert_with(|| format!("{}:{}", &c[2], &c[3]));
            let m = p.cases[at].message.get_or_insert_with(String::new);
            if !m.is_empty() {
                m.push('\n');
            }
            m.push_str(&c[4]);
        } else if let Some(c) = ST_RUN.captures(line) {
            found = true;
            st_run = Some((num(c.get(1)).unwrap_or(0), secs(c.get(3))));
        } else if let Some(c) = ST_CASE.captures(line) {
            if c[1].starts_with("run with") {
                continue;
            }
            found = true;
            let name = c[1].trim_matches('"').to_string();
            let status = match c.get(2).map(|m| m.as_str()) {
                Some("passed") => CaseStatus::Passed,
                Some("failed") => CaseStatus::Failed,
                _ => CaseStatus::Skipped,
            };
            match p.cases.iter().rposition(|x| x.name == name && x.suite.is_none()) {
                Some(at) => {
                    p.cases[at].status = status;
                    p.cases[at].duration_ms = secs(c.get(3));
                }
                None => {
                    p.case(&name, None, status, secs(c.get(3)));
                }
            }
        } else if line.contains("** TEST SUCCEEDED **") {
            found = true;
            p.succeeded = true;
        } else if line.contains("** TEST FAILED **") || line.contains("** BUILD FAILED **") || line.starts_with("Testing failed:") {
            found = true;
            p.broken = true;
        }
    }
    if !found {
        return None;
    }
    // `swift test` can run XCTest and Swift Testing in one go: add both totals.
    if executed.is_some() || st_run.is_some() {
        let (xt, xs, xf, xms) = executed.unwrap_or((0, 0, 0, None));
        let st_failed = p.cases.iter().filter(|c| c.suite.is_none() && c.status == CaseStatus::Failed).count() as u32;
        let (st_total, st_ms) = st_run.unwrap_or((0, None));
        let st_failed = if st_run.is_some() { st_failed } else { 0 };
        let failed = xf + st_failed;
        let skipped = xs;
        p.counts = Some(((xt + st_total).saturating_sub(failed + skipped), failed, skipped));
        p.duration_ms = match (xms, st_ms) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        };
    }
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(command: &str, output: &str) -> TestRun {
        detect(command, output).expect("a test run")
    }

    fn failed(r: &TestRun) -> Vec<&TestCase> {
        r.cases.iter().filter(|c| c.status == CaseStatus::Failed).collect()
    }

    #[test]
    fn ignores_commands_that_are_not_tests_and_output_without_results() {
        assert!(detect("ls -la", "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s").is_none());
        assert!(detect("npm test", "npm ERR! missing script: test").is_none());
    }

    #[test]
    fn cargo() {
        let out = "running 3 tests\ntest changes::tests::a ... ok\ntest changes::tests::b ... FAILED\ntest slow ... ignored\n\nfailures:\n\n---- changes::tests::b stdout ----\nthread 'changes::tests::b' panicked at src/changes.rs:42:9:\nassertion `left == right` failed\n  left: 1\n right: 2\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    changes::tests::b\n\ntest result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.52s\n";
        let r = run("cargo test --manifest-path src-tauri/Cargo.toml", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed, r.skipped), ("cargo", 1, 1, 1));
        assert_eq!(r.duration_ms, Some(520.0));
        let f = failed(&r);
        assert_eq!((f[0].name.as_str(), f[0].suite.as_deref()), ("b", Some("changes::tests")));
        assert_eq!(f[0].location.as_deref(), Some("src/changes.rs:42"));
        assert!(f[0].message.as_deref().unwrap().contains("left: 1"));
        assert!(!f[0].message.as_deref().unwrap().contains("RUST_BACKTRACE"));
    }

    #[test]
    fn go_verbose_and_not() {
        let out = "=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n=== RUN   TestDiv\n    calc_test.go:18: want 2, got 3\n--- FAIL: TestDiv (0.01s)\nFAIL\nFAIL\texample.com/calc\t0.012s\n";
        let r = run("go test -v ./...", out);
        assert_eq!((r.passed, r.failed), (1, 1));
        let f = failed(&r);
        assert_eq!(f[0].name, "TestDiv");
        assert_eq!(f[0].location.as_deref(), Some("calc_test.go:18"));
        assert_eq!(f[0].message.as_deref(), Some("calc_test.go:18: want 2, got 3"));
        let quiet = run("go test ./...", "ok  \texample.com/a\t0.10s\nok  \texample.com/b\t(cached)\n");
        assert_eq!((quiet.passed, quiet.failed, quiet.cases.len()), (2, 0, 2));
    }

    #[test]
    fn pytest() {
        let out = "============================= test session starts ==============================\ncollected 3 items\n\nposthog/api/test/test_user.py::TestUser::test_create PASSED [ 33%]\nposthog/api/test/test_user.py::TestUser::test_delete FAILED [ 66%]\nposthog/api/test/test_user.py::test_misc SKIPPED (no db) [100%]\n\n=================================== FAILURES ===================================\n____________________________ TestUser.test_delete _____________________________\n\nself = <TestUser>\n\n    def test_delete(self):\n>       assert response.status_code == 204\nE       assert 403 == 204\nE        +  where 403 = <Response>.status_code\n\nposthog/api/test/test_user.py:88: AssertionError\n=========================== short test summary info ============================\nFAILED posthog/api/test/test_user.py::TestUser::test_delete - assert 403 == 204\n=================== 1 failed, 1 passed, 1 skipped in 4.21s ====================\n";
        let r = run("pytest posthog/api/test/test_user.py -v", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed, r.skipped), ("pytest", 1, 1, 1));
        assert_eq!(r.duration_ms, Some(4210.0));
        let f = failed(&r);
        assert_eq!((f[0].name.as_str(), f[0].suite.as_deref()), ("test_delete", Some("posthog/api/test/test_user.py::TestUser")));
        assert_eq!(f[0].location.as_deref(), Some("posthog/api/test/test_user.py:88"));
        assert!(f[0].message.as_deref().unwrap().starts_with("assert 403 == 204"));
        // Quiet mode: just the short summary and the counts.
        let q = run("python -m pytest -q", "..F\nFAILED tests/test_a.py::test_x - ValueError: bad\n1 failed, 2 passed in 0.31s\n");
        assert_eq!((q.passed, q.failed), (2, 1));
        assert_eq!(failed(&q)[0].message.as_deref(), Some("ValueError: bad"));
    }

    #[test]
    fn django() {
        let out = "Creating test database for alias 'default'...\ntest_create (accounts.tests.UserTests.test_create) ... ok\ntest_login (accounts.tests.UserTests.test_login) ... FAIL\ntest_old (accounts.tests.UserTests.test_old) ... skipped 'legacy'\n\n======================================================================\nFAIL: test_login (accounts.tests.UserTests.test_login)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File \"/app/accounts/tests.py\", line 31, in test_login\n    self.assertEqual(r.status_code, 302)\nAssertionError: 200 != 302\n\n----------------------------------------------------------------------\nRan 3 tests in 0.842s\n\nFAILED (failures=1, skipped=1)\nDestroying test database for alias 'default'...\n";
        let r = run("python manage.py test accounts -v 2", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed, r.skipped), ("django", 1, 1, 1));
        let f = failed(&r);
        assert_eq!((f[0].name.as_str(), f[0].suite.as_deref()), ("test_login", Some("accounts.tests.UserTests")));
        assert_eq!(f[0].location.as_deref(), Some("/app/accounts/tests.py:31"));
        assert!(f[0].message.as_deref().unwrap().ends_with("AssertionError: 200 != 302"));
        let ok = run("./manage.py test", "......\n----------------------------------------------------------------------\nRan 6 tests in 1.020s\n\nOK\n");
        assert_eq!((ok.passed, ok.failed), (6, 0));
    }

    #[test]
    fn jest() {
        let out = "PASS frontend/src/lib/utils.test.ts\nFAIL frontend/src/scenes/insights/Insight.test.tsx\n  Insight\n    ✓ renders (12 ms)\n    ✕ saves (30 ms)\n\n  ● Insight › saves\n\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: true\n    Received: false\n\n      at Object.<anonymous> (frontend/src/scenes/insights/Insight.test.tsx:44:23)\n      at node_modules/jest-circus/build/utils.js:298:28\n\nTest Suites: 1 failed, 1 passed, 2 total\nTests:       1 failed, 1 passed, 2 total\nSnapshots:   0 total\nTime:        3.412 s\n";
        let r = run("pnpm jest Insight", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed), ("jest", 1, 1));
        assert_eq!(r.duration_ms, Some(3412.0));
        let f = failed(&r);
        assert_eq!(f[0].name, "saves");
        assert_eq!(f[0].location.as_deref(), Some("frontend/src/scenes/insights/Insight.test.tsx:44"));
        assert!(f[0].message.as_deref().unwrap().contains("Received: false"));
    }

    #[test]
    fn vitest() {
        let out = " ✓ src/lib/diff.test.ts (6 tests) 4ms\n ❯ src/store.test.ts (12 tests | 1 failed) 20ms\n   × store > keeps the queue 5ms\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  src/store.test.ts > store > keeps the queue\nAssertionError: expected [] to deeply equal [ 'a' ]\n ❯ src/store.test.ts:88:31\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 17 passed (18)\n   Start at  22:40:32\n   Duration  2.26s (transform 1.64s)\n";
        let r = run("npm test -- --run", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed), ("vitest", 17, 1));
        assert_eq!(r.duration_ms, Some(2260.0));
        let f = failed(&r);
        assert_eq!(f.len(), 1);
        assert_eq!((f[0].name.as_str(), f[0].suite.as_deref()), ("keeps the queue", Some("store")));
        assert_eq!(f[0].location.as_deref(), Some("src/store.test.ts:88"));
        assert_eq!(f[0].message.as_deref(), Some("AssertionError: expected [] to deeply equal [ 'a' ]"));
    }

    #[test]
    fn playwright() {
        let out = "Running 3 tests using 2 workers\n\n  ✓  1 [chromium] › tests/login.spec.ts:5:3 › logs in (1.2s)\n  ✘  2 [chromium] › tests/login.spec.ts:12:3 › shows an error (5.0s)\n  -  3 [chromium] › tests/login.spec.ts:20:3 › later\n\n  1) [chromium] › tests/login.spec.ts:12:3 › shows an error ──────────────────\n\n    Error: expect(locator).toBeVisible() failed\n\n  1 failed\n  1 skipped\n  1 passed (7.4s)\n";
        let r = run("npx playwright test", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed, r.skipped), ("playwright", 1, 1, 1));
        let f = failed(&r);
        assert_eq!(f[0].name, "shows an error");
        assert_eq!(f[0].location.as_deref(), Some("tests/login.spec.ts:12"));
        assert!(f[0].message.as_deref().unwrap().contains("toBeVisible"));
    }

    #[test]
    fn xcodebuild_xctest() {
        let out = "Test Suite 'All tests' started at 2026-09-29 10:00:00.000.\nTest Case '-[AcmeTests.AuditTests testSave]' started.\nTest Case '-[AcmeTests.AuditTests testSave]' passed (0.012 seconds).\nTest Case '-[AcmeTests.AuditTests testSync]' started.\n/Users/me/ios-app/AcmeTests/AuditTests.swift:57: error: -[AcmeTests.AuditTests testSync] : XCTAssertEqual failed: (\"1\") is not equal to (\"2\")\nTest Case '-[AcmeTests.AuditTests testSync]' failed (0.034 seconds).\n\t Executed 2 tests, with 1 failure (0 unexpected) in 0.046 (0.047) seconds\nTest Suite 'All tests' failed at 2026-09-29 10:00:00.100.\n\t Executed 2 tests, with 1 failure (0 unexpected) in 0.046 (0.050) seconds\n** TEST FAILED **\n";
        let r = run("xcodebuild test -scheme Acme -destination 'platform=iOS Simulator,name=iPhone 17'", out);
        assert_eq!((r.framework.as_str(), r.passed, r.failed), ("swift", 1, 1));
        let f = failed(&r);
        assert_eq!((f[0].name.as_str(), f[0].suite.as_deref()), ("testSync", Some("AcmeTests.AuditTests")));
        assert_eq!(f[0].location.as_deref(), Some("/Users/me/ios-app/AcmeTests/AuditTests.swift:57"));
        assert!(f[0].message.as_deref().unwrap().contains("XCTAssertEqual failed"));
        assert_eq!(f[0].duration_ms, Some(34.0));
    }

    #[test]
    fn swift_testing() {
        let out = "◇ Test run started.\n◇ Test parsesDates() started.\n✔ Test parsesDates() passed after 0.002 seconds.\n◇ Test rejectsEmpty() started.\n✘ Test rejectsEmpty() recorded an issue at ParserTests.swift:21:5: Expectation failed: (result → nil) != nil\n✘ Test rejectsEmpty() failed after 0.003 seconds with 1 issue.\n✘ Test run with 2 tests failed after 0.010 seconds with 1 issue.\n";
        let r = run("swift test", out);
        assert_eq!((r.passed, r.failed), (1, 1));
        let f = failed(&r);
        assert_eq!(f[0].name, "rejectsEmpty()");
        assert_eq!(f[0].location.as_deref(), Some("ParserTests.swift:21"));
        assert!(f[0].message.as_deref().unwrap().starts_with("Expectation failed"));
    }

    /// Opt-in check against the real transcripts on this machine: every Bash step whose command mentions tests, what
    /// it parsed to. `cargo test --lib real_test_runs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_test_runs() {
        let root = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
        let (mut seen, mut parsed) = (0, 0);
        for dir in std::fs::read_dir(&root).unwrap().flatten() {
            for file in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
                if file.path().extension().is_none_or(|e| e != "jsonl") {
                    continue;
                }
                let mut p = crate::stream_parser::StreamParser::default();
                let mut commands = std::collections::HashMap::new();
                for line in std::fs::read_to_string(file.path()).unwrap_or_default().lines() {
                    let Ok(r) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                    let json = match r["type"].as_str() {
                        Some("assistant") => serde_json::json!({"type": "assistant", "message": r["message"]}),
                        Some("user") => serde_json::json!({"type": "user", "message": r["message"], "tool_use_result": r["toolUseResult"]}),
                        _ => continue,
                    };
                    for ev in p.parse_line(&json.to_string()) {
                        match ev {
                            crate::ui_event::UiEvent::ToolStarted { name, tool_use_id, summary, .. } if name == "Bash" && TEST_WORDS.iter().any(|w| summary.to_lowercase().contains(w)) => {
                                commands.insert(tool_use_id, summary);
                            }
                            crate::ui_event::UiEvent::ToolFinished { tool_use_id, .. } => {
                                if commands.remove(&tool_use_id).is_some() {
                                    seen += 1;
                                }
                            }
                            crate::ui_event::UiEvent::TestRun { command, run, .. } => {
                                parsed += 1;
                                let fails = run.cases.iter().filter(|c| c.status == CaseStatus::Failed).count();
                                let located = run.cases.iter().filter(|c| c.status == CaseStatus::Failed && c.location.is_some()).count();
                                println!("{:<10} {:<8?} {:>5}✓ {:>3}✕ {:>3}○ cases={:<5} failed-with-location={}/{} | {}", run.framework, run.outcome, run.passed, run.failed, run.skipped, run.cases.len(), located, fails, command.chars().take(90).collect::<String>());
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        println!("\n{seen} test-looking commands, {parsed} read as test runs");
    }

    #[test]
    fn a_run_fails_when_a_suite_cannot_load_even_with_no_failed_test() {
        let out = "FAIL src/a.test.ts\n  ● Test suite failed to run\n\n    Cannot find module '@posthog/hogvm' from 'src/cdp/x.ts'\n\nTest Suites: 1 failed, 1 total\nTests:       0 total\nTime:        0.711 s\n";
        let r = run("bash .setup/jest.sh src/cdp", out);
        assert_eq!(r.outcome, Outcome::Failed);
        assert!(failed(&r)[0].message.as_deref().unwrap().contains("Cannot find module"));
        assert_eq!(run("xcodebuild test -scheme X 2>&1 | tail -3", "** TEST SUCCEEDED **\n").outcome, Outcome::Passed);
        assert_eq!(run("xcodebuild test -scheme X 2>&1 | tail -3", "Testing failed:\n\tCannot find 'Foo' in scope\n** TEST FAILED **\n").outcome, Outcome::Failed);
        assert_eq!(run("cargo test", "error: could not compile `app` (lib test) due to 1 previous error\n").outcome, Outcome::Failed);
        assert_eq!(run("npx jest", "Test Suites: 0 total\nTests:       0 total\n").outcome, Outcome::Unknown);
    }

    #[test]
    fn strips_colour_codes() {
        let out = "\x1b[32mtest a ... ok\x1b[0m\ntest result: \x1b[32mok\x1b[0m. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n";
        assert_eq!(run("cargo test", out).passed, 1);
    }
}
