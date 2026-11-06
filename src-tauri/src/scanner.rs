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
        || path_str.contains("/tmp/")
        || path_str.contains("/var/tmp")
        || path_str.contains("/var/cache")
        || name == "cache"
        || name == "temp"
        || name == "tmp"
        || name.ends_with(".tmp")
        || name == "thumbs.db"
        || name == ".ds_store"
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
        || name.ends_with(".appimage")
    {
        return FileCategory::Programs;
    }

    if path_str.contains("/windows/")
        || path_str.contains("\\windows\\")
        || path_str.contains("/system32")
        || path_str.contains("/sys/")
        || path_str.contains("/boot/")
        || path_str.contains("/library/system")
        || path_str.contains("/usr/lib")
        || path_str.contains("/usr/bin")
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
        || name == ".gradle"
        || name == "bower_components"
        || path_str.contains("/.cargo")
        || path_str.contains("/.npm")
        || path_str.contains("/.rustup")
        || path_str.contains("/.nuget")
        || path_str.contains("/.pnpm-store")
    {
        return FileCategory::Development;
    }

    if path_str.contains("/steam/steamapps")
        || path_str.contains("\\steam\\steamapps")
        || path_str.contains("/epic games")
        || path_str.contains("\\epic games")
        || path_str.contains("/gog galaxy")
        || path_str.contains("\\gog galaxy")
        || path_str.contains("/xboxgames")
        || name == "steamapps"
    {
        return FileCategory::Games;
    }

    if name.contains("backup")
        || name.ends_with(".bak")
        || name.ends_with(".old")
        || path_str.contains("/backups")
        || path_str.contains("\\backups")
        || name.ends_with(".sparsebundle")
        || name.ends_with(".tmbundle")
    {
        return FileCategory::Backups;
    }

    if is_dir {
        return FileCategory::Other;
    }

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_lowercase();
        match ext.as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "heic" | "raw" | "tiff"
            | "ico" | "avif" => FileCategory::Images,
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpeg" | "ts" => {
                FileCategory::Videos
            }
            "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "aiff" | "opus" => {
                FileCategory::Audio
            }
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt"
            | "md" | "csv" | "epub" | "pages" | "numbers" | "key" => FileCategory::Documents,
            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" | "tgz" => {
                FileCategory::Archives
            }
            "exe" | "msi" | "app" | "deb" | "rpm" | "appimage" | "pkg" => {
                FileCategory::Programs
            }
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
            if age_days > 365.0 * 2.0 { 1.45 }
            else if age_days > 365.0 { 1.25 }
            else if age_days < 14.0 { 0.65 }
            else { 1.0 }
        }
        None => 1.0,
    };
    let category_weight = match category {
        FileCategory::Temporary => 1.7,
        FileCategory::Downloads => 1.45,
        FileCategory::Archives => 1.35,
        FileCategory::Development => 1.3,
        FileCategory::Backups => 1.25,
        FileCategory::Videos => 1.15,
        FileCategory::Games => 1.1,
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

fn is_program_dir(path: &Path, name: &str) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();
    let name_lower = name.to_lowercase();
    if name_lower.ends_with(".app") {
        return true;
    }
    if (path_str.contains("\\program files") || path_str.contains("/program files"))
        && path.parent().map(|p| {
            let ps = p.to_string_lossy().to_lowercase();
            ps.ends_with("program files") || ps.ends_with("program files (x86)")
        }).unwrap_or(false)
    {
        return true;
    }
    if path_str.contains("\\appdata\\local\\programs\\")
        || path_str.contains("/appdata/local/programs/")
        || path_str.contains("/applications/")
    {
        if let Some(parent) = path.parent() {
            let ps = parent.to_string_lossy().to_lowercase();
            if ps.ends_with("/applications")
                || ps.ends_with("\\applications")
                || ps.ends_with("/programs")
                || ps.ends_with("\\programs")
            {
                return true;
            }
        }
    }
    false
}

pub fn scan_directory(
    root_path: &str,
    app: Option<AppHandle>,
) -> Result<ScanResult, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("PATH_NOT_FOUND: Pfad existiert nicht: {}", root_path));
    }
    if !root.is_dir() {
        return Err(format!("NOT_A_DIRECTORY: Pfad ist kein Ordner: {}", root_path));
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

        if count % 800 == 0 {
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

    let mut nodes: HashMap<String, FileNode> = HashMap::new();
    let mut parent_map: HashMap<String, String> = HashMap::new();
    let mut category_summary: HashMap<String, u64> = HashMap::new();
    let mut total_size = 0u64;
    let mut total_files = 0u64;
    let root_key = root.to_string_lossy().to_string();

    for (path, size, is_dir, modified, accessed) in &entries {
        let path_str = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());

        let category = categorize(path, *is_dir);
        let importance = calculate_importance(*size, *modified, &category);
        let is_prog = is_program_dir(path, &name);

        if !is_dir {
            total_size += size;
            total_files += 1;
            *category_summary
                .entry(format!("{:?}", category))
                .or_insert(0) += size;
        }

        let node = FileNode {
            name: name.clone(),
            path: path_str.clone(),
            size: *size,
            is_dir: *is_dir,
            category,
            modified: *modified,
            accessed: *accessed,
            children: vec![],
            file_count: if *is_dir { 0 } else { 1 },
            importance_score: importance,
            is_program: is_prog,
            program_name: if is_prog { Some(name) } else { None },
        };

        nodes.insert(path_str.clone(), node);

        if let Some(parent) = path.parent() {
            let parent_str = parent.to_string_lossy().to_string();
            if parent_str != path_str {
                parent_map.insert(path_str, parent_str);
            }
        }
    }

    if !nodes.contains_key(&root_key) {
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.to_string());
        nodes.insert(
            root_key.clone(),
            FileNode {
                name: root_name,
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
    paths.sort_by(|a, b| {
        b.matches(std::path::MAIN_SEPARATOR)
            .count()
            .cmp(&a.matches(std::path::MAIN_SEPARATOR).count())
    });

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

    for node in nodes.values_mut() {
        node.children.sort_by(|a, b| b.size.cmp(&a.size));
        if node.children.len() > 200 {
            node.children.truncate(200);
        }
    }

    let mut root_node = nodes
        .remove(&root_key)
        .ok_or_else(|| "SCAN_FAILED: Root-Knoten konnte nicht gebaut werden".to_string())?;

    root_node.size = total_size;
    root_node.file_count = total_files;
    root_node.importance_score =
        calculate_importance(total_size, None, &FileCategory::Other);

    let mut largest_items: Vec<FileNode> = Vec::new();
    fn collect_large(node: &FileNode, out: &mut Vec<FileNode>, depth: usize) {
        if depth > 3 {
            return;
        }
        for child in &node.children {
            if child.size > 0 {
                out.push(child.clone());
            }
            if child.is_dir {
                collect_large(child, out, depth + 1);
            }
        }
    }
    collect_large(&root_node, &mut largest_items, 0);
    largest_items.sort_by(|a, b| b.size.cmp(&a.size));
    largest_items.truncate(50);

    let mut installed_programs: Vec<InstalledProgram> = Vec::new();
    fn collect_programs(node: &FileNode, out: &mut Vec<InstalledProgram>) {
        if node.is_program {
            out.push(InstalledProgram {
                name: node.program_name.clone().unwrap_or_else(|| node.name.clone()),
                path: node.path.clone(),
                size: node.size,
                file_count: node.file_count,
            });
        }
        for child in &node.children {
            collect_programs(child, out);
        }
    }
    collect_programs(&root_node, &mut installed_programs);
    installed_programs.sort_by(|a, b| b.size.cmp(&a.size));
    installed_programs.truncate(80);

    emit_progress(
        "duplicates",
        "Suche Duplikate…",
        total_files_scanned,
        bytes_scanned.load(Ordering::Relaxed),
    );
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
                hash_map
                    .entry(h)
                    .or_default()
                    .push(p.to_string_lossy().to_string());
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
    duplicates.truncate(60);

    let mut recommendations: Vec<Recommendation> = Vec::new();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    fn walk_recs(
        node: &FileNode,
        now: u64,
        recs: &mut Vec<Recommendation>,
        seen: &mut HashSet<String>,
    ) {
        let cat = &node.category;
        let age_days = node
            .modified
            .map(|ts| (now.saturating_sub(ts)) as f64 / 86400.0)
            .unwrap_or(0.0);

        if matches!(cat, FileCategory::Temporary) && node.size > 50 * 1024 * 1024 {
            let key = format!("temp:{}", node.path);
            if seen.insert(key) {
                recs.push(Recommendation {
                    title: format!("Temporäre Dateien: {}", node.name),
                    description: "Cache- und Temp-Ordner können meist gefahrlos geleert werden."
                        .into(),
                    size: node.size,
                    path: node.path.clone(),
                    severity: if node.size > 500 * 1024 * 1024 {
                        "high".into()
                    } else {
                        "medium".into()
                    },
                    category: "Temporary".into(),
                });
            }
        }

        if matches!(cat, FileCategory::Downloads)
            && node.size > 20 * 1024 * 1024
            && age_days > 90.0
        {
            let key = format!("dl:{}", node.path);
            if seen.insert(key) {
                recs.push(Recommendation {
                    title: format!("Alte Downloads: {}", node.name),
                    description: format!(
                        "Diese Datei/Ordner ist seit {:.0} Tagen nicht mehr geändert worden.",
                        age_days
                    ),
                    size: node.size,
                    path: node.path.clone(),
                    severity: if age_days > 365.0 {
                        "high".into()
                    } else {
                        "medium".into()
                    },
                    category: "Downloads".into(),
                });
            }
        }

        if matches!(cat, FileCategory::Development)
            && (node.name == "node_modules"
                || node.name == "target"
                || node.name == "dist"
                || node.name == "build"
                || node.name == "__pycache__")
            && node.size > 30 * 1024 * 1024
        {
            let key = format!("dev:{}", node.path);
            if seen.insert(key) {
                recs.push(Recommendation {
                    title: format!("Build-/Cache-Ordner: {}", node.name),
                    description: "Entwicklungs-Artefakte können oft gelöscht und bei Bedarf neu erzeugt werden.".into(),
                    size: node.size,
                    path: node.path.clone(),
                    severity: "medium".into(),
                    category: "Development".into(),
                });
            }
        }

        for child in &node.children {
            walk_recs(child, now, recs, seen);
        }
    }

    let mut seen = HashSet::new();
    walk_recs(&root_node, now, &mut recommendations, &mut seen);
    recommendations.sort_by(|a, b| b.size.cmp(&a.size));
    recommendations.truncate(40);

    emit_progress(
        "done",
        "Fertig",
        total_files_scanned,
        bytes_scanned.load(Ordering::Relaxed),
    );

    Ok(ScanResult {
        root: root_node,
        total_size,
        total_files,
        category_summary,
        largest_items,
        recommendations,
        duplicates,
        installed_programs,
    })
}
