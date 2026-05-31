mod config;
mod daemon;
mod matcher;
mod output;
mod walker;

use anyhow::{bail, Context, Result};
use config::ScannerConfig;
use matcher::TodoMatcher;
use output::{AgentContext, AgentSummary, AgentTodoItem, ScanOutput, TodoItem};
use rayon::prelude::*;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use walker::{read_single_file, FileWalker};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        bail!("missing command: daemon, scan-workspace, scan-file, agent-context, or benchmark");
    }

    let command = args[1].as_str();

    if command == "daemon" {
        return daemon::run_daemon();
    }

    let root = required_arg(&args, "--root")?;
    let config_path = required_arg(&args, "--config")?;
    let config = ScannerConfig::from_path(Path::new(&config_path))?;

    let output = match command {
        "scan-workspace" => scan_workspace(Path::new(&root), &config)?,
        "scan-file" => {
            let file = required_arg(&args, "--file")?;
            scan_file(Path::new(&root), Path::new(&file), &config)?
        }
        "agent-context" => {
            let context = agent_context(Path::new(&root), &config)?;
            println!("{}", serde_json::to_string(&context)?);
            return Ok(());
        }
        "benchmark" => {
            let iterations = optional_arg(&args, "--iterations")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(5);
            run_benchmark(Path::new(&root), &config, iterations)?
        }
        other => bail!("unknown command {other}"),
    };

    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn scan_workspace(root: &Path, config: &ScannerConfig) -> Result<ScanOutput> {
    let started = Instant::now();
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to canonicalize root {}", root.display()))?;
    let matcher = TodoMatcher::new(config)?;
    let walker = FileWalker::new(&root, config)?;
    let paths = walker.collect_files(config);
    let scanned_files = paths.len();

    let file_items: Vec<Vec<TodoItem>> = paths
        .into_par_iter()
        .filter_map(|path| {
            let content = read_single_file(&path, config.max_file_size).ok()??;
            Some(matcher.scan_text(&path, &content))
        })
        .filter(|items| !items.is_empty())
        .collect();

    let matched_files = file_items.len();
    let items = file_items.into_iter().flatten().collect::<Vec<_>>();

    Ok(ScanOutput {
        workspace: clean_path(&root),
        elapsed_ms: started.elapsed().as_millis(),
        scanned_files,
        matched_files,
        total_items: items.len(),
        items,
    })
}

fn scan_file(root: &Path, file: &Path, config: &ScannerConfig) -> Result<ScanOutput> {
    let started = Instant::now();
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to canonicalize root {}", root.display()))?;
    let file = canonicalize_under_root(&root, file)?;
    let walker = FileWalker::new(&root, config)?;

    let items = if walker.is_included(&file) {
        match read_single_file(&file, config.max_file_size)? {
            Some(content) => TodoMatcher::new(config)?.scan_text(&file, &content),
            None => Vec::new(),
        }
    } else {
        Vec::new()
    };

    Ok(ScanOutput {
        workspace: clean_path(&root),
        elapsed_ms: started.elapsed().as_millis(),
        scanned_files: 1,
        matched_files: usize::from(!items.is_empty()),
        total_items: items.len(),
        items,
    })
}

fn agent_context(root: &Path, config: &ScannerConfig) -> Result<AgentContext> {
    let output = scan_workspace(root, config)?;
    let root = Path::new(&output.workspace);
    let now = now_secs();
    let today = (now / 86_400) as i64;
    let git_status = collect_git_status(root);
    let mut age_cache: HashMap<String, Option<u64>> = HashMap::new();
    let mut items: Vec<(i64, AgentTodoItem)> = output
        .items
        .iter()
        .map(|item| {
            let relative_path = relative_path(root, Path::new(&item.file));
            let git = git_status.get(&item.file).cloned();
            let age_days = file_age_days(root, &relative_path, now, &mut age_cache);
            let overdue = item
                .due_date
                .as_ref()
                .and_then(|date| parse_date_days(date))
                .map(|due| due < today)
                .unwrap_or(false);
            let score = recommendation_score(item, git.as_deref(), age_days, overdue);

            (
                score,
                AgentTodoItem {
                    id: format!("{}:{}:{}", relative_path, item.line, item.tag),
                    file: item.file.clone(),
                    relative_path,
                    line: item.line,
                    column: item.column,
                    tag: item.tag.clone(),
                    priority: item.priority.clone(),
                    severity: item.severity.clone(),
                    assignee: item.assignee.clone(),
                    due_date: item.due_date.clone(),
                    labels: item.labels.clone(),
                    git_status: git,
                    age_days,
                    text: item.text.clone(),
                    context: item.context.clone(),
                    context_snippet: context_snippet(Path::new(&item.file), item.line, 2)
                        .unwrap_or_else(|| item.context.clone()),
                    recommended_order: 0,
                    recommended_action: recommended_action(item, overdue),
                },
            )
        })
        .collect();

    items.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.file.cmp(&b.1.file))
            .then_with(|| a.1.line.cmp(&b.1.line))
    });

    let mut agent_items: Vec<AgentTodoItem> = Vec::with_capacity(items.len());
    for (index, (_, mut item)) in items.into_iter().enumerate() {
        item.recommended_order = index + 1;
        agent_items.push(item);
    }

    let summary = AgentSummary {
        total: agent_items.len(),
        high_priority: agent_items
            .iter()
            .filter(|item| item.priority == "P0" || item.priority == "P1")
            .count(),
        overdue: agent_items
            .iter()
            .filter(|item| {
                item.due_date
                    .as_ref()
                    .and_then(|date| parse_date_days(date))
                    .map(|due| due < today)
                    .unwrap_or(false)
            })
            .count(),
        unassigned: agent_items.iter().filter(|item| item.assignee.is_none()).count(),
        changed_in_current_branch: agent_items
            .iter()
            .filter(|item| item.git_status.is_some())
            .count(),
    };

    Ok(AgentContext {
        schema_version: 1,
        workspace: output.workspace,
        generated_at: now,
        summary,
        items: agent_items,
    })
}

fn clean_path(path: &Path) -> String {
    path.display()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string()
}

fn canonicalize_under_root(root: &Path, file: &Path) -> Result<PathBuf> {
    let file = file
        .canonicalize()
        .with_context(|| format!("failed to canonicalize file {}", file.display()))?;
    if !file.starts_with(root) {
        bail!(
            "refusing to scan file outside root: {} is outside {}",
            file.display(),
            root.display()
        );
    }
    Ok(file)
}

fn required_arg(args: &[String], name: &str) -> Result<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .with_context(|| format!("missing required argument {name}"))
}

fn optional_arg(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn relative_path(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .display()
        .to_string()
        .replace('\\', "/")
}

fn collect_git_status(root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain")
        .arg("-z")
        .output();

    let Ok(output) = output else {
        return map;
    };
    if !output.status.success() {
        return map;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let records: Vec<&str> = text.split('\0').filter(|record| !record.is_empty()).collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() < 4 {
            index += 1;
            continue;
        }

        let status = &record[0..2];
        let mut rel = record[3..].to_string();
        if (status.starts_with('R') || status.starts_with('C')) && index + 1 < records.len() {
            index += 1;
            rel = records[index].to_string();
        }

        if !status.contains('D') {
            let file = root.join(&rel);
            let key = file
                .canonicalize()
                .map(|path| clean_path(&path))
                .unwrap_or_else(|_| clean_path(&file));
            map.insert(key, git_status_label(status));
        }
        index += 1;
    }

    map
}

fn git_status_label(status: &str) -> String {
    if status == "??" {
        return "untracked".to_string();
    }

    let mut chars = status.chars();
    let index = chars.next().unwrap_or(' ');
    let worktree = chars.next().unwrap_or(' ');
    if index != ' ' && worktree != ' ' {
        "staged+modified".to_string()
    } else if index != ' ' {
        "staged".to_string()
    } else if worktree != ' ' {
        "modified".to_string()
    } else {
        "clean".to_string()
    }
}

fn file_age_days(
    root: &Path,
    relative_path: &str,
    now: u64,
    cache: &mut HashMap<String, Option<u64>>,
) -> Option<u64> {
    if let Some(age) = cache.get(relative_path) {
        return *age;
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("log")
        .arg("--follow")
        .arg("--format=%ct")
        .arg("--")
        .arg(relative_path)
        .output();

    let age = output.ok().and_then(|output| {
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .filter_map(|line| line.trim().parse::<u64>().ok())
            .last()
            .map(|created| now.saturating_sub(created) / 86_400)
    });
    cache.insert(relative_path.to_string(), age);
    age
}

fn context_snippet(file: &Path, line: usize, radius: usize) -> Option<String> {
    let content = fs::read_to_string(file).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let start = line.saturating_sub(radius + 1);
    let end = usize::min(lines.len(), line + radius);
    Some(lines[start..end].join("\n"))
}

fn recommendation_score(
    item: &TodoItem,
    git_status: Option<&str>,
    age_days: Option<u64>,
    overdue: bool,
) -> i64 {
    let priority = match item.priority.as_str() {
        "P0" => 100,
        "P1" => 75,
        "P2" => 45,
        "P3" => 20,
        _ => 5,
    };
    let git = if git_status.is_some() { 25 } else { 0 };
    let due = if overdue {
        40
    } else if item.due_date.is_some() {
        10
    } else {
        0
    };
    let owner = if item.assignee.is_none() { 10 } else { 0 };
    let age = age_days
        .map(|days| i64::min(days as i64 / 14, 30))
        .unwrap_or(0);
    priority + git + due + owner + age
}

fn recommended_action(item: &TodoItem, overdue: bool) -> String {
    if overdue || item.priority == "P0" {
        "fix-first".to_string()
    } else if item.priority == "P1" {
        "review-before-merge".to_string()
    } else if item.assignee.is_none() {
        "triage-owner".to_string()
    } else if item.tag == "FIXME" || item.tag == "BUG" {
        "investigate-risk".to_string()
    } else {
        "schedule-maintenance".to_string()
    }
}

fn parse_date_days(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month_prime + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn run_benchmark(root: &Path, config: &ScannerConfig, iterations: u32) -> Result<ScanOutput> {
    let mut times: Vec<u128> = Vec::with_capacity(iterations as usize);
    let mut last_output = None;

    for _ in 0..iterations {
        let output = scan_workspace(root, config)?;
        times.push(output.elapsed_ms);
        last_output = Some(output);
    }

    let mut output = last_output.unwrap();
    let min = *times.iter().min().unwrap_or(&0);
    let max = *times.iter().max().unwrap_or(&0);
    let avg = times.iter().sum::<u128>() / iterations as u128;

    // Report benchmark stats via elapsed_ms = avg, workspace field carries full stats
    output.elapsed_ms = avg;
    output.workspace = format!(
        "{} [benchmark: {}x, avg={}ms, min={}ms, max={}ms]",
        output.workspace, iterations, avg, min, max
    );

    Ok(output)
}
