use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
