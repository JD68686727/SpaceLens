use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FileCategory {
    Programs,
    Documents,
    Images,
    Videos,
    Audio,
    Archives,
    Downloads,
    Temporary,
    System,
    Development,
    Games,
    Backups,
    Other,
}

impl FileCategory {
    pub fn label(&self) -> &'static str {
        match self {
            FileCategory::Programs => "Programme",
            FileCategory::Documents => "Dokumente",
            FileCategory::Images => "Bilder",
            FileCategory::Videos => "Videos",
            FileCategory::Audio => "Audio",
            FileCategory::Archives => "Archive",
            FileCategory::Downloads => "Downloads",
            FileCategory::Temporary => "Temporär / Cache",
            FileCategory::System => "System",
            FileCategory::Development => "Entwicklung",
            FileCategory::Games => "Spiele",
            FileCategory::Backups => "Backups",
            FileCategory::Other => "Sonstiges",
        }
    }
}

/// Strukturierter Anwendungsfehler mit Code, Nutzer-Text und optionalen Details.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    /// Maschinenlesbarer Code, z. B. "PATH_NOT_FOUND"
    pub code: String,
    /// Kurze, verständliche Meldung auf Deutsch
    pub message: String,
    /// Optionale technische Details (Pfad, Original-Fehler, …)
    pub details: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    pub fn path_not_found(path: &str) -> Self {
        Self::new(
            "PATH_NOT_FOUND",
            "Der gewählte Ordner oder das Laufwerk wurde nicht gefunden.",
        )
        .with_details(path)
    }

    pub fn permission_denied(path: &str) -> Self {
        Self::new(
            "PERMISSION_DENIED",
            "Keine Berechtigung zum Lesen dieses Ordners. Starte SpaceLens ggf. mit erweiterten Rechten oder wähle einen anderen Pfad.",
        )
        .with_details(path)
    }

    pub fn not_a_directory(path: &str) -> Self {
        Self::new(
            "NOT_A_DIRECTORY",
            "Der gewählte Pfad ist kein Ordner.",
        )
        .with_details(path)
    }

    pub fn io_error(context: &str, err: impl fmt::Display) -> Self {
        Self::new(
            "IO_ERROR",
            "Fehler beim Zugriff auf die Festplatte. Prüfe, ob das Laufwerk noch verbunden und erreichbar ist.",
        )
        .with_details(format!("{context}: {err}"))
    }

    pub fn scan_failed(err: impl fmt::Display) -> Self {
        Self::new(
            "SCAN_FAILED",
            "Der Scan konnte nicht abgeschlossen werden.",
        )
        .with_details(err.to_string())
    }

    pub fn trash_failed(summary: impl Into<String>) -> Self {
        Self::new(
            "TRASH_FAILED",
            "Mindestens eine Datei konnte nicht in den Papierkorb verschoben werden.",
        )
        .with_details(summary)
    }

    pub fn cancelled() -> Self {
        Self::new("SCAN_CANCELLED", "Der Scan wurde abgebrochen.")
    }

    pub fn unknown(err: impl fmt::Display) -> Self {
        Self::new(
            "UNKNOWN",
            "Ein unerwarteter Fehler ist aufgetreten.",
        )
        .with_details(err.to_string())
    }

    /// Als JSON-String für Tauri `Result::Err(String)`.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(
                r#"{{"code":"UNKNOWN","message":"{}","details":null}}"#,
                self.message.replace('"', "'")
            )
        })
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if let Some(ref d) = self.details {
            write!(f, " ({d})")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub category: FileCategory,
    pub modified: Option<u64>,
    pub accessed: Option<u64>,
    pub children: Vec<FileNode>,
    pub file_count: u64,
    pub importance_score: f64,
    pub is_program: bool,
    pub program_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub files_scanned: u64,
    pub bytes_scanned: u64,
    pub current_path: String,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub size: u64,
    pub hash: String,
    pub files: Vec<String>,
    pub total_wasted: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledProgram {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recommendation {
    pub title: String,
    pub description: String,
    pub size: u64,
    pub path: String,
    pub severity: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub root: FileNode,
    pub total_size: u64,
    pub total_files: u64,
    pub category_summary: HashMap<String, u64>,
    pub largest_items: Vec<FileNode>,
    pub recommendations: Vec<Recommendation>,
    pub duplicates: Vec<DuplicateGroup>,
    pub installed_programs: Vec<InstalledProgram>,
}
