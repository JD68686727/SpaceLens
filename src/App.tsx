import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  HardDrive, FolderOpen, AlertTriangle, Layers, ListTree, BarChart3,
  Loader2, ChevronRight, ChevronDown, File, Folder, Trash2, Copy,
  AppWindow, LayoutGrid, Sun, Moon, Download, X, Check,
} from "lucide-react";
import type { ScanResult, FileNode, ScanProgress, AppError } from "./lib/types";
import { CATEGORY_LABELS, CATEGORY_COLORS, parseAppError, ERROR_CODE_LABELS } from "./lib/types";
import { formatBytes, formatNumber, formatDate } from "./lib/format";
import Treemap from "./components/Treemap";
import clsx from "clsx";

type ViewMode = "tree" | "treemap" | "categories" | "largest" | "recommendations" | "duplicates" | "programs";
type Theme = "dark" | "light";

interface AppSettings {
  theme: Theme;
  lastPath: string | null;
  preferredView: ViewMode;
}

const SETTINGS_KEY = "spacelens-settings";

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        theme: p.theme === "light" ? "light" : "dark",
        lastPath: p.lastPath || null,
        preferredView: p.preferredView || "treemap",
      };
    }
  } catch {}
  return { theme: "dark", lastPath: null, preferredView: "treemap" };
}

function saveSettings(s: AppSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function TreeItem({ node, depth = 0, selectedPath, onSelect }: {
  node: FileNode; depth?: number; selectedPath: string | null; onSelect: (n: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;
  return (
    <div>
      <div className={clsx("flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer text-sm hover:bg-slate-800/80 transition-colors",
        isSelected && "bg-indigo-600/30 text-indigo-100", node.is_program && "border-l-2 border-violet-500")}
        style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => onSelect(node)}>
        {hasChildren ? (
          <button className="p-0.5 hover:bg-slate-700 rounded" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
            {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
          </button>
        ) : <span className="w-[18px]" />}
        {node.is_dir ? <Folder size={15} className="text-amber-400 shrink-0" /> : <File size={15} className="text-slate-400 shrink-0" />}
        <span className="truncate flex-1 min-w-0">{node.name}{node.is_program && <span className="ml-1.5 text-[10px] text-violet-300 bg-violet-500/20 px-1 rounded">App</span>}</span>
        <span className="text-xs text-slate-400 tabular-nums shrink-0">{formatBytes(node.size)}</span>
      </div>
      {open && hasChildren && node.children.map((child) => (
        <TreeItem key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [view, setView] = useState<ViewMode>(() => loadSettings().preferredView || "treemap");
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [status, setStatus] = useState("Bereit");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set());
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [availableDrives, setAvailableDrives] = useState<string[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  const [loadingDrives, setLoadingDrives] = useState(false);

  const theme = settings.theme;
  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
    document.body.style.backgroundColor = isDark ? "#020617" : "#f8fafc";
    document.body.style.color = isDark ? "#f1f5f9" : "#0f172a";
  }, [isDark]);

  useEffect(() => { saveSettings(settings); }, [settings]);

  const toggleTheme = () => setSettings((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }));
  const setPreferredView = (v: ViewMode) => { setView(v); setSettings((s) => ({ ...s, preferredView: v })); };

  useEffect(() => {
    const unlisten = listen<ScanProgress>("scan-progress", (event) => {
      setProgress(event.payload);
      const p = event.payload;
      const phaseLabel: Record<string, string> = { scanning: "Scanne Dateien", building: "Baue Baum", duplicates: "Suche Duplikate", done: "Fertig" };
      setStatus(`${phaseLabel[p.phase] || p.phase}… ${formatNumber(p.files_scanned)} Dateien · ${formatBytes(p.bytes_scanned)}`);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const openDrivePicker = useCallback(async () => {
    setShowDrivePicker(true);
    setSelectedDrive(null);
    setLoadingDrives(true);
    setError(null);
    try {
      const drives = await invoke<string[]>("get_available_drives");
      setAvailableDrives(drives);
      if (drives.length === 1) setSelectedDrive(drives[0]);
      else if (settings.lastPath && drives.includes(settings.lastPath)) setSelectedDrive(settings.lastPath);
    } catch (e: any) {
      setError(parseAppError(e));
      setShowDrivePicker(false);
    } finally {
      setLoadingDrives(false);
    }
  }, [settings.lastPath]);

  const startScan = useCallback(async (path?: string) => {
    setError(null); setShowErrorDetails(false); setShowDrivePicker(false);
    setScanning(true); setResult(null); setSelected(null); setProgress(null); setSelectedDupes(new Set()); setStatus("Starte Scan…");
    try {
      let target = path;
      if (!target) {
        const selectedPath = await open({ directory: true, multiple: false, title: "Ordner oder Laufwerk zum Scannen wählen" });
        if (!selectedPath) { setScanning(false); setStatus("Bereit"); return; }
        target = selectedPath as string;
      }
      const data = await invoke<ScanResult>("scan_path", { path: target });
      setResult(data); setSelected(data.root);
      setStatus(`Fertig – ${formatNumber(data.total_files)} Dateien, ${formatBytes(data.total_size)}`);
      setView(settings.preferredView || "treemap");
      setSettings((s) => ({ ...s, lastPath: target as string }));
    } catch (e: any) {
      const appErr = parseAppError(e);
      if (appErr.code === "SCAN_CANCELLED") {
        setStatus("Scan abgebrochen");
        setError(null);
      } else {
        setError(appErr);
        setShowErrorDetails(false);
        setStatus("Fehler beim Scannen");
      }
    }
    finally { setScanning(false); setProgress(null); }
  }, [settings.preferredView]);

  const moveToTrash = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!window.confirm(`Wirklich ${paths.length} Element(e) in den Papierkorb verschieben?\n\n${paths.slice(0, 5).join("\n")}${paths.length > 5 ? "\n…" : ""}`)) return;
    setTrashBusy(true);
    try { await invoke("move_to_trash", { paths }); alert("Erfolgreich in den Papierkorb verschoben.\nBitte erneut scannen, um die Ansicht zu aktualisieren."); }
    catch (e: any) { const appErr = parseAppError(e); alert(`${appErr.message}${appErr.details ? "\n\nDetails:\n" + appErr.details : ""}`); }
    finally { setTrashBusy(false); }
  };

  const exportResults = () => {
    if (!result) return;
    const payload = {
      exported_at: new Date().toISOString(), total_size: result.total_size, total_files: result.total_files,
      category_summary: result.category_summary,
      largest_items: result.largest_items.map((i) => ({ name: i.name, path: i.path, size: i.size, category: i.category, is_dir: i.is_dir })),
      duplicates: result.duplicates, installed_programs: result.installed_programs, recommendations: result.recommendations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `spacelens-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const toggleDupe = (path: string) => {
    setSelectedDupes((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  };

  const categoryEntries = result ? Object.entries(result.category_summary).sort((a, b) => b[1] - a[1]) : [];
  const totalWasted = result ? result.duplicates.reduce((s, d) => s + d.total_wasted, 0) : 0;

  return (
    <div className={clsx("h-screen flex flex-col transition-colors", isDark ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-900")}>
      <header className={clsx("flex items-center gap-3 px-4 py-3 border-b backdrop-blur", isDark ? "border-slate-800 bg-slate-900/80" : "border-slate-200 bg-white/90")}>
        <div className="flex items-center gap-2">
          <HardDrive className="text-indigo-400" size={22} />
          <h1 className="font-semibold text-lg tracking-tight">SpaceLens</h1>
        </div>
        <div className="flex-1" />
        {settings.lastPath && !scanning && (
          <button onClick={() => startScan(settings.lastPath!)} className={clsx("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors", isDark ? "text-slate-400 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100")} title={settings.lastPath}>
            <FolderOpen size={14} /> Letzter Scan
          </button>
        )}
        {result && (
          <button onClick={exportResults} className={clsx("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors", isDark ? "text-slate-400 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100")} title="Als JSON exportieren">
            <Download size={14} /> Export
          </button>
        )}
        <button onClick={toggleTheme} className={clsx("p-2 rounded-lg transition-colors", isDark ? "text-slate-400 hover:bg-slate-800 hover:text-amber-300" : "text-slate-500 hover:bg-slate-100 hover:text-indigo-600")} title={isDark ? "Heller Modus" : "Dunkler Modus"}>
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button onClick={openDrivePicker} disabled={scanning} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium transition-colors text-white">
          {scanning ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />} Laufwerk scannen
        </button>
      </header>

      <div className={clsx("px-4 py-1.5 text-xs border-b", isDark ? "text-slate-400 border-slate-800/60 bg-slate-900/40" : "text-slate-500 border-slate-200 bg-slate-100/60")}>
        <div className="flex items-center gap-3">
          <span className="truncate flex-1">{status}</span>
          {error && <span className="text-red-400 font-medium">[{error.code}] {error.message}</span>}
        </div>
        {scanning && progress && (
          <div className="mt-1.5">
            <div className={clsx("h-1.5 rounded-full overflow-hidden", isDark ? "bg-slate-800" : "bg-slate-200")}>
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                style={{
                  width:
                    progress.phase === "done" ? "100%" :
                    progress.phase === "duplicates" ? "90%" :
                    progress.phase === "building" ? "75%" :
                    "40%",
                }}
              />
            </div>
            <div className="truncate text-[11px] text-slate-500 mt-0.5">{progress.current_path}</div>
          </div>
        )}
      </div>

      {error && !scanning && (
        <div className={clsx(
          "mx-4 mt-3 rounded-xl border px-4 py-3 text-sm",
          isDark ? "bg-red-950/40 border-red-500/30 text-red-200" : "bg-red-50 border-red-200 text-red-800"
        )}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-red-400 shrink-0 mt-0.5" size={18} />
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-2 flex-wrap">
                <span>{error.message}</span>
                <span className={clsx(
                  "text-[10px] px-1.5 py-0.5 rounded font-mono",
                  isDark ? "bg-red-500/20 text-red-300" : "bg-red-100 text-red-700"
                )}>
                  {ERROR_CODE_LABELS[error.code] || error.code}
                </span>
              </div>
              {error.details && (
                <div className="mt-2">
                  <button onClick={() => setShowErrorDetails((v) => !v)} className="text-xs underline opacity-80 hover:opacity-100">
                    {showErrorDetails ? "Details ausblenden" : "Technische Details anzeigen"}
                  </button>
                  {showErrorDetails && (
                    <pre className={clsx("mt-1.5 text-xs p-2 rounded-lg overflow-x-auto whitespace-pre-wrap break-all", isDark ? "bg-black/30 text-red-300/90" : "bg-red-100/80 text-red-900")}>
                      {error.details}
                    </pre>
                  )}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <button onClick={openDrivePicker} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium">Erneut versuchen</button>
                <button onClick={() => { setError(null); setShowErrorDetails(false); }} className={clsx("px-3 py-1.5 rounded-lg text-xs", isDark ? "bg-slate-800 hover:bg-slate-700" : "bg-white border border-red-200 hover:bg-red-50")}>Schließen</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!result && !scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 text-slate-400">
          <HardDrive size={64} className="opacity-30" />
          <div className="text-center space-y-2">
            <p className={clsx("text-lg", isDark ? "text-slate-300" : "text-slate-700")}>Noch kein Scan durchgeführt</p>
            <p className="text-sm max-w-md">Wähle ein Laufwerk oder einen Ordner. SpaceLens zeigt übersichtlich, was Platz verbraucht, findet Duplikate und gibt konkrete Aufräum-Empfehlungen.</p>
          </div>
          <button onClick={openDrivePicker} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-medium transition-colors text-white">
            <HardDrive size={18} /> Laufwerk auswählen & scannen
          </button>
        </div>
      )}

      {scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Loader2 size={48} className="animate-spin text-indigo-400" />
          <p className={isDark ? "text-slate-300" : "text-slate-700"}>
            {progress?.phase === "duplicates" ? "Suche Duplikate…" :
             progress?.phase === "building" ? "Verarbeite Ergebnisse…" :
             "Scanne Dateisystem…"}
          </p>
          <p className="text-sm text-slate-500 max-w-sm text-center">Bei sehr großen Laufwerken kann das einige Minuten dauern.</p>
          <button
            onClick={async () => {
              try { await invoke("cancel_scan"); } catch {}
              setStatus("Scan wird abgebrochen…");
            }}
            className={clsx(
              "mt-2 px-4 py-2 rounded-lg text-sm border transition-colors",
              isDark ? "border-slate-600 text-slate-300 hover:bg-slate-800" : "border-slate-300 text-slate-600 hover:bg-slate-100"
            )}
          >
            Scan abbrechen
          </button>
        </div>
      )}

      {result && (
        <div className="flex-1 flex overflow-hidden">
          <aside className={clsx("w-52 border-r flex flex-col shrink-0", isDark ? "border-slate-800 bg-slate-900/50" : "border-slate-200 bg-white")}>
            <nav className="p-2 space-y-0.5">
              {([{ id: "treemap", label: "Treemap", icon: LayoutGrid }, { id: "tree", label: "Baumansicht", icon: ListTree }, { id: "categories", label: "Kategorien", icon: Layers }, { id: "largest", label: "Größte Elemente", icon: BarChart3 }, { id: "programs", label: "Programme", icon: AppWindow }, { id: "duplicates", label: "Duplikate", icon: Copy }, { id: "recommendations", label: "Empfehlungen", icon: AlertTriangle }] as const).map((item) => (
                <button key={item.id} onClick={() => setPreferredView(item.id)} className={clsx("w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                  view === item.id ? "bg-indigo-600/20 text-indigo-300" : isDark ? "text-slate-400 hover:bg-slate-800 hover:text-slate-200" : "text-slate-600 hover:bg-slate-100")}>
                  <item.icon size={16} /> {item.label}
                  {item.id === "duplicates" && result.duplicates.length > 0 && <span className="ml-auto text-[10px] bg-amber-500/20 text-amber-300 px-1.5 rounded-full">{result.duplicates.length}</span>}
                </button>
              ))}
            </nav>
            <div className={clsx("mt-auto p-3 border-t text-xs space-y-1.5", isDark ? "border-slate-800 text-slate-400" : "border-slate-200 text-slate-500")}>
              <div className="flex justify-between"><span>Gesamt</span><span className={clsx("font-medium", isDark ? "text-slate-200" : "text-slate-800")}>{formatBytes(result.total_size)}</span></div>
              <div className="flex justify-between"><span>Dateien</span><span>{formatNumber(result.total_files)}</span></div>
              {totalWasted > 0 && <div className="flex justify-between text-amber-500"><span>Duplikate</span><span>{formatBytes(totalWasted)}</span></div>}
            </div>
          </aside>

          <main className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3">
              {view === "treemap" && <Treemap root={result.root} onSelect={setSelected} selectedPath={selected?.path} />}
              {view === "tree" && <TreeItem node={result.root} selectedPath={selected?.path ?? null} onSelect={setSelected} />}
              {view === "categories" && (
                <div className="space-y-2 max-w-2xl">{categoryEntries.map(([cat, size]) => {
                  const pct = (size / result.total_size) * 100;
                  return (
                    <div key={cat} className={clsx("rounded-xl p-3 border", isDark ? "bg-slate-900/60 border-slate-800" : "bg-white border-slate-200")}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2"><div className={clsx("w-3 h-3 rounded-full", CATEGORY_COLORS[cat] || "bg-zinc-500")} /><span className="font-medium">{CATEGORY_LABELS[cat] || cat}</span></div>
                        <span className="text-sm">{formatBytes(size)}</span>
                      </div>
                      <div className={clsx("h-2 rounded-full overflow-hidden", isDark ? "bg-slate-800" : "bg-slate-100")}><div className={clsx("h-full rounded-full", CATEGORY_COLORS[cat] || "bg-zinc-500")} style={{ width: `${Math.max(pct, 1)}%` }} /></div>
                      <div className="text-xs text-slate-500 mt-1">{pct.toFixed(1)} % des gesamten Speichers</div>
                    </div>
                  );
                })}</div>
              )}
              {view === "largest" && (
                <div className="space-y-1 max-w-3xl">
                  {result.largest_items.map((item) => (
                    <div key={item.path} onClick={() => setSelected(item)} className={clsx("flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors",
                      selected?.path === item.path ? "bg-indigo-600/20" : isDark ? "hover:bg-slate-800/80" : "hover:bg-slate-100")}>
                      {item.is_dir ? <Folder size={16} className="text-amber-400 shrink-0" /> : <File size={16} className="text-slate-400 shrink-0" />}
                      <span className="truncate flex-1">{item.name}</span>
                      <span className={clsx("text-xs px-1.5 py-0.5 rounded", CATEGORY_COLORS[item.category] || "bg-zinc-500", "text-white/90")}>{CATEGORY_LABELS[item.category] || item.category}</span>
                      <span className="tabular-nums text-slate-400 shrink-0 w-20 text-right">{formatBytes(item.size)}</span>
                    </div>
                  ))}
                </div>
              )}
              {view === "programs" && (
                <div className="space-y-1 max-w-3xl">
                  {result.installed_programs.length === 0 ? <p className="text-slate-500 text-sm p-4">Keine Programme erkannt.</p> :
                    result.installed_programs.map((prog) => (
                      <div key={prog.path} className={clsx("flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm", isDark ? "hover:bg-slate-800/60" : "hover:bg-slate-100")}>
                        <AppWindow size={16} className="text-violet-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{prog.name}</div>
                          <div className="text-xs text-slate-500 truncate">{prog.path}</div>
                        </div>
                        <span className="text-xs text-slate-500">{formatNumber(prog.file_count)} Dateien</span>
                        <span className="tabular-nums shrink-0 w-20 text-right">{formatBytes(prog.size)}</span>
                      </div>
                    ))}
                </div>
              )}
              {view === "duplicates" && (
                <div className="space-y-4 max-w-3xl">
                  {result.duplicates.length === 0 ? <p className="text-slate-500 text-sm p-4">Keine Duplikate gefunden (nur Dateien ≥ 1 MB werden geprüft).</p> :
                    result.duplicates.map((group) => (
                      <div key={group.hash} className={clsx("rounded-xl border p-3", isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-white")}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium">{group.files.length} identische Dateien · {formatBytes(group.size)} je</span>
                          <span className="text-amber-400 text-sm">verschwendet: {formatBytes(group.total_wasted)}</span>
                        </div>
                        <div className="space-y-1">
                          {group.files.map((f) => (
                            <label key={f} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                              <input type="checkbox" checked={selectedDupes.has(f)} onChange={() => toggleDupe(f)} className="rounded" />
                              <span className="truncate text-slate-400">{f}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  {selectedDupes.size > 0 && (
                    <button onClick={() => moveToTrash(Array.from(selectedDupes))} disabled={trashBusy} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600/20 text-red-300 border border-red-500/30 text-sm">
                      <Trash2 size={14} /> {selectedDupes.size} ausgewählte in Papierkorb
                    </button>
                  )}
                </div>
              )}
              {view === "recommendations" && (
                <div className="space-y-3 max-w-3xl">
                  {result.recommendations.length === 0 ? <p className="text-slate-500 text-sm p-4">Keine besonderen Empfehlungen.</p> :
                    result.recommendations.map((rec, i) => (
                      <div key={i} className={clsx("rounded-xl border p-4", isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-white")}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {rec.title}
                              <span className={clsx("text-[10px] px-1.5 py-0.5 rounded uppercase", rec.severity === "high" ? "bg-red-500/20 text-red-300" : rec.severity === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-slate-500/20 text-slate-400")}>{rec.severity}</span>
                            </div>
                            <p className="text-sm text-slate-400 mt-1">{rec.description}</p>
                            <p className="text-xs text-slate-500 mt-1 truncate">{rec.path}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-medium">{formatBytes(rec.size)}</div>
                            <button onClick={() => moveToTrash([rec.path])} className="mt-2 text-xs text-red-400 hover:underline">In Papierkorb</button>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {selected && (
              <aside className={clsx("w-72 border-l p-4 overflow-y-auto shrink-0", isDark ? "border-slate-800 bg-slate-900/60" : "border-slate-200 bg-white")}>
                <h2 className="font-semibold text-sm mb-3 truncate" title={selected.path}>{selected.name}</h2>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-slate-400">Größe</span><span className="font-medium">{formatBytes(selected.size)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Pfad</span></div>
                  <div className="text-xs text-slate-500 break-all">{selected.path}</div>
                  <div className="flex justify-between"><span className="text-slate-400">Typ</span><span>{selected.is_dir ? "Ordner" : "Datei"}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Kategorie</span><span className="flex items-center gap-1.5"><span className={clsx("w-2 h-2 rounded-full", CATEGORY_COLORS[selected.category] || "bg-zinc-500")} />{CATEGORY_LABELS[selected.category] || selected.category}</span></div>
                  {selected.is_program && <div className="flex justify-between text-violet-400"><span>Erkannt als</span><span>Installiertes Programm</span></div>}
                  {selected.is_dir && <div className="flex justify-between"><span className="text-slate-400">Enthaltene Dateien</span><span>{formatNumber(selected.file_count)}</span></div>}
                  <div className="flex justify-between"><span className="text-slate-400">Geändert</span><span>{formatDate(selected.modified)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Zuletzt zugegriffen</span><span>{formatDate(selected.accessed)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Wichtigkeits-Score</span><span className="tabular-nums">{selected.importance_score.toFixed(1)}</span></div>
                </div>
                <button onClick={() => moveToTrash([selected.path])} disabled={trashBusy} className="mt-6 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600/20 text-red-300 hover:bg-red-600/30 border border-red-500/30 text-sm transition-colors">
                  <Trash2 size={15} /> In Papierkorb verschieben
                </button>
                {selected.is_dir && selected.children.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Größte Unterelemente</h3>
                    <div className="space-y-1">{selected.children.slice(0, 8).map((child) => (
                      <div key={child.path} className="flex items-center justify-between text-sm py-1 cursor-pointer hover:text-indigo-400" onClick={() => setSelected(child)}>
                        <span className="truncate mr-2">{child.name}</span>
                        <span className="text-slate-400 tabular-nums shrink-0">{formatBytes(child.size)}</span>
                      </div>
                    ))}</div>
                  </div>
                )}
              </aside>
            )}
          </main>
        </div>
      )}

      {showDrivePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className={clsx("w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden", isDark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-200")}>
            <div className={clsx("flex items-center justify-between px-5 py-4 border-b", isDark ? "border-slate-700" : "border-slate-200")}>
              <div className="flex items-center gap-2">
                <HardDrive size={20} className="text-indigo-400" />
                <h2 className="font-semibold text-lg">Laufwerk auswählen</h2>
              </div>
              <button onClick={() => setShowDrivePicker(false)} className={clsx("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-slate-800 text-slate-400" : "hover:bg-slate-100 text-slate-500")}>
                <X size={18} />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className={clsx("text-sm mb-4", isDark ? "text-slate-400" : "text-slate-600")}>Wähle das Laufwerk, das vollständig gescannt werden soll.</p>
              {loadingDrives ? (
                <div className="flex items-center justify-center py-10 gap-2 text-slate-400">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">Laufwerke werden geladen…</span>
                </div>
              ) : availableDrives.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-sm">Keine Laufwerke gefunden.</div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {availableDrives.map((drive) => {
                    const isSelected = selectedDrive === drive;
                    const label = drive.length <= 3 ? `Laufwerk ${drive}` : drive;
                    return (
                      <button key={drive} onClick={() => setSelectedDrive(drive)} className={clsx(
                        "w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all",
                        isSelected ? "border-indigo-500 bg-indigo-500/15 text-indigo-100" : isDark ? "border-slate-700 hover:border-slate-600 hover:bg-slate-800/80" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                      )}>
                        <div className={clsx("w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0", isSelected ? "border-indigo-400 bg-indigo-500" : isDark ? "border-slate-600" : "border-slate-300")}>
                          {isSelected && <Check size={12} className="text-white" />}
                        </div>
                        <HardDrive size={18} className={isSelected ? "text-indigo-300" : "text-slate-400"} />
                        <span className="font-medium truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className={clsx("px-5 py-4 border-t flex flex-col gap-2", isDark ? "border-slate-700 bg-slate-900/50" : "border-slate-200 bg-slate-50")}>
              <button onClick={() => selectedDrive && startScan(selectedDrive)} disabled={!selectedDrive || scanning} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium transition-colors">
                <HardDrive size={16} />
                {selectedDrive ? `„${selectedDrive}“ scannen` : "Laufwerk auswählen"}
              </button>
              <button onClick={() => { setShowDrivePicker(false); startScan(); }} disabled={scanning} className={clsx("w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors", isDark ? "text-slate-400 hover:bg-slate-800 hover:text-slate-200" : "text-slate-600 hover:bg-slate-100")}>
                <FolderOpen size={15} /> Anderen Ordner manuell wählen…
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
