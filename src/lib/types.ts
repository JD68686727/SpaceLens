export type FileCategory =
  | "Programs"
  | "Documents"
  | "Images"
  | "Videos"
  | "Audio"
  | "Archives"
  | "Downloads"
  | "Temporary"
  | "System"
  | "Development"
  | "Games"
  | "Backups"
  | "Other";

export interface FileNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  category: FileCategory;
  modified: number | null;
  accessed: number | null;
  children: FileNode[];
  file_count: number;
  importance_score: number;
  is_program: boolean;
  program_name: string | null;
}

export interface Recommendation {
  title: string;
  description: string;
  size: number;
  path: string;
  severity: "low" | "medium" | "high";
  category: string;
}

export interface DuplicateGroup {
  size: number;
  hash: string;
  files: string[];
  total_wasted: number;
}

export interface InstalledProgram {
  name: string;
  path: string;
  size: number;
  file_count: number;
}

export interface ScanProgress {
  files_scanned: number;
  bytes_scanned: number;
  current_path: string;
  phase: string;
}

export interface ScanResult {
  root: FileNode;
  total_size: number;
  total_files: number;
  category_summary: Record<string, number>;
  largest_items: FileNode[];
  recommendations: Recommendation[];
  duplicates: DuplicateGroup[];
  installed_programs: InstalledProgram[];
}

export const CATEGORY_LABELS: Record<string, string> = {
  Programs: "Programme",
  Documents: "Dokumente",
  Images: "Bilder",
  Videos: "Videos",
  Audio: "Audio",
  Archives: "Archive",
  Downloads: "Downloads",
  Temporary: "Temporär / Cache",
  System: "System",
  Development: "Entwicklung",
  Games: "Spiele",
  Backups: "Backups",
  Other: "Sonstiges",
};

export const CATEGORY_COLORS: Record<string, string> = {
  Programs: "bg-violet-500",
  Documents: "bg-blue-500",
  Images: "bg-pink-500",
  Videos: "bg-rose-500",
  Audio: "bg-fuchsia-500",
  Archives: "bg-amber-500",
  Downloads: "bg-orange-500",
  Temporary: "bg-red-500",
  System: "bg-slate-500",
  Development: "bg-cyan-500",
  Games: "bg-emerald-500",
  Backups: "bg-teal-500",
  Other: "bg-zinc-500",
};

export const CATEGORY_HEX: Record<string, string> = {
  Programs: "#8b5cf6",
  Documents: "#3b82f6",
  Images: "#ec4899",
  Videos: "#f43f5e",
  Audio: "#d946ef",
  Archives: "#f59e0b",
  Downloads: "#f97316",
  Temporary: "#ef4444",
  System: "#64748b",
  Development: "#06b6d4",
  Games: "#10b981",
  Backups: "#14b8a6",
  Other: "#71717a",
};
