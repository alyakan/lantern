//! Insights: where the usage goes, what got done, how the user works, and whether the token savings work. Worked out on the Mac
//! from Claude Code's own logs (`~/.claude/projects`) and the projects' git history. Only these figures leave this module, and a
//! few chats' titles (the heaviest ones'), which are made from their first message: no path, log line or anything else said.
//!
//! "Weighted" tokens price each kind as the plans do, relative to plain input: a cache read is a tenth of one, a cache write a
//! quarter more, an output token five. It is what makes a chat that rereads 400k of context every call show as the cost it is.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::history;

const DAY_MS: u64 = 86_400_000;
const HOUR_MS: u64 = 3_600_000;
/// A prompt longer than this after Claude's last word is a break, not a reply: it isn't counted in how fast the user answers.
const REPLY_GAP_MAX_MS: u64 = 6 * HOUR_MS;
/// A call this long after the session's last prompt ran while the user was away.
const AWAY_AFTER_MS: u64 = 10 * 60_000;
/// How many of the heaviest chats are named.
const HEAVY_MAX: usize = 3;
/// How many projects' git histories are read at most.
const REPOS_MAX: usize = 20;

/// The stretch of time asked about. Savings compare it with the stretch of the same length before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum InsightsRange {
    Today,
    Week,
    Month,
}

impl InsightsRange {
    fn days(self) -> u64 {
        match self {
            Self::Today => 1,
            Self::Week => 7,
            Self::Month => 30,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Today => "yesterday",
            Self::Week => "the week before",
            Self::Month => "the month before",
        }
    }
}

/// One bar of a chart: an hour (today) or a day, and its weighted tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsBar {
    pub label: String,
    #[ts(type = "number")]
    pub weighted: u64,
}

/// A part of the whole (a project, a model): its weighted tokens and its share, 0 to 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsShare {
    pub name: String,
    #[ts(type = "number")]
    pub weighted: u64,
    pub share: f64,
}

/// One of the chats that cost the most, and why when it is plain ("410k context", "6 agents").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsChat {
    pub title: String,
    pub project: String,
    #[ts(type = "number")]
    pub weighted: u64,
    pub why: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsUsage {
    /// One sentence that answers "where is my usage going?".
    pub headline: String,
    #[ts(type = "number")]
    pub weighted: u64,
    /// Every token sent and received, unweighted.
    #[ts(type = "number")]
    pub tokens: u64,
    pub bars: Vec<InsightsBar>,
    pub projects: Vec<InsightsShare>,
    pub models: Vec<InsightsShare>,
    pub heavy: Vec<InsightsChat>,
}

/// A figure now, and in the stretch before (None: nothing then to compare with).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsCompare {
    pub now: f64,
    pub before: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsSavings {
    /// One sentence that answers "are the savings working?".
    pub headline: String,
    /// Tokens of context each call sends.
    pub per_call: InsightsCompare,
    /// The size of a chat's first call (what every chat starts with: the system prompt, tools and skills), the median.
    pub chat_start: InsightsCompare,
    /// The share of the context read from the cache, 0 to 1.
    pub cached: InsightsCompare,
    /// What the figures suggest, when something stands out.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsDone {
    /// One sentence that answers "what did I get done?".
    pub headline: String,
    /// Chats the user wrote in.
    pub chats: u32,
    /// The user's own commits, on any branch, and the lines they changed.
    pub commits: u32,
    #[ts(type = "number")]
    pub added: u64,
    #[ts(type = "number")]
    pub removed: u64,
    /// Pull requests merged into the default branch (squash merges, by their "(#123)").
    pub merged: u32,
    /// Tags made (releases).
    pub releases: u32,
    /// Commits per project, most first.
    pub projects: Vec<InsightsShare>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct InsightsHabits {
    /// One sentence that answers "how am I working?".
    pub headline: String,
    /// The user's messages by hour of the day (0 to 23, local time).
    pub hours: Vec<u32>,
    /// How long a chat waits for the user once Claude has finished, the median (None: no replies to measure).
    #[ts(type = "number | null")]
    pub reply_ms: Option<u64>,
    /// The share of Claude's calls made while the user was away (more than ten minutes after their last message), 0 to 1.
    pub away: f64,
}

/// Insights for one stretch of time (the answer to Request::Insights, and the window's Insights panel).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Insights {
    pub range: InsightsRange,
    #[ts(type = "number")]
    pub from: u64,
    #[ts(type = "number")]
    pub to: u64,
    /// What it is compared with: "the week before".
    pub before: String,
    pub usage: InsightsUsage,
    pub savings: InsightsSavings,
    pub done: InsightsDone,
    pub habits: InsightsHabits,
}

/// One call to the model, as a log line records it.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub at: u64,
    pub model: String,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    /// A subagent's (a Task's), not the chat's own.
    pub side: bool,
}

impl Call {
    fn context(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
    fn weighted(&self) -> u64 {
        self.input + self.cache_read / 10 + self.cache_write * 5 / 4 + self.output * 5
    }
}

/// One session (a chat), its calls and the user's prompts in it. Subagents' logs are folded into their chat's.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Session {
    pub project: String,
    /// The folder it ran in, for its git history.
    pub folder: String,
    pub title: String,
    pub calls: Vec<Call>,
    /// When the user wrote, in order.
    pub prompts: Vec<u64>,
    /// How many subagents it ran.
    pub agents: u32,
    /// A chat the user wrote in: not a team's worker (its Lead writes to it) or one of Lantern's own short calls to claude (a title,
    /// a recap, the Desk's router), whose tokens count but whose messages aren't the user's.
    pub yours: bool,
}

/// The project a folder belongs to, by its name: a worktree is its repository's (`<repo>-wt/<name>`, `<repo>/.worktrees/<name>`,
/// `<repo>/.claude/worktrees/<name>`, Lantern's own `worktrees/<repo>/<name>`), anything else is its own folder.
pub fn project_of(folder: &str) -> String {
    let parts: Vec<&str> = folder.split('/').filter(|p| !p.is_empty()).collect();
    for (i, p) in parts.iter().enumerate() {
        if let Some(repo) = p.strip_suffix("-wt") {
            if i + 1 < parts.len() && !repo.is_empty() {
                return repo.to_string();
            }
        }
        if (*p == ".worktrees" || *p == "worktrees") && i > 0 {
            let before = parts[i - 1];
            if before == ".claude" && i > 1 {
                return parts[i - 2].to_string();
            }
            if before.starts_with("io.github.") {
                return parts.get(i + 1).map_or("Lantern", |s| s).to_string();
            }
            return before.to_string();
        }
    }
    if history::is_temp(folder) {
        return "Scratch".into();
    }
    parts.last().map_or("No project", |s| s).to_string()
}

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a str>,
    timestamp: Option<&'a str>,
    #[serde(default, rename = "isSidechain")]
    side: bool,
    cwd: Option<String>,
    message: Option<Message<'a>>,
}

#[derive(Deserialize)]
struct Message<'a> {
    id: Option<&'a str>,
    #[serde(borrow)]
    model: Option<&'a str>,
    usage: Option<Usage>,
}

#[derive(Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// What one log file says: its calls and prompts (a call logged twice, as streaming does, counted once), its folder and title.
pub fn read_log(path: &Path) -> Session {
    let mut s = Session::default();
    let Ok(file) = std::fs::File::open(path) else { return s };
    let mut seen = HashSet::new();
    let mut first_prompt: Option<String> = None;
    let mut titled: Option<String> = None;
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(line) = serde_json::from_slice::<Line>(&buf) else { continue };
        if s.folder.is_empty() {
            if let Some(cwd) = &line.cwd {
                s.folder = cwd.clone();
            }
        }
        let at = line.timestamp.and_then(history::iso_ms);
        match line.kind {
            Some("assistant") => {
                let (Some(at), Some(m)) = (at, line.message) else { continue };
                let Some(u) = m.usage else { continue };
                if let Some(id) = m.id {
                    if !seen.insert(id.to_string()) {
                        continue;
                    }
                }
                let model = m.model.unwrap_or("").to_string();
                if model == "<synthetic>" {
                    continue;
                }
                s.calls.push(Call { at, model, input: u.input_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens, output: u.output_tokens, side: line.side });
            }
            // A line the user may have typed: read in full only then, and only when it isn't a tool's result.
            Some("user") if !line.side && !contains(&buf, b"\"tool_result\"") => {
                let Some(at) = at else { continue };
                let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) else { continue };
                if let Some(text) = history::prompt_text(&v) {
                    // What Lantern sends after a turn (the user's post-hook) isn't the user writing.
                    if crate::hooks::post_text(&text).is_none() {
                        s.prompts.push(at);
                    }
                    first_prompt.get_or_insert(text);
                }
            }
            Some("custom-title") | Some("ai-title") => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
                    if let Some((_, t)) = history::title_record(&v) {
                        titled = Some(t.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    s.title = titled.or_else(|| first_prompt.map(|p| history::title_of(&p))).unwrap_or_else(|| "Untitled chat".into());
    s.project = if s.folder.is_empty() { "No project".into() } else { project_of(&s.folder) };
    s.yours = !s.folder.is_empty() && !history::is_agent_folder(&s.folder) && !history::is_temp(&s.folder) && !s.prompts.is_empty();
    s
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The log files changed since `since`: each chat's own, with its subagents' (in `<chat>/subagents/`) beside it.
fn logs_since(root: &Path, since: u64) -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut found = vec![];
    let Ok(dirs) = std::fs::read_dir(root) else { return found };
    for dir in dirs.filter_map(Result::ok).map(|e| e.path()).filter(|p| history::is_real_dir(p)) {
        for file in history::jsonl_files(&dir) {
            let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let agents: Vec<PathBuf> = history::jsonl_files(&dir.join(&stem).join("subagents")).into_iter().filter(|p| history::modified_ms(p) >= since).collect();
            if history::modified_ms(&file) >= since || !agents.is_empty() {
                found.push((file, agents));
            }
        }
    }
    found
}

/// What each log file said, kept while the file is unchanged: a second look reads only what was written since.
/// A log file's size and when it changed, and what it said then.
type Kept = HashMap<PathBuf, (u64, u64, Session)>;
static READ: Mutex<Option<Kept>> = Mutex::new(None);

fn read_cached(path: &Path) -> Session {
    let meta = std::fs::metadata(path).ok();
    let key = (meta.as_ref().map_or(0, |m| m.len()), history::modified_ms(path));
    if let Some((len, at, s)) = READ.lock().unwrap().get_or_insert_with(HashMap::new).get(path) {
        if (*len, *at) == key {
            return s.clone();
        }
    }
    let s = read_log(path);
    READ.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), (key.0, key.1, s.clone()));
    s
}

/// Every chat with something in it since `since`, its subagents folded in.
pub fn sessions_since(root: &Path, since: u64) -> Vec<Session> {
    logs_since(root, since)
        .into_iter()
        .map(|(file, agents)| {
            let mut s = read_cached(&file);
            s.agents = agents.len() as u32;
            for a in agents {
                s.calls.extend(read_cached(&a).calls.into_iter().map(|c| Call { side: true, ..c }));
            }
            s
        })
        .collect()
}

/// The local time's offset from UTC, in ms, at `ms`.
pub fn local_offset_ms(ms: u64) -> i64 {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    tm.tm_gmtoff * 1000
}

fn local(ms: u64, offset: i64) -> u64 {
    (ms as i64 + offset).max(0) as u64
}

/// The start of the local day `ms` is in.
fn day_start(ms: u64, offset: i64) -> u64 {
    let l = local(ms, offset);
    ((l - l % DAY_MS) as i64 - offset).max(0) as u64
}

const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

fn hour_name(h: u64) -> String {
    match h % 24 {
        0 => "midnight".into(),
        12 => "noon".into(),
        h if h < 12 => format!("{h} am"),
        h => format!("{} pm", h - 12),
    }
}

fn median(mut v: Vec<u64>) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

fn shares(by: HashMap<String, u64>, total: u64, max: usize) -> Vec<InsightsShare> {
    let mut v: Vec<InsightsShare> = by.into_iter().filter(|(_, w)| *w > 0).map(|(name, weighted)| InsightsShare { share: if total == 0 { 0.0 } else { weighted as f64 / total as f64 }, name, weighted }).collect();
    v.sort_by(|a, b| b.weighted.cmp(&a.weighted).then(a.name.cmp(&b.name)));
    v.truncate(max);
    v
}

/// A model's id as a person says it: "claude-sonnet-5-5" is Sonnet 5.5.
fn model_name(id: &str) -> String {
    let id = id.trim_start_matches("claude-");
    let mut parts = id.split('-');
    let Some(family) = parts.next().filter(|f| !f.is_empty()) else { return "Other".into() };
    let version: Vec<&str> = parts.take_while(|p| p.chars().all(|c| c.is_ascii_digit()) && p.len() <= 2).collect();
    let mut name = family[..1].to_uppercase() + &family[1..];
    if !version.is_empty() {
        name.push(' ');
        name.push_str(&version.join("."));
    }
    name
}

fn pct_change(now: f64, before: f64) -> i64 {
    if before == 0.0 {
        return 0;
    }
    ((now - before) / before * 100.0).round() as i64
}

fn round_k(tokens: f64) -> String {
    if tokens >= 1_000_000.0 {
        format!("{:.1}M", tokens / 1_000_000.0)
    } else {
        format!("{}k", (tokens / 1000.0).round() as u64)
    }
}

/// Usage, savings and habits from the chats' logs, for `[from, to)`; `before_from` starts the stretch the savings compare with.
pub fn from_logs(sessions: &[Session], range: InsightsRange, from: u64, to: u64, offset: i64) -> (InsightsUsage, InsightsSavings, InsightsHabits, u32) {
    let before_from = from.saturating_sub(range.days() * DAY_MS);
    let inside = |at: u64| at >= from && at < to;
    let earlier = |at: u64| at >= before_from && at < from;

    // Usage.
    let (mut weighted, mut tokens) = (0u64, 0u64);
    let mut by_project: HashMap<String, u64> = HashMap::new();
    let mut by_model: HashMap<String, u64> = HashMap::new();
    let mut hours_w = [0u64; 24];
    let bars_n = if range == InsightsRange::Today { 24 } else { range.days() as usize };
    let mut bars = vec![0u64; bars_n];
    let mut heavy: Vec<InsightsChat> = vec![];
    for s in sessions {
        let mut mine = 0u64;
        let (mut ctx, mut n) = (0u64, 0u64);
        for c in s.calls.iter().filter(|c| inside(c.at)) {
            let w = c.weighted();
            mine += w;
            tokens += c.context() + c.output;
            *by_model.entry(model_name(&c.model)).or_default() += w;
            hours_w[(local(c.at, offset) % DAY_MS / HOUR_MS) as usize] += w;
            let i = if range == InsightsRange::Today { ((c.at - from) / HOUR_MS) as usize } else { ((day_start(c.at, offset).saturating_sub(day_start(from, offset))) / DAY_MS) as usize };
            if let Some(b) = bars.get_mut(i) {
                *b += w;
            }
            if !c.side {
                ctx += c.context();
                n += 1;
            }
        }
        if mine == 0 {
            continue;
        }
        weighted += mine;
        *by_project.entry(s.project.clone()).or_default() += mine;
        let avg = ctx.checked_div(n).unwrap_or(0);
        let why = if s.agents >= 2 { Some(format!("{} agents", s.agents)) } else if avg >= 150_000 { Some(format!("{} context", round_k(avg as f64))) } else if n >= 400 { Some(format!("{n} calls")) } else { None };
        heavy.push(InsightsChat { title: s.title.clone(), project: s.project.clone(), weighted: mine, why });
    }
    heavy.sort_by_key(|h| std::cmp::Reverse(h.weighted));
    heavy.truncate(HEAVY_MAX);
    let projects = shares(by_project, weighted, 6);
    let models = shares(by_model, weighted, 4);
    // The four hours that cost the most, as a stretch of the day.
    let peak = (0..24u64).max_by_key(|h| (0..4).map(|k| hours_w[((h + k) % 24) as usize]).sum::<u64>()).filter(|_| weighted > 0);
    let usage_headline = match (peak, projects.first()) {
        (None, _) => "Nothing ran in this stretch.".to_string(),
        (Some(h), Some(top)) if top.share >= 0.5 && projects.len() > 1 => format!("{} takes {}%. You use the most between {} and {}.", top.name, (top.share * 100.0).round(), hour_name(h), hour_name(h + 4)),
        (Some(h), _) => format!("You use the most between {} and {}.", hour_name(h), hour_name(h + 4)),
    };
    let start_day = local(day_start(from, offset), offset) / DAY_MS;
    let bars = bars
        .into_iter()
        .enumerate()
        .map(|(i, w)| InsightsBar { label: if range == InsightsRange::Today { format!("{}", (local(from, offset) / HOUR_MS + i as u64) % 24) } else if range == InsightsRange::Week { WEEKDAYS[((start_day + i as u64) % 7) as usize].to_string() } else { format!("{}", i + 1) }, weighted: w })
        .collect();

    // Savings: the chats' own calls (a subagent's start is its own, smaller one).
    let figures = |when: &dyn Fn(u64) -> bool| -> Option<(f64, f64, f64)> {
        let (mut ctx, mut read, mut n) = (0u64, 0u64, 0u64);
        let mut starts = vec![];
        for s in sessions {
            if let Some(first) = s.calls.iter().find(|c| !c.side) {
                if when(first.at) {
                    starts.push(first.context());
                }
            }
            for c in s.calls.iter().filter(|c| !c.side && when(c.at)) {
                ctx += c.context();
                read += c.cache_read;
                n += 1;
            }
        }
        (n > 0).then(|| (ctx as f64 / n as f64, median(starts).unwrap_or(0) as f64, read as f64 / ctx.max(1) as f64))
    };
    let now = figures(&inside).unwrap_or((0.0, 0.0, 0.0));
    let then = figures(&earlier);
    let per_call = InsightsCompare { now: now.0, before: then.map(|t| t.0) };
    let chat_start = InsightsCompare { now: now.1, before: then.map(|t| t.1).filter(|v| *v > 0.0) };
    let cached = InsightsCompare { now: now.2, before: then.map(|t| t.2) };
    let savings_headline = match then {
        _ if now.0 == 0.0 => "Nothing to compare yet.".to_string(),
        None => format!("Each call sends {} of context. There's nothing from {} to compare with.", round_k(now.0), range.name()),
        Some(t) => {
            let d = pct_change(now.0, t.0);
            if d <= -5 {
                format!("Each call sends {}% less than {}.", -d, range.name())
            } else if d >= 5 {
                format!("Each call sends {d}% more than {}.", range.name())
            } else {
                format!("Each call sends about as much as {}.", range.name())
            }
        }
    };
    let note = match then {
        Some(t) if t.1 > 0.0 && now.1 > 0.0 && pct_change(now.1, t.1).abs() < 5 && now.1 >= 30_000.0 => Some(format!("Chats still start at {}: a preset with plugins off starts lighter.", round_k(now.1))),
        _ if now.2 > 0.0 && now.2 < 0.7 => Some("Under 70% comes from the cache: long pauses in a chat let it expire.".into()),
        _ => None,
    };
    let savings = InsightsSavings { headline: savings_headline, per_call, chat_start, cached, note };

    // Habits.
    let mut hours = vec![0u32; 24];
    let mut replies = vec![];
    let (mut away, mut calls) = (0u64, 0u64);
    let mut chats = 0u32;
    // Only the chats the user wrote in: a team's worker hears from its Lead, not from the user.
    for s in sessions.iter().filter(|s| s.yours) {
        let mut wrote = false;
        for &p in s.prompts.iter().filter(|p| inside(**p)) {
            wrote = true;
            hours[(local(p, offset) % DAY_MS / HOUR_MS) as usize] += 1;
            // How long since Claude's last call before it: how long the chat waited on the user.
            if let Some(last) = s.calls.iter().filter(|c| !c.side && c.at < p).map(|c| c.at).max() {
                let gap = p - last;
                if gap <= REPLY_GAP_MAX_MS {
                    replies.push(gap);
                }
            }
        }
        if wrote {
            chats += 1;
        }
        for c in s.calls.iter().filter(|c| inside(c.at)) {
            calls += 1;
            let asked = s.prompts.iter().filter(|p| **p <= c.at).max();
            if asked.is_none_or(|p| c.at - p > AWAY_AFTER_MS) {
                away += 1;
            }
        }
    }
    let reply_ms = median(replies);
    let away_share = if calls == 0 { 0.0 } else { away as f64 / calls as f64 };
    let busiest = (0..24).max_by_key(|h| hours[*h]).filter(|h| hours[*h] > 0);
    let habits_headline = match (busiest, reply_ms) {
        (None, _) => "You didn't write to a chat in this stretch.".to_string(),
        (Some(h), Some(r)) => format!("You write most around {}. A finished chat waits about {} for you.", hour_name(h as u64), duration(r)),
        (Some(h), None) => format!("You write most around {}.", hour_name(h as u64)),
    };
    let habits = InsightsHabits { headline: habits_headline, hours, reply_ms, away: away_share };
    (InsightsUsage { headline: usage_headline, weighted, tokens, bars, projects, models, heavy }, savings, habits, chats)
}

/// "40 s", "6 min", "2 h".
pub fn duration(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min", s / 60)
    } else {
        format!("{} h", s / 3600)
    }
}

/// What git says one project did in `[from, to)`: the user's commits and lines, merged pull requests, tags.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RepoDone {
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
    pub merged: u32,
    pub releases: u32,
}

/// Git, read-only, through the same guards as the model's own git tool: the folders come from the logs, and any of them may be a
/// repository whose config names a program to run (a diff driver, an fsmonitor), which these never start.
fn git(dir: &Path, args: &[&str], path_env: Option<&str>) -> Option<String> {
    crate::read_git::stdout(dir, args, path_env)
}

/// The user's own git email (their global config, never a repository's): whose commits are theirs.
fn user_email(path_env: Option<&str>) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir("/").args(["config", "--global", "--get", "user.email"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let out = cmd.output().ok()?;
    let email = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !email.is_empty()).then_some(email)
}

/// The commits' `--shortstat` lines, added up: (commits, added, removed). Each commit's line is `commit <author time> <subject>`;
/// one rebased or cherry-picked keeps both, so it is counted once however many branches still hold a copy.
pub fn shortstat(log: &str) -> (u32, u64, u64) {
    let (mut commits, mut added, mut removed) = (0, 0, 0);
    let mut seen = HashSet::new();
    let mut counting = false;
    for line in log.lines() {
        if let Some(key) = line.strip_prefix("commit ") {
            counting = seen.insert(key.to_string());
            if counting {
                commits += 1;
            }
            continue;
        }
        if !counting {
            continue;
        }
        for part in line.split(',') {
            let part = part.trim();
            let n: u64 = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
            if part.contains("insertion") {
                added += n;
            } else if part.contains("deletion") {
                removed += n;
            }
        }
    }
    (commits, added, removed)
}

/// Merged pull requests among a default branch's subjects: a squash merge's "(#123)" or a merge commit's "Merge pull request #123",
/// and not a release's own version bump.
pub fn merged_prs(subjects: &str) -> u32 {
    subjects
        .lines()
        .filter(|s| {
            let s = s.trim();
            let squash = s.ends_with(')') && s.rfind("(#").is_some_and(|i| s[i + 2..s.len() - 1].chars().all(|c| c.is_ascii_digit()));
            (squash || s.starts_with("Merge pull request #")) && !s.starts_with("chore: release")
        })
        .count() as u32
}

/// What one repository did in `[from, to)` that is the user's: their commits (any branch), their pull requests merged into the
/// default branch (a squash merge is the pull request's author's commit), and version tags (`v…`, not a build's own tags). Without
/// the user's email nothing can be told to be theirs, and nothing is counted.
fn repo_done(root: &Path, email: &str, from: u64, to: u64, path_env: Option<&str>) -> RepoDone {
    let (since, until, author) = (format!("--since=@{}", from / 1000), format!("--until=@{}", to / 1000), format!("--author={email}"));
    let (commits, added, removed) = git(root, &["log", "--all", "--no-merges", "--shortstat", "--format=commit %at %s", &since, &until, &author], path_env).map(|l| shortstat(&l)).unwrap_or_default();
    let merged = git(root, &["log", "origin/HEAD", "--first-parent", "--format=%s", &since, &until, &author], path_env).map(|l| merged_prs(&l)).unwrap_or(0);
    let releases = git(root, &["tag", "--list", "v*", "--format=%(creatordate:unix) %(taggeremail)%(authoremail)"], path_env).map(|l| tags_in(&l, email, from, to)).unwrap_or(0);
    RepoDone { commits, added, removed, merged, releases }
}

/// How many of the tags (`<creatordate:unix> <tagger's or commit's email>`, one a line) the user made in `[from, to)`.
pub fn tags_in(lines: &str, email: &str, from: u64, to: u64) -> u32 {
    let mine = format!("<{}>", email.to_lowercase());
    lines
        .lines()
        .filter_map(|l| l.trim().split_once(' '))
        .filter(|(_, who)| who.to_lowercase().contains(&mine))
        .filter_map(|(t, _)| t.parse::<u64>().ok())
        .filter(|t| *t * 1000 >= from && *t * 1000 < to)
        .count() as u32
}

/// The repositories the chats ran in (a worktree is its repository's), by their project's name.
fn repos(sessions: &[Session], path_env: Option<&str>) -> Vec<(String, PathBuf)> {
    let mut by_root: BTreeMap<PathBuf, String> = BTreeMap::new();
    let folders: HashSet<&str> = sessions.iter().filter(|s| s.yours).map(|s| s.folder.as_str()).filter(|f| !f.is_empty() && !history::is_temp(f)).collect();
    for f in folders {
        let dir = Path::new(f);
        if !dir.is_dir() {
            continue;
        }
        let Some(common) = git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], path_env) else { continue };
        let Some(root) = Path::new(common.trim()).parent().map(Path::to_path_buf) else { continue };
        by_root.entry(root.clone()).or_insert_with(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        if by_root.len() >= REPOS_MAX {
            break;
        }
    }
    by_root.into_iter().map(|(root, name)| (name, root)).collect()
}

fn done_of(sessions: &[Session], from: u64, to: u64, chats: u32, path_env: Option<&str>) -> InsightsDone {
    let email = user_email(path_env);
    let mut total = RepoDone::default();
    let mut by: HashMap<String, u64> = HashMap::new();
    for (name, root) in email.as_deref().map(|_| repos(sessions, path_env)).unwrap_or_default() {
        let d = repo_done(&root, email.as_deref().unwrap_or_default(), from, to, path_env);
        total.commits += d.commits;
        total.added += d.added;
        total.removed += d.removed;
        total.merged += d.merged;
        total.releases += d.releases;
        *by.entry(name).or_default() += d.commits as u64;
    }
    let projects = shares(by, total.commits as u64, 5);
    let headline = if total.commits == 0 && total.merged == 0 {
        format!("{chats} {} and no commits of yours yet.", if chats == 1 { "chat" } else { "chats" })
    } else {
        let mut parts = vec![format!("{} {}", total.merged, if total.merged == 1 { "pull request merged" } else { "pull requests merged" })];
        if total.releases > 0 {
            parts.push(format!("{} {}", total.releases, if total.releases == 1 { "release" } else { "releases" }));
        }
        parts.push(format!("{} {}", total.commits, if total.commits == 1 { "commit" } else { "commits" }));
        let mut s = parts.join(", ");
        if let Some(top) = projects.first().filter(|_| projects.len() > 1) {
            s.push_str(&format!(", most in {}", top.name));
        }
        s.push('.');
        s
    };
    InsightsDone { headline, chats, commits: total.commits, added: total.added, removed: total.removed, merged: total.merged, releases: total.releases, projects }
}

/// Insights now, for `range`: from Claude Code's logs under `projects_root` and the git histories of the projects they ran in. It
/// reads a lot (weeks of logs), so it runs off the async threads; a log file read before is read again only once it has changed.
pub fn insights(projects_root: &Path, range: InsightsRange, now: u64, path_env: Option<&str>) -> Insights {
    let offset = local_offset_ms(now);
    let to = now;
    let from = if range == InsightsRange::Today { day_start(now, offset) } else { day_start(now, offset).saturating_sub((range.days() - 1) * DAY_MS) };
    let sessions = sessions_since(projects_root, from.saturating_sub(range.days() * DAY_MS));
    let (usage, savings, habits, chats) = from_logs(&sessions, range, from, to, offset);
    let done = done_of(&sessions, from, to, chats, path_env);
    Insights { range, from, to, before: range.name().into(), usage, savings, done, habits }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(at: u64, ctx: u64, side: bool) -> Call {
        Call { at, model: "claude-sonnet-5-5".into(), input: 0, cache_read: ctx * 9 / 10, cache_write: ctx / 10, output: 100, side }
    }

    #[test]
    fn a_worktree_counts_as_its_repository() {
        assert_eq!(project_of("/Users/me/dev/lantern-wt/phone-tabs"), "lantern");
        assert_eq!(project_of("/Users/me/dev/rayak/.worktrees/games"), "rayak");
        assert_eq!(project_of("/Users/me/dev/app/.claude/worktrees/agent-1"), "app");
        assert_eq!(project_of("/Users/me/Library/Application Support/io.github.alyakan.lantern/worktrees/rayak/ios-games-w23"), "rayak");
        assert_eq!(project_of("/Users/me/dev/lantern"), "lantern");
    }

    #[test]
    fn a_model_is_named_as_people_say_it() {
        assert_eq!(model_name("claude-sonnet-5-5"), "Sonnet 5.5");
        assert_eq!(model_name("claude-haiku-5-5-20260101"), "Haiku 5.5");
        assert_eq!(model_name("claude-fable-5-1"), "Fable 5.1");
    }

    #[test]
    fn a_log_is_read_once_per_call_and_only_the_users_own_words_are_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-05T10:00:00Z","cwd":"/Users/me/dev/lantern-wt/x","message":{"role":"user","content":"Make the tab bar glass"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-05T10:00:05Z","message":{"id":"m1","model":"claude-sonnet-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":9000,"cache_creation_input_tokens":1000,"output_tokens":50}}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-05T10:00:06Z","message":{"id":"m1","model":"claude-sonnet-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":9000,"cache_creation_input_tokens":1000,"output_tokens":50}}}"#,
            r#"{"type":"user","timestamp":"2026-11-05T10:00:07Z","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-05T10:01:00Z","message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-05T10:01:05Z","message":{"id":"m2","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#,
            "not json",
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let s = read_log(&path);
        assert_eq!(s.calls.len(), 1, "a call streamed twice is one call, and a synthetic one isn't a call");
        assert_eq!(s.prompts.len(), 1, "a tool's result and an injected reminder aren't the user's words");
        assert_eq!((s.project.as_str(), s.title.as_str()), ("lantern", "Make the tab bar glass"));
        assert_eq!(s.calls[0].weighted(), 10 + 900 + 1250 + 250);
    }

    #[test]
    fn usage_names_where_it_went_and_savings_compare_with_the_stretch_before() {
        let day = DAY_MS;
        let from = 20 * day;
        let to = 21 * day;
        let s = |project: &str, calls: Vec<Call>, prompts: Vec<u64>| Session { project: project.into(), folder: String::new(), title: format!("{project} chat"), calls, prompts, agents: 0, yours: true };
        let sessions = vec![
            // The day before: big calls.
            s("lantern", vec![call(from - day + HOUR_MS, 200_000, false), call(from - day + 2 * HOUR_MS, 200_000, false)], vec![from - day + HOUR_MS - 1000]),
            // Today: smaller ones, most in lantern.
            s("lantern", vec![call(from + 14 * HOUR_MS, 100_000, false), call(from + 15 * HOUR_MS, 100_000, false), call(from + 15 * HOUR_MS + 1, 50_000, true)], vec![from + 14 * HOUR_MS - 60_000, from + 15 * HOUR_MS + 30 * 60_000]),
            s("rayak", vec![call(from + 9 * HOUR_MS, 20_000, false)], vec![from + 9 * HOUR_MS - 1000]),
        ];
        let (usage, savings, habits, chats) = from_logs(&sessions, InsightsRange::Today, from, to, 0);
        assert_eq!(chats, 2);
        assert_eq!(usage.projects[0].name, "lantern");
        assert!(usage.projects[0].share > 0.8);
        assert!(usage.headline.contains("lantern takes"), "{}", usage.headline);
        assert_eq!(usage.bars.len(), 24);
        assert!(usage.bars[14].weighted > 0 && usage.bars[3].weighted == 0);
        assert_eq!(usage.models[0].name, "Sonnet 5.5");
        // The chats' own calls: 100k, 100k, 20k today (the subagent's isn't one) against 200k, 200k.
        assert_eq!(savings.per_call.now.round(), 73_333.0);
        assert_eq!(savings.per_call.before, Some(200_000.0));
        assert!(savings.headline.contains("63% less than yesterday"), "{}", savings.headline);
        assert_eq!(habits.hours.iter().sum::<u32>(), 3);
        // Claude's last call at 15:00, the user back at 15:30: a 30-minute wait.
        assert_eq!(habits.reply_ms, Some(30 * 60_000));
    }

    #[test]
    fn git_counts_the_users_lines_and_merged_pull_requests_but_not_a_version_bump() {
        let log = "commit 1 feat: a\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\ncommit 2 fix: b\n\n 1 file changed, 1 insertion(+)\ncommit 1 feat: a\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n";
        assert_eq!(shortstat(log), (2, 11, 2), "a rebased copy of a commit is the same commit");
        let subjects = "feat: glass tab bar (#435)\nchore: release 0.1.109 (#434)\nfix: thing\nMerge pull request #12 from x/y\nnote (#abc)\n";
        assert_eq!(merged_prs(subjects), 2);
    }

    #[test]
    fn a_team_workers_messages_and_a_post_hook_are_not_the_user_writing() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, cwd: &str, text: &str| {
            let path = dir.path().join(name);
            let user = |t: &str, at: &str| format!(r#"{{"type":"user","timestamp":"{at}","cwd":"{cwd}","message":{{"role":"user","content":{}}}}}"#, serde_json::to_string(t).unwrap());
            std::fs::write(&path, [user(text, "2026-11-05T10:00:00Z"), user("[Lantern post-hook]\nUpdate the brain if needed", "2026-11-05T10:05:00Z")].join("\n")).unwrap();
            read_log(&path)
        };
        let mine = write("a.jsonl", "/Users/me/dev/lantern", "Make it glass");
        assert_eq!(mine.prompts.len(), 1, "the post-hook isn't counted as the user writing");
        assert!(mine.yours);
        let worker = write("b.jsonl", "/Users/me/Library/Application Support/io.github.alyakan.lantern/worktrees/lantern/fix-w2", "Do the fix");
        assert!(!worker.yours, "a team's worker hears from its Lead");
    }

    #[test]
    fn a_tag_counts_in_the_stretch_it_was_made_in() {
        let tags = "100 <me@x.com>\n200 <Me@X.com>\n210 <them@x.com>\nnot a time\n300 <me@x.com>\n";
        assert_eq!(tags_in(tags, "me@x.com", 150_000, 300_000), 1, "only the user's, in the stretch");
    }

    #[test]
    fn git_for_insights_is_the_guarded_read_only_kind() {
        // What Insights asks of git passes the model's own git tool's checks: nothing that writes or starts a program.
        for args in [
            vec!["log", "--all", "--no-merges", "--shortstat", "--format=commit %at %s", "--since=@1", "--until=@2", "--author=me@example.com"],
            vec!["log", "origin/HEAD", "--first-parent", "--format=%s", "--since=@1", "--until=@2", "--author=me@example.com"],
            vec!["tag", "--list", "v*", "--format=%(creatordate:unix) %(taggeremail)%(authoremail)"],
            vec!["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            assert!(crate::read_git::validate(&args).is_ok(), "{args:?}");
        }
    }

    #[test]
    fn a_duration_is_said_in_its_largest_unit() {
        assert_eq!(duration(40_000), "40 s");
        assert_eq!(duration(6 * 60_000), "6 min");
        assert_eq!(duration(2 * HOUR_MS + 5), "2 h");
    }
}


