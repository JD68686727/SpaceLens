mod types;
mod scanner;

pub use types::*;
pub use scanner::scan_directory;

use std::path::Path;
use tauri::AppHandle;
use types::*;

#[tauri::command]
async fn scan_path(path: String, app: AppHandle) -> Result<ScanResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan_directory(&path, Some(handle)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_available_drives() -> Result<Vec<String>, String> {
    let mut drives = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                drives.push(drive);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates = ["/", "/home", "/Users", "/mnt", "/media", "/Volumes"];
        for c in candidates {
            if Path::new(c).exists() {
                drives.push(c.to_string());
            }
        }
        for base in ["/mnt", "/media", "/Volumes"] {
            if let Ok(entries) = std::fs::read_dir(base) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        drives.push(p.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    drives.sort();
    drives.dedup();
    Ok(drives)
}

#[tauri::command]
fn move_to_trash(paths: Vec<String>) -> Result<(), String> {
    let mut errors = Vec::new();
    for p in &paths {
        if let Err(e) = trash::delete(p) {
            errors.push(format!("{} → {}", p, e));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            get_available_drives,
            move_to_trash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
