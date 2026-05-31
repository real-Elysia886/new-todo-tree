use crate::config::ScannerConfig;
use crate::matcher::TodoMatcher;
use crate::output::{AgentContext, AgentSummary, AgentTodoItem, ScanOutput, TodoItem};
use crate::walker::{read_single_file, FileWalker};
use anyhow::{anyhow, Context, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct RequestMessage {
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
struct ResponseMessage {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InitializeParams {
    root: String,
    config: ScannerConfig,
}

#[derive(Debug, Deserialize)]
struct ScanFileParams {
    file: String,
}

struct DaemonState {
    root: PathBuf,
    config: ScannerConfig,
    matcher: TodoMatcher,
    walker: FileWalker,
    // Maps clean absolute path to TodoItems
    cache: HashMap<String, Vec<TodoItem>>,
    file_signatures: HashMap<String, FileSignature>,
    // Set of scanned files
    scanned_files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSignature {
    len: u64,
    modified_ns: Option<u128>,
}

pub fn run_daemon() -> Result<()> {
    let stdin = io::stdin();
    let mut state: Option<DaemonState> = None;

    for line_result in stdin.lock().lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Daemon: failed to read line: {e}");
                break;
            }
        };

        let request: RequestMessage = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("Daemon: failed to parse request: {e}");
                continue;
            }
        };

        let response = match handle_request(request.method.as_str(), request.params, &mut state) {
            Ok(result) => ResponseMessage {
                id: request.id,
                result: Some(result),
                error: None,
            },
            Err(err) => ResponseMessage {
                id: request.id,
                result: None,
                error: Some(format!("{err:#}")),
            },
        };

        if let Ok(res_str) = serde_json::to_string(&response) {
            println!("{res_str}");
        }
    }

    Ok(())
}

fn handle_request(method: &str, params: Value, state: &mut Option<DaemonState>) -> Result<Value> {
    match method {
        "initialize" => {
            let init_params: InitializeParams = serde_json::from_value(params)?;
            let root = PathBuf::from(&init_params.root)
                .canonicalize()
                .with_context(|| format!("failed to canonicalize root {}", init_params.root))?;

            let matcher = TodoMatcher::new(&init_params.config)?;
            let walker = FileWalker::new(&root, &init_params.config)?;

            let mut next_state = DaemonState {
                root,
                config: init_params.config,
                matcher,
                walker,
                cache: HashMap::new(),
                file_signatures: HashMap::new(),
                scanned_files: Vec::new(),
            };
            rebuild_cache(&mut next_state)?;

            *state = Some(next_state);

            Ok(serde_json::to_value("initialized")?)
        }
        "scan-workspace" => {
            let s = state.as_mut().ok_or_else(|| anyhow!("Daemon not initialized"))?;
            let started = Instant::now();
            rebuild_cache(s)?;

            let mut items = Vec::new();
            let mut matched_files = 0;
            for file_items in s.cache.values() {
                if !file_items.is_empty() {
                    matched_files += 1;
                    items.extend(file_items.clone());
                }
            }

            let output = ScanOutput {
                workspace: clean_path(&s.root),
                elapsed_ms: started.elapsed().as_millis(),
                scanned_files: s.scanned_files.len(),
                matched_files,
                total_items: items.len(),
                items,
            };

            Ok(serde_json::to_value(&output)?)
        }
        "scan-file" => {
            let s = state.as_mut().ok_or_else(|| anyhow!("Daemon not initialized"))?;
            let started = Instant::now();

            let scan_params: ScanFileParams = serde_json::from_value(params)?;
            let file = PathBuf::from(&scan_params.file);
            let file_canon = resolve_file_under_root(&s.root, &file)?;

            let clean_key = clean_path(&file_canon);

            // Rescan file and update cache
            let items = if file_canon.exists() && s.walker.is_included(&file_canon) {
                remember_scanned_file(&mut s.scanned_files, clean_key.clone());
                match read_single_file(&file_canon, s.config.max_file_size)? {
                    Some(content) => {
                        let new_items = s.matcher.scan_text(&file_canon, &content);
                        s.cache.insert(clean_key.clone(), new_items.clone());
                        if let Some(signature) = file_signature(&file_canon) {
                            s.file_signatures.insert(clean_key.clone(), signature);
                        }
                        new_items
                    }
                    None => {
                        s.cache.remove(&clean_key);
                        s.file_signatures.remove(&clean_key);
                        Vec::new()
                    }
                }
            } else {
                s.cache.remove(&clean_key);
                s.file_signatures.remove(&clean_key);
                forget_scanned_file(&mut s.scanned_files, &clean_key);
                Vec::new()
            };

            let output = ScanOutput {
                workspace: clean_path(&s.root),
                elapsed_ms: started.elapsed().as_millis(),
                scanned_files: 1,
                matched_files: usize::from(!items.is_empty()),
                total_items: items.len(),
                items,
            };

            Ok(serde_json::to_value(&output)?)
        }
        "agent-context" => {
            let s = state.as_mut().ok_or_else(|| anyhow!("Daemon not initialized"))?;
            rebuild_cache(s)?;
            let now = crate::now_secs();
            let today = (now / 86_400) as i64;

            // Gather all items from cache
            let mut all_items = Vec::new();
            for file_items in s.cache.values() {
                all_items.extend(file_items.clone());
            }

            let git_status = crate::collect_git_status(&s.root);
            let mut age_cache: HashMap<String, Option<u64>> = HashMap::new();

            let mut items: Vec<(i64, AgentTodoItem)> = all_items
                .iter()
                .map(|item| {
                    let relative_path = crate::relative_path(&s.root, Path::new(&item.file));
                    let git = git_status.get(&item.file).cloned();
                    let age_days = crate::file_age_days(&s.root, &relative_path, now, &mut age_cache);
                    let overdue = item
                        .due_date
                        .as_ref()
                        .and_then(|date| crate::parse_date_days(date))
                        .map(|due| due < today)
                        .unwrap_or(false);
                    let score = crate::recommendation_score(item, git.as_deref(), age_days, overdue);

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
                            context_snippet: crate::context_snippet(Path::new(&item.file), item.line, 2)
                                .unwrap_or_else(|| item.context.clone()),
                            recommended_order: 0,
                            recommended_action: crate::recommended_action(item, overdue),
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
                            .and_then(|date| crate::parse_date_days(date))
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

            let context = AgentContext {
                schema_version: 1,
                workspace: clean_path(&s.root),
                generated_at: now,
                summary,
                items: agent_items,
            };

            Ok(serde_json::to_value(&context)?)
        }
        other => Err(anyhow!("unknown daemon method {other}")),
    }
}

fn rebuild_cache(state: &mut DaemonState) -> Result<()> {
    let paths = state.walker.collect_files(&state.config);
    state.scanned_files = paths.iter().map(|p| clean_path(p)).collect();

    let previous_cache = &state.cache;
    let previous_signatures = &state.file_signatures;
    let matcher = &state.matcher;
    let max_file_size = state.config.max_file_size;

    let file_items: Vec<(String, FileSignature, Vec<TodoItem>)> = paths
        .into_par_iter()
        .filter_map(|path| {
            let key = clean_path(&path);
            let signature = file_signature(&path)?;

            if previous_signatures.get(&key) == Some(&signature) {
                let items = previous_cache.get(&key).cloned().unwrap_or_default();
                return Some((key, signature, items));
            }

            let content = read_single_file(&path, max_file_size).ok()??;
            let items = matcher.scan_text(&path, &content);
            Some((key, signature, items))
        })
        .collect();

    state.cache.clear();
    state.file_signatures.clear();
    for (key, signature, items) in file_items {
        state.file_signatures.insert(key.clone(), signature);
        state.cache.insert(key, items);
    }

    Ok(())
}

fn file_signature(path: &Path) -> Option<FileSignature> {
    let metadata = fs::metadata(path).ok()?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    Some(FileSignature {
        len: metadata.len(),
        modified_ns,
    })
}

fn resolve_file_under_root(root: &Path, file: &Path) -> Result<PathBuf> {
    let candidate = if file.is_absolute() {
        file.to_path_buf()
    } else {
        root.join(file)
    };

    let resolved = match candidate.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            let parent = candidate
                .parent()
                .unwrap_or(root)
                .canonicalize()
                .with_context(|| format!("failed to canonicalize parent for {}", candidate.display()))?;
            let name = candidate
                .file_name()
                .ok_or_else(|| anyhow!("failed to resolve file name {}", candidate.display()))?;
            parent.join(name)
        }
    };

    if !resolved.starts_with(root) {
        return Err(anyhow!(
            "refusing to scan file outside root: {} is outside {}",
            resolved.display(),
            root.display()
        ));
    }

    Ok(resolved)
}

fn remember_scanned_file(scanned_files: &mut Vec<String>, key: String) {
    if !scanned_files.contains(&key) {
        scanned_files.push(key);
    }
}

fn forget_scanned_file(scanned_files: &mut Vec<String>, key: &str) {
    scanned_files.retain(|file| file != key);
}

fn clean_path(path: &Path) -> String {
    path.display()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string()
}
