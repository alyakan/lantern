//! Memory: a read-only look at how this Mac's RAM is used, for the Storage panel's Memory tab. It shows and never acts: no
//! process is signalled, nothing is written, and only names reach the screen.
//!
//! Exactly these programs run, each by its absolute path with an argument vector (no shell), a time limit and an output cap:
//!   /usr/bin/vm_stat
//!   /usr/sbin/sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level
//!   /bin/ps -axo pid=,ppid=,rss=,comm=
//! `ps` is asked for `comm` (the executable's path) and never for `args` or `command`: a command line can hold a token or a
//! password, so it is never requested, read or returned. Pids and paths are used here to group processes and are dropped:
//! the snapshot carries an app's name, its size, its process count and its share.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const VM_STAT: &str = "/usr/bin/vm_stat";
const SYSCTL: &str = "/usr/sbin/sysctl";
const PS: &str = "/bin/ps";
const SYSCTL_KEYS: [&str; 3] = ["hw.memsize", "vm.swapusage", "kern.memorystatus_vm_pressure_level"];
/// pid, parent pid, resident size in KB, and the executable's name or path: no command line.
const PS_ARGS: [&str; 2] = ["-axo", "pid=,ppid=,rss=,comm="];
const LIMIT: Duration = Duration::from_secs(5);
/// More than this from any of them is not a process list: the read is dropped.
const CAP: usize = 8 * 1024 * 1024;
/// How many apps are listed by name; the rest are "Other apps".
pub const TOP_APPS: usize = 15;

pub const LANTERN_NAME: &str = "Lantern and its agents";
const MACOS_NAME: &str = "macOS";
const OTHER_NAME: &str = "Other apps";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    App,
    /// Lantern and every process below it: the agents (`claude`, `node`, `vite`...) and what they started.
    Lantern,
    Macos,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

/// Where the pressure level came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PressureSource {
    /// The kernel's own level (`kern.memorystatus_vm_pressure_level`), what Activity Monitor draws.
    Kernel,
    /// Worked out from the free, cached and compressed shares, when the kernel's level couldn't be read.
    Estimated,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct App {
    pub name: String,
    /// Resident memory of all its processes (shared pages counted in each, so scaled down if they add up to more than is used).
    pub bytes: u64,
    pub processes: usize,
    /// Its part of the Mac's whole RAM, 0 to 1.
    pub share: f64,
    pub kind: Kind,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub total_bytes: u64,
    /// App memory, wired and compressed: what can't be handed over without cost.
    pub used_bytes: u64,
    /// Inactive and speculative pages: kept for reuse, given back when something needs them.
    pub cached_bytes: u64,
    pub free_bytes: u64,
    /// What the compressor holds, already inside `used_bytes`.
    pub compressed_bytes: u64,
    pub swap_used_bytes: Option<u64>,
    pub pressure: Pressure,
    pub pressure_source: PressureSource,
    /// The processes' resident sizes added up to more than is used (shared pages), so every app was scaled down to fit.
    pub scaled: bool,
    /// By size, largest first (Other apps last); their bytes add up to `used_bytes`.
    pub apps: Vec<App>,
}

/// vm_stat's counts, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct VmStat {
    pub free: u64,
    pub active: u64,
    pub inactive: u64,
    pub speculative: u64,
    pub wired: u64,
    pub compressed: u64,
}

/// One row of `ps`: nothing of it but its place in the tree, its size and its executable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub rss_kb: u64,
    pub comm: String,
}

/// What a read of the Mac's memory found, parsed: the part that doesn't depend on the process list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sections {
    pub total: u64,
    pub used: u64,
    pub cached: u64,
    pub free: u64,
    pub compressed: u64,
}

pub fn snapshot() -> Result<Snapshot, String> {
    let vm = parse_vm_stat(&run(VM_STAT, &[], false)?)?;
    let sys = parse_sysctl(&run(SYSCTL, &SYSCTL_KEYS, true)?);
    let total = sys.memsize.ok_or("sysctl didn't say how much memory this Mac has")?;
    let mem = sections(total, &vm);
    let me = std::process::id();
    let mut procs = parse_ps(&run(PS, &PS_ARGS, false)?);
    // The `ps` this just ran is Lantern's child for a moment: it isn't a process of Lantern's to count.
    procs.retain(|p| !(p.ppid == me && p.comm == PS));
    let (apps, scaled) = group(&procs, me, mem.used, total);
    let (pressure, pressure_source) = match sys.pressure {
        Some(p) => (p, PressureSource::Kernel),
        None => (estimate_pressure(&mem), PressureSource::Estimated),
    };
    Ok(Snapshot { total_bytes: total, used_bytes: mem.used, cached_bytes: mem.cached, free_bytes: mem.free, compressed_bytes: mem.compressed, swap_used_bytes: sys.swap_used, pressure, pressure_source, scaled, apps })
}

/// Runs one of the programs above and returns what it printed. `lenient` keeps the output of a program that exits with an error
/// (sysctl does when one of its keys is unknown, and still prints the others).
fn run(program: &str, args: &[&str], lenient: bool) -> Result<String, String> {
    let mut child = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("could not run {program}: {e}"))?;
    let pipe = child.stdout.take();
    // Read at most CAP bytes and one more, to tell "exactly CAP" from "more": dropping the pipe ends a program that keeps writing.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(p) = pipe {
            let _ = p.take(CAP as u64 + 1).read_to_end(&mut bytes);
        }
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} took longer than {} seconds and was stopped", LIMIT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("could not run {program}: {e}")),
        }
    };
    let bytes = reader.join().unwrap_or_default();
    if bytes.len() > CAP {
        let _ = child.kill();
        return Err(format!("{program} printed more than {} MB", CAP / 1024 / 1024));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if status.success() || (lenient && !text.trim().is_empty()) {
        Ok(text)
    } else {
        Err(format!("{program} failed"))
    }
}

/// `vm_stat`: the page size from its first line, then "Pages free:  25817." and so on, as bytes.
pub fn parse_vm_stat(text: &str) -> Result<VmStat, String> {
    let page: u64 = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .filter(|p| *p > 0)
        .ok_or("vm_stat didn't give a page size")?;
    let pages = |key: &str| -> Option<u64> { text.lines().find_map(|l| l.strip_prefix(key)?.trim_start().strip_prefix(':')?.trim().trim_end_matches('.').parse().ok()) };
    let get = |key: &str| pages(key).map(|n| n.saturating_mul(page)).ok_or_else(|| format!("vm_stat has no \"{key}\" line"));
    Ok(VmStat { free: get("Pages free")?, active: get("Pages active")?, inactive: get("Pages inactive")?, speculative: get("Pages speculative").unwrap_or(0), wired: get("Pages wired down")?, compressed: get("Pages occupied by compressor").unwrap_or(0) })
}

#[derive(Debug, PartialEq)]
pub struct Sysctl {
    pub memsize: Option<u64>,
    pub swap_used: Option<u64>,
    pub pressure: Option<Pressure>,
}

/// `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`: "key: value" lines, any of which may be missing.
pub fn parse_sysctl(text: &str) -> Sysctl {
    let mut out = Sysctl { memsize: None, swap_used: None, pressure: None };
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "hw.memsize" => out.memsize = value.parse().ok().filter(|n| *n > 0),
            "vm.swapusage" => out.swap_used = swap_used(value),
            // 1 normal, 2 warning, 4 critical; anything else isn't a level this knows.
            "kern.memorystatus_vm_pressure_level" => {
                out.pressure = match value {
                    "1" => Some(Pressure::Normal),
                    "2" => Some(Pressure::Warning),
                    "4" => Some(Pressure::Critical),
                    _ => None,
                }
            }
            _ => {}
        }
    }
    out
}

/// "total = 9216.00M  used = 7986.12M  free = 1229.88M  (encrypted)" -> the used part, in bytes (1024-based, as sysctl writes it).
fn swap_used(value: &str) -> Option<u64> {
    let rest = value.split("used =").nth(1)?.split_whitespace().next()?;
    let (number, unit) = rest.split_at(rest.len().checked_sub(1)?);
    let factor: f64 = match unit {
        "K" => 1024.0,
        "M" => 1024.0 * 1024.0,
        "G" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    let n: f64 = number.parse().ok()?;
    (n >= 0.0).then(|| (n * factor) as u64)
}

/// Splits the RAM into used, cached and free so that the three add up to the total: used is active, wired and compressed pages;
/// cached is the inactive and speculative ones; free is what is left (vm_stat's own free count plus the odd throttled or
/// purgeable page that belongs to neither).
pub fn sections(total: u64, vm: &VmStat) -> Sections {
    let used = vm.active.saturating_add(vm.wired).saturating_add(vm.compressed).min(total);
    let cached = vm.inactive.saturating_add(vm.speculative).min(total - used);
    Sections { total, used, cached, free: total - used - cached, compressed: vm.compressed.min(used) }
}

/// The pressure level when the kernel's can't be read: little that can be given back (free and cached), or a compressor holding a
/// big part of the RAM while the room is short, mean the Mac is working to find space.
pub fn estimate_pressure(m: &Sections) -> Pressure {
    if m.total == 0 {
        return Pressure::Normal;
    }
    let total = m.total as f64;
    let room = (m.free + m.cached) as f64 / total;
    let compressed = m.compressed as f64 / total;
    if room < 0.05 {
        Pressure::Critical
    } else if room < 0.15 || (compressed > 0.30 && room < 0.25) {
        Pressure::Warning
    } else {
        Pressure::Normal
    }
}

/// `ps -axo pid=,ppid=,rss=,comm=`: three numbers, then the executable (which may have spaces in it). A line that isn't that is skipped.
pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines().filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<Proc> {
    let mut rest = line.trim_start();
    let mut nums = [0u64; 3];
    for n in nums.iter_mut() {
        let end = rest.find(char::is_whitespace)?;
        *n = rest[..end].parse().ok()?;
        rest = rest[end..].trim_start();
    }
    let comm = rest.trim_end();
    if comm.is_empty() {
        return None;
    }
    Some(Proc { pid: u32::try_from(nums[0]).ok()?, ppid: u32::try_from(nums[1]).ok()?, rss_kb: nums[2], comm: comm.to_string() })
}

/// Where a process belongs.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Group {
    Macos,
    /// An app by the name of the outermost `.app` in its path, or else by the executable's name (a bundle called `node` and the
    /// program `node` are one group to the reader).
    App(String),
}

/// Parts of the system whose processes are macOS's own, wherever an `.app` appears in them (Finder, Dock, WebKit's helpers).
const SYSTEM_PREFIXES: [&str; 6] = ["/System/Library/", "/System/Volumes/Preboot/Cryptexes/OS/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/Library/Apple/"];

fn classify(comm: &str) -> Group {
    if comm == "kernel_task" || SYSTEM_PREFIXES.iter().any(|p| comm.starts_with(p)) {
        return Group::Macos;
    }
    let parts: Vec<&str> = comm.split('/').filter(|p| !p.is_empty()).collect();
    // The outermost bundle: `Foo Helper (GPU).app` inside `Foo.app/Contents/Frameworks` is Foo's.
    if let Some(i) = parts.iter().take(parts.len().saturating_sub(1)).position(|p| p.len() > 4 && p.ends_with(".app")) {
        return Group::App(parts[i].trim_end_matches(".app").to_string());
    }
    let name = parts.last().map(|n| n.trim_start_matches('-')).filter(|n| !n.is_empty()).unwrap_or("unknown");
    Group::App(name.to_string())
}

/// Every process at or below `root`, by the parent chain.
fn tree_of(procs: &[Proc], root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut seen = HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for &c in children.get(&pid).into_iter().flatten() {
            if seen.insert(c) {
                queue.push(c);
            }
        }
    }
    seen
}

/// The apps of a process list, sized and ranked. Resident sizes count shared pages in every process that maps them, so they can
/// add up to more than the Mac uses: then each is scaled down in proportion, and what is left over (kernel memory that no process
/// owns, when they add up to less) goes to macOS. Either way the sizes add up to `used`.
pub fn group(procs: &[Proc], lantern_pid: u32, used: u64, total: u64) -> (Vec<App>, bool) {
    let lantern = tree_of(procs, lantern_pid);
    let mut lantern_raw = (0u64, 0usize);
    let mut macos_raw = (0u64, 0usize);
    let mut apps: HashMap<String, (u64, usize)> = HashMap::new();
    for p in procs {
        let slot = if lantern.contains(&p.pid) {
            &mut lantern_raw
        } else {
            match classify(&p.comm) {
                Group::Macos => &mut macos_raw,
                Group::App(name) => apps.entry(name).or_insert((0, 0)),
            }
        };
        slot.0 = slot.0.saturating_add(p.rss_kb.saturating_mul(1024));
        slot.1 += 1;
    }
    let raw_total = apps.values().map(|a| a.0 as u128).sum::<u128>() + lantern_raw.0 as u128 + macos_raw.0 as u128;
    let scaled = raw_total > used as u128;
    let fit = |raw: u64| if scaled { (raw as u128 * used as u128 / raw_total) as u64 } else { raw };
    let mut named: Vec<(String, u64, usize)> = apps.into_iter().map(|(name, (b, n))| (name, fit(b), n)).filter(|(_, b, _)| *b > 0).collect();
    // Biggest first; ties by name so the order is the same every time.
    named.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let lantern_bytes = fit(lantern_raw.0);
    let top: u64 = named.iter().take(TOP_APPS).map(|a| a.1).sum();
    let other: u64 = named.iter().skip(TOP_APPS).map(|a| a.1).sum();
    let other_count: usize = named.iter().skip(TOP_APPS).map(|a| a.2).sum();
    // macOS: its processes, and whatever of the used memory nobody else holds (rounding when scaled).
    let macos_bytes = used.saturating_sub(top + other + lantern_bytes);
    let share = |b: u64| if total == 0 { 0.0 } else { b as f64 / total as f64 };
    let mut out: Vec<App> = named.into_iter().take(TOP_APPS).map(|(name, bytes, processes)| App { name, bytes, processes, share: share(bytes), kind: Kind::App }).collect();
    if lantern_raw.1 > 0 {
        out.push(App { name: LANTERN_NAME.to_string(), bytes: lantern_bytes, processes: lantern_raw.1, share: share(lantern_bytes), kind: Kind::Lantern });
    }
    out.push(App { name: MACOS_NAME.to_string(), bytes: macos_bytes, processes: macos_raw.1, share: share(macos_bytes), kind: Kind::Macos });
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    if other_count > 0 {
        out.push(App { name: OTHER_NAME.to_string(), bytes: other, processes: other_count, share: share(other), kind: Kind::Other });
    }
    (out, scaled)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VM_STAT_OUT: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               25817.
Pages active:                            264010.
Pages inactive:                          261856.
Pages speculative:                          549.
Pages throttled:                              0.
Pages wired down:                        207601.
Pages purgeable:                          16031.
\"Translation faults\":               20219808094.
Pages stored in compressor:             1517675.
Pages occupied by compressor:            247084.
Swapouts:                            176528476.
";

    const SYSCTL_OUT: &str = "hw.memsize: 17179869184
vm.swapusage: total = 9216.00M  used = 7986.12M  free = 1229.88M  (encrypted)
kern.memorystatus_vm_pressure_level: 1
";

    const PS_OUT: &str = "    1     0  18528 /sbin/launchd
    0     0  60000 kernel_task
  340     1  90000 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
  341     1  50000 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  400     1 300000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  401   400 200000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
  402   400 100000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU)
  500     1 250000 /Applications/Xcode.app/Contents/MacOS/Xcode
  501     1  80000 /Applications/Slack.app/Contents/MacOS/Slack
  600     1  70000 /Users/me/dev/lantern/src-tauri/target/debug/lantern
  601   600  90000 /Users/me/.local/bin/claude
  602   601  40000 /opt/homebrew/bin/node
  603   600  30000 /opt/homebrew/bin/node
  700     1  20000 /opt/homebrew/bin/node
  701     1  25000 /opt/homebrew/bin/node
  800     1   4000 -zsh
  801     1   5000 /bin/zsh
  900     1  10000 /System/Applications/Calendar.app/Contents/MacOS/Calendar
";

    fn lantern_demo() -> Vec<Proc> {
        parse_ps(PS_OUT)
    }

    fn by_name<'a>(apps: &'a [App], name: &str) -> &'a App {
        apps.iter().find(|a| a.name == name).unwrap_or_else(|| panic!("no {name} in {:?}", apps.iter().map(|a| &a.name).collect::<Vec<_>>()))
    }

    #[test]
    fn vm_stat_is_read_in_bytes() {
        let vm = parse_vm_stat(VM_STAT_OUT).unwrap();
        assert_eq!(vm.free, 25817 * 16384);
        assert_eq!(vm.active, 264010 * 16384);
        assert_eq!(vm.inactive, 261856 * 16384);
        assert_eq!(vm.speculative, 549 * 16384);
        assert_eq!(vm.wired, 207601 * 16384);
        assert_eq!(vm.compressed, 247084 * 16384);
    }

    #[test]
    fn vm_stat_without_a_page_size_or_a_count_is_an_error() {
        assert!(parse_vm_stat("").is_err());
        assert!(parse_vm_stat("Pages free: 5.\n").is_err());
        assert!(parse_vm_stat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 5.\n").is_err());
    }

    #[test]
    fn sysctl_gives_the_total_the_swap_and_the_level() {
        let s = parse_sysctl(SYSCTL_OUT);
        assert_eq!(s.memsize, Some(17_179_869_184));
        assert_eq!(s.swap_used, Some((7986.12 * 1024.0 * 1024.0) as u64));
        assert_eq!(s.pressure, Some(Pressure::Normal));
        // A key the Mac doesn't have is just missing.
        let s = parse_sysctl("hw.memsize: 8589934592\nkern.memorystatus_vm_pressure_level: 4\nvm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n");
        assert_eq!((s.memsize, s.swap_used, s.pressure), (Some(8_589_934_592), Some(0), Some(Pressure::Critical)));
        assert_eq!(parse_sysctl("hw.memsize: nonsense\nkern.memorystatus_vm_pressure_level: 3\n"), Sysctl { memsize: None, swap_used: None, pressure: None });
        assert_eq!(parse_sysctl("vm.swapusage: total = 2.00G  used = 1.50G  free = 0.50G").swap_used, Some(1_610_612_736));
    }

    #[test]
    fn the_three_sections_add_up_to_the_total() {
        let total = 17_179_869_184;
        let m = sections(total, &parse_vm_stat(VM_STAT_OUT).unwrap());
        assert_eq!(m.used, (264010 + 207601 + 247084) * 16384);
        assert_eq!(m.cached, (261856 + 549) * 16384);
        assert_eq!(m.used + m.cached + m.free, total);
        assert_eq!(m.compressed, 247084 * 16384);
        // More pages than there is memory (a stale read): nothing goes over the total.
        let over = sections(1000, &VmStat { active: 900, wired: 900, inactive: 500, ..Default::default() });
        assert_eq!((over.used, over.cached, over.free), (1000, 0, 0));
    }

    #[test]
    fn the_estimated_pressure_follows_the_room_left() {
        let m = |used: u64, cached: u64, compressed: u64| Sections { total: 100, used, cached, free: 100 - used - cached, compressed };
        assert_eq!(estimate_pressure(&m(60, 25, 10)), Pressure::Normal);
        assert_eq!(estimate_pressure(&m(88, 5, 10)), Pressure::Warning);
        assert_eq!(estimate_pressure(&m(97, 1, 10)), Pressure::Critical);
        // Plenty of room is still tight when a third of the RAM is compressed and little is cached.
        assert_eq!(estimate_pressure(&m(80, 0, 35)), Pressure::Warning);
        assert_eq!(estimate_pressure(&m(60, 25, 35)), Pressure::Normal);
    }

    #[test]
    fn ps_lines_are_read_including_names_with_spaces() {
        let procs = parse_ps("  101     1   2048 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n");
        assert_eq!(procs, vec![Proc { pid: 101, ppid: 1, rss_kb: 2048, comm: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into() }]);
    }

    #[test]
    fn malformed_ps_lines_are_skipped() {
        let procs = parse_ps("PID PPID RSS COMM\n\n  12 abc 5 /bin/x\n  13 1\n  14 1 7\n  15 1 7 /bin/ok\n  99999999999 1 7 /bin/big\n");
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, 15);
    }

    #[test]
    fn the_argument_vector_asks_for_names_and_never_for_command_lines() {
        assert_eq!(PS_ARGS, ["-axo", "pid=,ppid=,rss=,comm="]);
        let asked = PS_ARGS.join(" ");
        assert!(asked.contains("comm="));
        for banned in ["args", "command", "-ww"] {
            assert!(!asked.split(|c: char| c == ',' || c == ' ' || c == '=').any(|w| w == banned), "ps was asked for {banned}");
        }
        // No shell: the programs are absolute paths run directly.
        for program in [VM_STAT, SYSCTL, PS] {
            assert!(program.starts_with('/'));
        }
    }

    #[test]
    fn helpers_and_framework_processes_belong_to_their_app() {
        let (apps, _) = group(&lantern_demo(), 600, 8_000_000_000, 17_179_869_184);
        let chrome = by_name(&apps, "Google Chrome");
        assert_eq!((chrome.bytes, chrome.processes), (600_000 * 1024, 3));
        assert_eq!(chrome.kind, Kind::App);
        assert_eq!(by_name(&apps, "Xcode").processes, 1);
        assert_eq!(by_name(&apps, "Calendar").processes, 1);
    }

    #[test]
    fn same_named_processes_are_one_group_and_a_login_shell_dash_is_dropped() {
        let (apps, _) = group(&lantern_demo(), 600, 8_000_000_000, 17_179_869_184);
        // The two `node` under Lantern are Lantern's; the two outside it are one `node`.
        let node = by_name(&apps, "node");
        assert_eq!((node.bytes, node.processes), (45_000 * 1024, 2));
        let zsh = by_name(&apps, "zsh");
        assert_eq!((zsh.bytes, zsh.processes), (9_000 * 1024, 2));
    }

    #[test]
    fn the_system_s_own_processes_are_macos() {
        let (apps, _) = group(&lantern_demo(), 600, 8_000_000_000, 17_179_869_184);
        let macos = by_name(&apps, "macOS");
        assert_eq!(macos.kind, Kind::Macos);
        // launchd, kernel_task, WindowServer and Finder (a CoreServices app), plus what no process holds: the rest of `used`.
        assert_eq!(macos.processes, 4);
        assert!(apps.iter().all(|a| a.name != "Finder" && a.name != "WindowServer" && a.name != "launchd"));
    }

    #[test]
    fn lantern_and_everything_it_started_is_one_group() {
        let (apps, _) = group(&lantern_demo(), 600, 8_000_000_000, 17_179_869_184);
        let l = by_name(&apps, LANTERN_NAME);
        assert_eq!(l.kind, Kind::Lantern);
        // lantern, claude, and the two node below it.
        assert_eq!((l.bytes, l.processes), ((70_000 + 90_000 + 40_000 + 30_000) * 1024, 4));
        assert!(apps.iter().all(|a| a.name != "claude" && a.name != "lantern"));
        // A process called node outside Lantern's tree isn't Lantern's: the tree is the parent chain, not the name.
        assert_eq!(by_name(&apps, "node").processes, 2);
    }

    #[test]
    fn without_lantern_in_the_list_there_is_no_lantern_group() {
        let (apps, _) = group(&lantern_demo(), 123_456, 8_000_000_000, 17_179_869_184);
        assert!(apps.iter().all(|a| a.kind != Kind::Lantern));
        assert_eq!(by_name(&apps, "claude").processes, 1);
    }

    #[test]
    fn what_no_process_holds_goes_to_macos_so_the_apps_add_up_to_the_used_memory() {
        let used = 8_000_000_000;
        let (apps, scaled) = group(&lantern_demo(), 600, used, 17_179_869_184);
        assert!(!scaled);
        assert_eq!(apps.iter().map(|a| a.bytes).sum::<u64>(), used);
        let macos = by_name(&apps, "macOS");
        assert!(macos.bytes > (18_528 + 60_000 + 90_000 + 50_000) * 1024);
    }

    #[test]
    fn residents_that_add_up_to_more_than_is_used_are_scaled_down_to_fit() {
        let used = 1_000_000_000;
        let (apps, scaled) = group(&lantern_demo(), 600, used, 17_179_869_184);
        assert!(scaled);
        assert_eq!(apps.iter().map(|a| a.bytes).sum::<u64>(), used);
        // In proportion: Chrome (600 MB of ~1.5 GB raw) stays the biggest of the apps.
        assert_eq!(apps[0].name, "Google Chrome");
        assert!(apps.iter().all(|a| a.share <= used as f64 / 17_179_869_184.0 + 1e-9));
    }

    #[test]
    fn apps_past_the_top_fifteen_are_other_apps_and_other_is_the_rest() {
        let mut text = String::new();
        for i in 0..20u32 {
            text.push_str(&format!("{} 1 {} /Applications/App{i:02}.app/Contents/MacOS/App{i:02}\n", 1000 + i, 10_000 + i * 100));
        }
        let used = 8_000_000_000;
        let (apps, _) = group(&parse_ps(&text), 999_999, used, 17_179_869_184);
        let named: Vec<_> = apps.iter().filter(|a| a.kind == Kind::App).collect();
        assert_eq!(named.len(), TOP_APPS);
        let other = apps.last().unwrap();
        assert_eq!((other.name.as_str(), other.kind, other.processes), (OTHER_NAME, Kind::Other, 5));
        // The five smallest, App00 to App04.
        assert_eq!(other.bytes, (0..5u64).map(|i| (10_000 + i * 100) * 1024).sum::<u64>());
        assert_eq!(apps.iter().map(|a| a.bytes).sum::<u64>(), used);
        assert_eq!(named[0].name, "App19");
    }

    #[test]
    fn the_snapshot_carries_names_sizes_counts_and_shares_only() {
        let (apps, _) = group(&lantern_demo(), 600, 8_000_000_000, 17_179_869_184);
        let json = serde_json::to_string(&apps).unwrap();
        for leaked in ["/Applications", "/Users", "/opt/homebrew", "pid", "Contents/MacOS"] {
            assert!(!json.contains(leaked), "{leaked} reached the snapshot");
        }
    }

    #[test]
    fn ties_are_ordered_by_name_so_the_list_does_not_shuffle() {
        let text = "10 1 5000 /Applications/B.app/Contents/MacOS/B\n11 1 5000 /Applications/A.app/Contents/MacOS/A\n";
        let (apps, _) = group(&parse_ps(text), 999_999, 1_000_000_000, 8_000_000_000);
        let names: Vec<_> = apps.iter().filter(|a| a.kind == Kind::App).map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["A", "B"]);
    }

    /// Reads this Mac for real: `cargo test real_snapshot -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_snapshot() {
        let s = snapshot().unwrap();
        println!("total {} used {} cached {} free {} compressed {} swap {:?} pressure {:?} ({:?}) scaled {}", s.total_bytes, s.used_bytes, s.cached_bytes, s.free_bytes, s.compressed_bytes, s.swap_used_bytes, s.pressure, s.pressure_source, s.scaled);
        for a in s.apps.iter().take(5) {
            println!("{:<28} {:>8.1} MB  {:>3} processes  {:>5.1}%  {:?}", a.name, a.bytes as f64 / 1_048_576.0, a.processes, a.share * 100.0, a.kind);
        }
        assert_eq!(s.apps.iter().map(|a| a.bytes).sum::<u64>(), s.used_bytes);
    }
}
