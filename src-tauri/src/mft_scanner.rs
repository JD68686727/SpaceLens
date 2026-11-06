//! Optionaler NTFS-MFT-Schnellscan (nur Windows, Admin-Rechte).
//! Bei Fehler greift der normale Walk-Scan.

#![cfg(target_os = "windows")]

use crate::scanner::{categorize, is_scan_cancelled, reset_scan_cancel};
use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

// ntfs-reader 0.4.x: FileInfo liegt in file_info, nicht in mft
use ntfs_reader::file_info::{FileInfo, VecCache};
use ntfs_reader::mft::Mft;
use ntfs_reader::volume::Volume;

/// MFT-Scan für ein Laufwerksroot wie `C:\`.
pub fn scan_via_mft(root_path: &str, app: Option<AppHandle>) -> Result<ScanResult, String> {
    reset_scan_cancel();

    let root = PathBuf::from(root_path);
    let drive_letter = root
        .to_string_lossy()
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .ok_or_else(|| {
            "MFT_UNSUPPORTED: MFT-Scan nur für Laufwerksroot (z.B. C:\\)".to_string()
        })?;

    let lossy = root.to_string_lossy();
    let trimmed = lossy.trim_end_matches(['\\', '/']);
    if trimmed.len() > 2 {
        let after = trimmed.chars().skip(2).collect::<String>();
        if !after.is_empty() && after != ":" {
            return Err(
                "MFT_UNSUPPORTED: MFT-Schnellscan nur für ganze Laufwerke (z.B. C:\\), nicht für Unterordner."
                    .into(),
            );
        }
    }

    let device = format!(r"\\.\{}:", drive_letter.to_ascii_uppercase());

    let emit = |phase: &str, current: &str, files: u64, bytes: u64| {
        if let Some(ref handle) = app {
            let _ = handle.emit(
                "scan-progress",
                ScanProgress {
                    files_scanned: files,
                    bytes_scanned: bytes,
                    current_path: current.to_string(),
                    phase: phase.to_string(),
                },
            );
        }
    };

    emit("scanning", &format!("MFT öffnen ({device})…"), 0, 0);

    let volume = Volume::new(&device).map_err(|e| {
        format!(
            "MFT_ACCESS_DENIED: MFT konnte nicht geöffnet werden ({e}). \
             Bitte SpaceLens als Administrator starten und erneut versuchen."
        )
    })?;

    let mft = Mft::new(volume).map_err(|e| format!("MFT_FAILED: MFT lesen fehlgeschlagen: {e}"))?;

    emit("scanning", "MFT wird ausgewertet…", 0, 0);

    let mut entries: Vec<(String, u64, bool)> = Vec::new();
    let mut total_size = 0u64;
    let mut total_files = 0u64;
    let mut category_summary: HashMap<String, u64> = HashMap::new();
    let mut count = 0u64;

    let drive_prefix = format!("{}:", drive_letter.to_ascii_uppercase());
    let drive_prefix_lower = drive_prefix.to_lowercase();

    let mut cache = VecCache::default();

    for file in mft.files() {
        if is_scan_cancelled() {
            return Err("SCAN_CANCELLED: Scan wurde abgebrochen".into());
        }

        let info = FileInfo::with_cache(&mft, &file, &mut cache);
        let path_raw = info.path.to_string_lossy().to_string();
        if path_raw.is_empty() {
            continue;
        }

        let path_norm = path_raw.replace('/', "\\");
        let path_norm = path_norm.trim_start_matches(r"\\.\").to_string();
        let path_lower = path_norm.to_lowercase();

        if !path_lower.starts_with(&drive_prefix_lower) {
            let alt = format!("{}\\", drive_letter.to_ascii_lowercase());
            if !path_lower.starts_with(&alt) {
                continue;
            }
        }

        let is_dir = info.is_directory;
        let size = if is_dir { 0u64 } else { info.size };

        count += 1;
        if !is_dir {
            total_size = total_size.saturating_add(size);
            total_files += 1;
            let cat = categorize(Path::new(&path_norm), false);
            *category_summary
                .entry(format!("{:?}", cat))
                .or_insert(0) += size;
        }

        if count % 8000 == 0 {
            emit("scanning", &path_norm, count, total_size);
        }

        if is_dir || size >= 256 * 1024 {
            entries.push((path_norm, size, is_dir));
        }
    }

    emit("building", "Baue Verzeichnisbaum (MFT)…", count, total_size);

    let mut nodes: HashMap<String, FileNode> = HashMap::new();
    let mut parent_map: HashMap<String, String> = HashMap::new();
    let root_key = format!("{}:\\", drive_letter.to_ascii_uppercase());

    for (path_str, size, is_dir) in &entries {
        let path = PathBuf::from(path_str);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let category = categorize(&path, *is_dir);

        nodes.insert(
            path_str.clone(),
            FileNode {
                name,
                path: path_str.clone(),
                size: *size,
                is_dir: *is_dir,
                category,
                modified: None,
                accessed: None,
                children: vec![],
                file_count: if *is_dir { 0 } else { 1 },
                importance_score: 0.0,
                is_program: false,
                program_name: None,
            },
        );

        if let Some(parent) = path.parent() {
            let parent_str = parent.to_string_lossy().to_string();
            if parent_str != *path_str && !parent_str.is_empty() {
                parent_map.insert(path_str.clone(), parent_str);
            }
        }
    }

    if !nodes.contains_key(&root_key) {
        nodes.insert(
            root_key.clone(),
            FileNode {
                name: root_key.clone(),
                path: root_key.clone(),
                size: 0,
                is_dir: true,
                category: FileCategory::Other,
                modified: None,
                accessed: None,
                children: vec![],
                file_count: 0,
                importance_score: 0.0,
                is_program: false,
                program_name: None,
            },
        );
    }

    let mut paths: Vec<String> = nodes.keys().cloned().collect();
    paths.sort_by(|a, b| b.matches('\\').count().cmp(&a.matches('\\').count()));

    for path in &paths {
        if let Some(parent_path) = parent_map.get(path) {
            if let Some(child_node) = nodes.remove(path) {
                if let Some(parent) = nodes.get_mut(parent_path) {
                    parent.size += child_node.size;
                    parent.file_count += child_node.file_count;
                    parent.children.push(child_node);
                } else {
                    nodes.insert(path.clone(), child_node);
                }
            }
        }
    }

    let mut root_node = nodes
        .remove(&root_key)
        .or_else(|| nodes.remove(&drive_prefix))
        .ok_or_else(|| "MFT_FAILED: Root-Knoten konnte nicht gebaut werden".to_string())?;

    root_node.size = total_size;
    root_node.file_count = total_files;
    prune_tree(&mut root_node, 0);

    let mut largest_items = Vec::new();
    collect_large(&root_node, &mut largest_items, 0);
    largest_items.sort_by(|a, b| b.size.cmp(&a.size));
    largest_items.truncate(50);

    let mut installed_programs = Vec::new();
    collect_programs(&root_node, &mut installed_programs, 0);
    installed_programs.sort_by(|a, b| b.size.cmp(&a.size));
    installed_programs.truncate(80);

    let mut recommendations = Vec::new();
    let mut seen = HashSet::new();
    walk_recs(&root_node, &mut recommendations, &mut seen, 0);
    recommendations.sort_by(|a, b| b.size.cmp(&a.size));
    recommendations.truncate(40);

    emit("done", "MFT-Scan fertig", count, total_size);

    Ok(ScanResult {
        root: root_node,
        total_size,
        total_files,
        category_summary,
        largest_items,
        recommendations,
        duplicates: vec![],
        installed_programs,
    })
}

fn prune_tree(node: &mut FileNode, depth: usize) {
    if depth >= 6 {
        node.children.clear();
        return;
    }
    node.children.sort_by(|a, b| b.size.cmp(&a.size));
    if node.children.len() > 40 {
        node.children.truncate(40);
    }
    for c in &mut node.children {
        prune_tree(c, depth + 1);
    }
}

fn collect_large(node: &FileNode, out: &mut Vec<FileNode>, depth: usize) {
    if depth > 4 || out.len() > 80 {
        return;
    }
    for child in &node.children {
        if child.size > 0 {
            let mut slim = child.clone();
            slim.children.clear();
            out.push(slim);
        }
        if child.is_dir {
            collect_large(child, out, depth + 1);
        }
    }
}

fn collect_programs(node: &FileNode, out: &mut Vec<InstalledProgram>, depth: usize) {
    if depth > 8 || out.len() > 100 {
        return;
    }
    let p = node.path.to_lowercase();
    if node.is_dir && p.contains("\\program files") && node.size > 20 * 1024 * 1024 {
        let seps = p.matches('\\').count();
        if seps <= 3 {
            out.push(InstalledProgram {
                name: node.name.clone(),
                path: node.path.clone(),
                size: node.size,
                file_count: node.file_count,
            });
        }
    }
    for c in &node.children {
        collect_programs(c, out, depth + 1);
    }
}

fn walk_recs(
    node: &FileNode,
    recs: &mut Vec<Recommendation>,
    seen: &mut HashSet<String>,
    depth: usize,
) {
    if depth > 8 || recs.len() > 60 {
        return;
    }
    if matches!(node.category, FileCategory::Temporary) && node.size > 50 * 1024 * 1024 {
        if seen.insert(format!("t:{}", node.path)) {
            recs.push(Recommendation {
                title: format!("Temporäre Dateien: {}", node.name),
                description: "Cache- und Temp-Ordner können meist gefahrlos geleert werden."
                    .into(),
                size: node.size,
                path: node.path.clone(),
                severity: "high".into(),
                category: "Temporary".into(),
            });
        }
    }
    if matches!(node.category, FileCategory::Development) && node.size > 80 * 1024 * 1024 {
        if seen.insert(format!("d:{}", node.path)) {
            recs.push(Recommendation {
                title: format!("Build-/Cache-Ordner: {}", node.name),
                description: "Entwicklungs-Artefakte können oft gelöscht werden.".into(),
                size: node.size,
                path: node.path.clone(),
                severity: "medium".into(),
                category: "Development".into(),
            });
        }
    }
    for c in &node.children {
        walk_recs(c, recs, seen, depth + 1);
    }
}
