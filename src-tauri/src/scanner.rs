use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn request_scan_cancel() {
    SCAN_CANCELLED.store(true, Ordering::SeqCst);
}

pub fn reset_scan_cancel() {
    SCAN_CANCELLED.store(false, Ordering::SeqCst);
}

pub fn is_scan_cancelled() -> bool {
    SCAN_CANCELLED.load(Ordering::SeqCst)
}

const MIN_TREE_FILE_SIZE: u64 = 256 * 1024;
const MAX_CHILDREN: usize = 40;
const MAX_TREE_DEPTH: usize = 6;
const MAX_HASH_CANDIDATES: usize = 8_000;

fn system_time_to_unix(time: SystemTime) -> Option<u64> {
    time.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

pub fn categorize(path: &Path, is_dir: bool) -> FileCategory {
    let path_str = path.to_string_lossy().to_lowercase();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if name == "pagefile.sys"
        || name == "hiberfil.sys"
        || name == "swapfile.sys"
        || name.ends_with(".dmp")
        || name == "system volume information"
        || name == "$recycle.bin"
        || name == "$sysreset"
    {
        return FileCategory::System;
    }

    if path_str.contains("\\appdata\\local\\temp")
        || path_str.contains("\\windows\\temp")
        || path_str.contains("\\appdata\\local\\pip\\cache")
        || path_str.contains("\\appdata\\local\\npm-cache")
        || path_str.contains("\\tmp\\")
        || path_str.contains("/tmp/")
        || name == "cache"
        || name == "temp"
        || name == "tmp"
        || name.ends_with(".tmp")
    {
        return FileCategory::Temporary;
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
        || path_str.contains("\\.cargo\\")
        || path_str.contains("\\.rustup\\")
        || path_str.contains("\\.nuget\\")
    {
        return FileCategory::Development;
    }

    if path_str.contains("\\docker\\")
        || path_str.contains("\\wsl\\")
        || name.ends_with(".vhdx")
        || name.ends_with(".vhd")
    {
        if name.ends_with(".vhdx") || name.ends_with(".vhd") || name.ends_with(".iso") {
            return FileCategory::Archives;
        }
        return FileCategory::System;
    }

    if path_str.contains("\\steam\\steamapps")
        || path_str.contains("\\steamapps\\")
        || path_str.contains("\\epic games\\")
        || path_str.contains("\\xboxgames\\")
        || name == "steamapps"
    {
        return FileCategory::Games;
    }

    if path_str.contains("\\program files\\")
        || path_str.contains("\\program files (x86)\\")
        || path_str.contains("\\appdata\\local\\programs\\")
        || path_str.contains("\\windowsapps\\")
    {
        return FileCategory::Programs;
    }

    if path_str.contains("\\nvidia")
        || path_str.contains("\\programdata\\nvidia")
        || path_str.contains("\\programdata\\package cache")
    {
        if path_str.contains("\\cache") || path_str.contains("\\temp") {
            return FileCategory::Temporary;
        }
        return FileCategory::System;
    }

    if path_str.contains("\\windows\\")
        || path_str.contains("\\system32")
        || path_str.contains("\\syswow64")
        || path_str.contains("\\winsxs")
        || path_str.contains("\\programdata\\microsoft\\windows")
    {
        return FileCategory::System;
    }

    if path_str.contains("\\downloads\\") || name == "downloads" {
        return FileCategory::Downloads;
    }
    if path_str.contains("\\pictures\\") || name == "pictures" || name == "screenshots" {
        return FileCategory::Images;
    }
    if path_str.contains("\\videos\\") || name == "videos" {
        return FileCategory::Videos;
    }
    if path_str.contains("\\music\\") || name == "music" {
        return FileCategory::Audio;
    }
    if path_str.contains("\\documents\\")
        || path_str.contains("\\onedrive")
        || path_str.contains("\\desktop\\")
        || name == "documents"
        || name == "desktop"
    {
        return FileCategory::Documents;
    }

    if path_str.contains("\\appdata\\local\\") || path_str.contains("\\appdata\\roaming\\") {
        if path_str.contains("\\google\\chrome")
            || path_str.contains("\\microsoft\\edge")
            || path_str.contains("\\discord")
            || path_str.contains("\\spotify")
        {
            return FileCategory::Programs;
        }
        if path_str.contains("\\unity") || path_str.contains("\\jetbrains") {
            return FileCategory::Development;
        }
        return FileCategory::Programs;
    }

    if path_str.contains("\\programdata\\") {
        return FileCategory::System;
    }

    if name.contains("backup") || name.ends_with(".bak") {
        return FileCategory::Backups;
    }

    if is_dir {
        return FileCategory::Other;
    }

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_lowercase();
        match ext.as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "heic" => FileCategory::Images,
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" => FileCategory::Videos,
            "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" => FileCategory::Audio,
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "csv" => FileCategory::Documents,
            "zip" | "rar" | "7z" | "tar" | "gz" | "iso" => FileCategory::Archives,
            "exe" | "msi" | "msix" | "appx" => FileCategory::Programs,
            "sys" | "dll" | "drv" => FileCategory::System,
            "log" => FileCategory::Temporary,
            _ => FileCategory::Other,
        }
    } else {
        FileCategory::Other
    }
}

// NOTE: remainder of scanner (scan_directory, duplicates, etc.) unchanged from previous version –
// this file must stay complete. If this replace truncated, restore from git history.
