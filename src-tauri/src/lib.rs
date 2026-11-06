mod types;
mod scanner;

pub use types::*;
pub use scanner::scan_directory;

use std::path::Path;
use tauri::AppHandle;

fn err_json(e: AppError) -> String {
    e.to_json_string()
}

#[tauri::command]
async fn scan_path(path: String, app: AppHandle) -> Result<ScanResult, String> {
    let handle = app.clone();
    let path_for_block = path.clone();
    tauri::async_runtime::spawn_blocking(move || scan_directory(&path_for_block, Some(handle)))
        .await
        .map_err(|e| err_json(AppError::unknown(e)))?
        .map_err(|e| {
            if e.contains("SCAN_CANCELLED") || e.contains("abgebrochen") {
                err_json(AppError {
                    code: "SCAN_CANCELLED".into(),
                    message: "Scan wurde abgebrochen.".into(),
                    details: None,
                })
            } else if e.contains("PATH_NOT_FOUND") || e.contains("existiert nicht") || e.contains("not found") {
                err_json(AppError::path_not_found(&path))
            } else if e.contains("NOT_A_DIRECTORY") || e.contains("kein Ordner") {
                err_json(AppError::not_a_directory(&path))
            } else if e.contains("Permission") || e.contains("permission") || e.contains("Access") || e.contains("Zugriff") {
                err_json(AppError::permission_denied(&path))
            } else {
                err_json(AppError::scan_failed(e))
            }
        })
}

#[tauri::command]
fn cancel_scan() {
    scanner::request_scan_cancel();
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
        match trash::delete(p) {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("permission") || msg.to_lowercase().contains("access") {
                    errors.push(format!("{p} (keine Berechtigung)"));
                } else {
                    errors.push(format!("{p} → {msg}"));
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(err_json(AppError::trash_failed(errors.join("\n"))))
    }
}

/// Öffnet den Pfad im System-Explorer (Windows: explorer /select)
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let normalized = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{normalized}"))
            .spawn()
            .map_err(|e| format!("Explorer konnte nicht gestartet werden: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Ordner öffnen (kein universelles Select)
        let p = Path::new(&path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Nicht unterstützt".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            cancel_scan,
            get_available_drives,
            move_to_trash,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
