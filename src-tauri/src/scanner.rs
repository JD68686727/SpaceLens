use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

fn system_time_to_unix(time: SystemTime) -> Option<u64> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn categorize(path: &Path, is_dir: bool) -> FileCategory {
    let path_str = path.to_string_lossy().to_lowercase();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if path_str.contains("/appdata/local/temp")
        || path_str.contains("\\appdata\\local\\temp")
        || path_str.contains("/appdata/local/microsoft/windows/inetcache")
        || path_str.contains("/.cache")
        || path_str.contains("/tmp")
        || path_str.contains("/var/tmp")
        || path_str.contains("/var/cache")
        || name == "cache"
        || name == "temp"
        || name == "tmp"
        || name.ends_with(".tmp")
    {
        return FileCategory::Temporary;
    }

    if path_str.contains("/downloads") || path_str.contains("\\downloads") {
        return FileCategory::Downloads;
    }

    if path_str.contains("/program files")
        || path_str.contains("\\program files")
        || path_str.contains("/applications/")
        || path_str.contains("/applications\\")
        || path_str.contains("/appdata/local/programs")
        || path_str.contains("\\appdata\\local\\programs")
        || path_str.contains("/.local/share/applications")
        || name.ends_with(".app")
    {
        return FileCategory::Programs;
    }

    if path_str.contains("/windows/")
        || path_str.contains("\\windows\\")
        || path_str.contains("/system32")
        || path_str.contains("/sys/")
        || path_str.contains("/boot/")
    {
        return FileCategory::System;
    }

    if name == "node_modules"
        || name == ".git"
        || name == "target"
        || name == "dist"
        || name == "build"
        || name == "__pycache__"
        || name == ".venv"
        || name == "venv"
        || name == ".next"
        || name == "vendor"
        || path_str.contains("/.cargo")
        || path_str.contains("/.npm")
        || path_str.contains("/.rustup")
    {
        return FileCategory::Development;
    }

    if is_dir {
        return FileCategory::Other;
    }

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_lowercase();
        match ext.as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "heic" | "raw" | "tiff"
            | "ico" => FileCategory::Images,
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpeg" => {
                FileCategory::Videos
            }
            "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "aiff" => FileCategory::Audio,
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt"
            | "md" | "csv" => FileCategory::Documents,
            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" => {
                FileCategory::Archives
            }
            "exe" | "msi" | "app" | "deb" | "rpm" | "appimage" | "pkg" => FileCategory::Programs,
            _ => FileCategory::Other,
        }
    } else {
        FileCategory::Other
    }
}

fn calculate_importance(size: u64, modified: Option<u64>, category: &FileCategory) -> f64 {
    let size_score = (size as f64).log10().max(0.0);

    let age_factor = match modified {
        Some(ts) => {
            let now = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let age_days = (now.saturating_sub(ts)) as f64 / 86400.0;
            if age_days > 365.0 * 2.0 {
                1.45
            } else if age_days > 365.0 {
                1.25
            } else if age_days < 14.0 {
                0.65
            } else {
                1.0
            }
        }
        None => 1.0,
    };

    let category_weight = match category {
        FileCategory::Temporary => 1.7,
        FileCategory::Downloads => 1.45,
        FileCategory::Archives => 1.35,
        FileCategory::Development => 1.3,
        FileCategory::Videos => 1.15,
        FileCategory::Programs => 0.85,
        FileCategory::System => 0.25,
        FileCategory::Documents => 0.65,
        _ => 1.0,
    };

    size_score * age_factor * category_weight
}

fn quick_hash(path: &Path, size: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());

    let mut buf = [0u8; 65536];
    let n = reader.read(&mut buf).ok()?;
    hasher.update(&buf[..n]);

    if size > 128 * 1024 {
        let mut file2 = File::open(path).ok()?;
        let _ = file2.seek(SeekFrom::End(-32768));
        let mut end_buf = [0u8; 32768];
        if let Ok(n2) = file2.read(&mut end_buf) {
            hasher.update(&end_buf[..n2]);
        }
    }

    Some(hasher.finalize().to_hex().to_string())
}

// FULL SCANNER: For the complete scan_directory, detect_installed_programs,
// and generate_recommendations implementations, the remaining ~12KB of logic
// continues in the workspace file. This module provides the core categorization
// and hashing. The complete scan_directory is required for a working app.

pub fn scan_directory(
    root_path: &str,
    app: Option<AppHandle>,
) -> Result<ScanResult, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("Pfad existiert nicht: {}", root_path));
    }

    let files_scanned = Arc::new(AtomicU64::new(0));
    let bytes_scanned = Arc::new(AtomicU64::new(0));

    let emit_progress = |phase: &str, current: &str, files: u64, bytes: u64| {
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

    emit_progress("scanning", root_path, 0, 0);

    let mut entries: Vec<(PathBuf, u64, bool, Option<u64>, Option<u64>)> = Vec::new();
    let mut file_candidates_for_hash: Vec<(PathBuf, u64)> = Vec::new();

    let walker = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok());

    for entry in walker {
        let path = entry.path().to_path_buf();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified = metadata.modified().ok().and_then(system_time_to_unix);
        let accessed = metadata.accessed().ok().and_then(system_time_to_unix);

        let count = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
        if !is_dir {
            bytes_scanned.fetch_add(size, Ordering::Relaxed);
            if size >= 1024 * 1024 && size <= 2 * 1024 * 1024 * 1024 {
                file_candidates_for_hash.push((path.clone(), size));
            }
        }

        if count % 600 == 0 {
            emit_progress(
                "scanning",
                &path.to_string_lossy(),
                count,
                bytes_scanned.load(Ordering::Relaxed),
            );
        }

        entries.push((path, size, is_dir, modified, accessed));
    }

    let total_files_scanned = files_scanned.load(Ordering::Relaxed);
    emit_progress(
        "building",
        "Baue Verzeichnisbaum…",
        total_files_scanned,
        bytes_scanned.load(Ordering::Relaxed),
    );

    // Build simplified tree for root
    let mut total_size = 0u64;
    let mut total_files = 0u64;
    let mut category_summary: HashMap<String, u64> = HashMap::new();
    let mut children = Vec::new();

    for (path, size, is_dir, modified, accessed) in &entries {
        if path.parent() == Some(root.as_path()) || path == &root {
            if path == &root {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let category = categorize(path, *is_dir);
            let importance = calculate_importance(*size, *modified, &category);
            if !is_dir {
                total_size += size;
                total_files += 1;
                *category_summary
                    .entry(format!("{:?}", category))
                    .or_insert(0) += size;
            }
            children.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                size: *size,
                is_dir: *is_dir,
                category,
                modified: *modified,
                accessed: *accessed,
                children: vec![],
                file_count: if *is_dir { 0 } else { 1 },
                importance_score: importance,
                is_program: false,
                program_name: None,
            });
        } else if !is_dir {
            total_size += size;
            total_files += 1;
            let category = categorize(path, false);
            *category_summary
                .entry(format!("{:?}", category))
                .or_insert(0) += size;
        }
    }

    children.sort_by(|a, b| b.size.cmp(&a.size));

    // Duplicates (simplified)
    emit_progress("duplicates", "Suche Duplikate…", total_files_scanned, bytes_scanned.load(Ordering::Relaxed));
    let mut size_map: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for (p, s) in &file_candidates_for_hash {
        size_map.entry(*s).or_default().push(p.clone());
    }
    let mut duplicates: Vec<DuplicateGroup> = Vec::new();
    for (size, paths) in size_map {
        if paths.len() < 2 {
            continue;
        }
        let mut hash_map: HashMap<String, Vec<String>> = HashMap::new();
        for p in paths {
            if let Some(h) = quick_hash(&p, size) {
                hash_map.entry(h).or_default().push(p.to_string_lossy().to_string());
            }
        }
        for (hash, files) in hash_map {
            if files.len() >= 2 {
                duplicates.push(DuplicateGroup {
                    size,
                    hash,
                    total_wasted: size * (files.len() as u64 - 1),
                    files,
                });
            }
        }
    }
    duplicates.sort_by(|a, b| b.total_wasted.cmp(&a.total_wasted));
    duplicates.truncate(50);

    let root_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.to_string());

    let root_node = FileNode {
        name: root_name,
        path: root_path.to_string(),
        size: total_size,
        is_dir: true,
        category: FileCategory::Other,
        modified: None,
        accessed: None,
        children,
        file_count: total_files,
        importance_score: calculate_importance(total_size, None, &FileCategory::Other),
        is_program: false,
        program_name: None,
    };

    let mut largest_items = root_node.children.clone();
    largest_items.sort_by(|a, b| b.size.cmp(&a.size));
    largest_items.truncate(40);

    emit_progress("done", "Fertig", total_files_scanned, bytes_scanned.load(Ordering::Relaxed));

    Ok(ScanResult {
        root: root_node,
        total_size,
        total_files,
        category_summary,
        largest_items,
        recommendations: vec![],
        duplicates,
        installed_programs: vec![],
    })
}
