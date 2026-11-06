import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  HardDrive, FolderOpen, Loader2, ChevronRight, ChevronDown,
  File, Folder, Trash2, AppWindow, Sun, Moon, X, Check,
} from "lucide-react";
import type { ScanResult, FileNode, ScanProgress, AppError } from "./lib/types";
import { CATEGORY_LABELS, CATEGORY_HEX, parseAppError } from "./lib/types";
import { formatBytes, formatNumber } from "./lib/format";
import Treemap from "./components/Treemap";
import clsx from "clsx";

type Panel = "main" | "duplicates" | "recommendations" | "programs";
type Theme = "dark" | "light";

interface AppSettings {
  theme: Theme;
  lastPath: string | null;
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
      };
    }
  } catch {}
  return { theme: "dark", lastPath: null };
}

function saveSettings(s: AppSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function TreeRow({
  node, depth, selectedPath, totalSize, onSelect,
}: {
  node: FileNode; depth: number; selectedPath: string | null; totalSize: number; onSelect: (n: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;
  const pct = totalSize > 0 ? (node.size / totalSize) * 100 : 0;

  return (
    <div>
      <div
        className={clsx(
          "grid grid-cols-[1fr_52px_72px_64px] gap-1 items-center px-1.5 py-0.5 text-[12px] cursor-pointer select-none",
          isSelected ? "bg-[#3b5bdb]/35 text-white" : "hover:bg-white/5"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => onSelect(node)}
      >
        <div className="flex items-center gap-1 min-w-0">
          {hasChildren ? (
            <button
              className="p-0.5 shrink-0 opacity-70 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {node.is_dir
            ? <Folder size={13} className="text-amber-400/90 shrink-0" />
            : <File size={13} className="text-slate-400 shrink-0" />}
          <span className="truncate">{node.name || node.path}</span>
        </div>
        <span className="tabular-nums text-right text-slate-400">{pct.toFixed(1)}%</span>
        <div className="flex items-center gap-1">
          <div className="flex-1 h-1.5 rounded-sm bg-black/30 overflow-hidden">
            <div className="h-full bg-sky-500/80" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </div>
        <span className="tabular-nums text-right text-slate-300">{formatBytes(node.size)}</span>
      </div>
      {open && hasChildren && node.children.map((c) => (
        <TreeRow key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} totalSize={totalSize} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [panel, setPanel] = useState<Panel>("main");
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [status, setStatus] = useState("Bereit");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set());
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [availableDrives, setAvailableDrives] = useState<string[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  const [loadingDrives, setLoadingDrives] = useState(false);

  const isDark = settings.theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
    document.body.style.backgroundColor = isDark ? "#1a1a1a" : "#f3f3f3";
    document.body.style.color = isDark ? "#e5e5e5" : "#1a1a1a";
  }, [isDark]);

  useEffect(() => { saveSettings(settings); }, [settings]);

  useEffect(() => {
    const unlisten = listen<ScanProgress>("scan-progress", (event) => {
      setProgress(event.payload);
      const p = event.payload;
      const phaseLabel: Record<string, string> = {
        scanning: "Scanne", building: "Baue Baum", duplicates: "Duplikate", done: "Fertig",
      };
      setStatus(`${phaseLabel[p.phase] || p.phase} · ${formatNumber(p.files_scanned)} Dateien · ${formatBytes(p.bytes_scanned)}`);
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
    setError(null); setShowDrivePicker(false);
    setScanning(true); setResult(null); setSelected(null); setProgress(null);
    setSelectedDupes(new Set()); setPanel("main"); setStatus("Starte Scan…");
    try {
      let target = path;
      if (!target) {
        const selectedPath = await open({ directory: true, multiple: false, title: "Ordner oder Laufwerk wählen" });
        if (!selectedPath) { setScanning(false); setStatus("Bereit"); return; }
        target = selectedPath as string;
      }
      const data = await invoke<ScanResult>("scan_path", { path: target });
      setResult(data);
      setSelected(data.root);
      setStatus(`${formatBytes(data.total_size)} · ${formatNumber(data.total_files)} Dateien`);
      setSettings((s) => ({ ...s, lastPath: target as string }));
    } catch (e: any) {
      const appErr = parseAppError(e);
      if (appErr.code === "SCAN_CANCELLED") {
        setStatus("Scan abgebrochen");
        setError(null);
      } else {
        setError(appErr);
        setStatus("Fehler");
      }
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }, []);

  const moveToTrash = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!window.confirm(`Wirklich ${paths.length} Element(e) in den Papierkorb?\n\n${paths.slice(0, 4).join("\n")}${paths.length > 4 ? "\n…" : ""}`)) return;
    setTrashBusy(true);
    try {
      await invoke("move_to_trash", { paths });
      alert("In den Papierkorb verschoben. Bitte erneut scannen.");
    } catch (e: any) {
      const appErr = parseAppError(e);
      alert(appErr.message);
    } finally {
      setTrashBusy(false);
    }
  };

  const exportResults = () => {
    if (!result) return;
    const payload = {
      exported_at: new Date().toISOString(),
      total_size: result.total_size,
      total_files: result.total_files,
      category_summary: result.category_summary,
      largest_items: result.largest_items.map((i) => ({ name: i.name, path: i.path, size: i.size, category: i.category })),
      duplicates: result.duplicates,
      installed_programs: result.installed_programs,
      recommendations: result.recommendations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spacelens-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const categoryEntries = useMemo(() => {
    if (!result) return [];
    return Object.entries(result.category_summary).sort((a, b) => b[1] - a[1]);
  }, [result]);

  const totalWasted = result ? result.duplicates.reduce((s, d) => s + d.total_wasted, 0) : 0;
  const cleanable = result ? result.recommendations.reduce((s, r) => s + r.size, 0) : 0;

  const bg = isDark ? "bg-[#1a1a1a] text-[#e5e5e5]" : "bg-[#f3f3f3] text-[#1a1a1a]";
  const panelBg = isDark ? "bg-[#242424]" : "bg-white";
  const border = isDark ? "border-[#333]" : "border-[#ddd]";
  const muted = isDark ? "text-[#999]" : "text-[#666]";

  return (
    <div className={clsx("h-screen flex flex-col text-[13px]", bg)}>
      <header className={clsx("flex items-center gap-1 px-2 py-1.5 border-b shrink-0", border, panelBg)}>
        <span className="font-semibold text-sm mr-3 pl-1">SpaceLens</span>
        <button
          onClick={openDrivePicker}
          disabled={scanning}
          className="px-2.5 py-1 rounded text-[12px] bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white"
        >
          {scanning ? "Scan läuft…" : "Scannen"}
        </button>
        {settings.lastPath && !scanning && (
          <button onClick={() => startScan(settings.lastPath!)} className={clsx("px-2 py-1 rounded text-[12px] hover:bg-white/10", muted)}>
            Erneut
          </button>
        )}
        <button onClick={exportResults} disabled={!result} className={clsx("px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-30", muted)}>
          Export
        </button>
        <button
          onClick={() => setPanel(panel === "recommendations" ? "main" : "recommendations")}
          disabled={!result}
          className={clsx("px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-30", panel === "recommendations" && "bg-white/10", muted)}
        >
          Aufräumen{result && result.recommendations.length > 0 ? ` (${result.recommendations.length})` : ""}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setSettings((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }))}
          className={clsx("p-1.5 rounded hover:bg-white/10", muted)}
          title="Theme"
        >
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </header>

      <div className={clsx("px-3 py-1 text-[11px] border-b flex items-center gap-3 shrink-0", border, muted)}>
        <span className="truncate flex-1">{status}</span>
        {result && totalWasted > 0 && (
          <span className="text-amber-500/90">Duplikate: {formatBytes(totalWasted)}</span>
        )}
        {result && cleanable > 0 && (
          <span className="text-emerald-500/90">Aufräumbar: ~{formatBytes(cleanable)}</span>
        )}
        {error && <span className="text-red-400">[{error.code}] {error.message}</span>}
      </div>

      {scanning && progress && (
        <div className={clsx("px-3 py-1.5 border-b shrink-0", border)}>
          <div className={clsx("h-1 rounded-full overflow-hidden", isDark ? "bg-[#333]" : "bg-[#ddd]")}>
            <div
              className="h-full bg-sky-500 transition-all duration-500"
              style={{
                width: progress.phase === "done" ? "100%" :
                  progress.phase === "duplicates" ? "90%" :
                  progress.phase === "building" ? "75%" : "40%",
              }}
            />
          </div>
          <div className={clsx("text-[10px] mt-0.5 truncate", muted)}>{progress.current_path}</div>
          <button
            onClick={async () => { try { await invoke("cancel_scan"); } catch {} setStatus("Wird abgebrochen…"); }}
            className="text-[11px] text-sky-400 hover:underline mt-0.5"
          >
            Abbrechen
          </button>
        </div>
      )}

      {!result && !scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 opacity-60">
          <HardDrive size={48} strokeWidth={1.2} />
          <p className="text-sm">Noch kein Scan – wähle ein Laufwerk</p>
          <button onClick={openDrivePicker} className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm">
            Laufwerk scannen
          </button>
        </div>
      )}

      {scanning && !result && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Loader2 size={32} className="animate-spin text-sky-500" />
          <p className="text-sm">
            {progress?.phase === "duplicates" ? "Suche Duplikate…" :
             progress?.phase === "building" ? "Verarbeite…" : "Scanne Dateisystem…"}
          </p>
        </div>
      )}

      {result && panel === "main" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className={clsx("flex border-b shrink-0", border)} style={{ height: "38%" }}>
            <div className={clsx("flex-1 overflow-auto border-r min-w-0", border, panelBg)}>
              <div className={clsx(
                "grid grid-cols-[1fr_52px_72px_64px] gap-1 px-1.5 py-1 text-[10px] uppercase tracking-wide sticky top-0 z-10 border-b",
                border, panelBg, muted
              )}>
                <span className="pl-5">Name</span>
                <span className="text-right">%</span>
                <span className="text-center"> </span>
                <span className="text-right">Größe</span>
              </div>
              <TreeRow
                node={result.root}
                depth={0}
                selectedPath={selected?.path ?? null}
                totalSize={result.total_size}
                onSelect={setSelected}
              />
            </div>

            <div className={clsx("w-64 overflow-auto shrink-0", panelBg)}>
              <div className={clsx("px-2 py-1 text-[10px] uppercase tracking-wide sticky top-0 border-b", border, panelBg, muted)}>
                Kategorie
              </div>
              {categoryEntries.map(([cat, size]) => {
                const pct = result.total_size > 0 ? (size / result.total_size) * 100 : 0;
                const hex = CATEGORY_HEX[cat] || CATEGORY_HEX.Other;
                return (
                  <div key={cat} className="grid grid-cols-[1fr_64px_40px] gap-1 items-center px-2 py-1 text-[12px] hover:bg-white/5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: hex }} />
                      <span className="truncate">{CATEGORY_LABELS[cat] || cat}</span>
                    </div>
                    <span className="tabular-nums text-right text-slate-400">{formatBytes(size)}</span>
                    <span className="tabular-nums text-right text-slate-500">{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
              <div className={clsx("grid grid-cols-[1fr_64px_40px] gap-1 px-2 py-1.5 text-[12px] font-medium border-t", border)}>
                <span>Gesamt</span>
                <span className="tabular-nums text-right">{formatBytes(result.total_size)}</span>
                <span className="tabular-nums text-right">100%</span>
              </div>
            </div>
          </div>

          <div className={clsx("flex-1 min-h-0 p-1", panelBg)}>
            <Treemap
              root={selected && selected.is_dir && selected.children.length > 0 ? selected : result.root}
              height={400}
              onSelect={setSelected}
              selectedPath={selected?.path}
            />
          </div>

          <div className={clsx("flex items-center gap-0 border-t text-[12px] shrink-0", border, panelBg)}>
            <button className="px-3 py-1.5 bg-sky-600/20 text-sky-300 border-b-2 border-sky-500">Übersicht</button>
            <button onClick={() => setPanel("programs")} className={clsx("px-3 py-1.5 hover:bg-white/5", muted)}>
              Programme{result.installed_programs.length > 0 ? ` (${result.installed_programs.length})` : ""}
            </button>
            <button onClick={() => setPanel("duplicates")} className={clsx("px-3 py-1.5 hover:bg-white/5", muted)}>
              Duplikate{result.duplicates.length > 0 ? ` (${result.duplicates.length})` : ""}
            </button>
            <button onClick={() => setPanel("recommendations")} className={clsx("px-3 py-1.5 hover:bg-white/5", muted)}>
              Empfehlungen{result.recommendations.length > 0 ? ` (${result.recommendations.length})` : ""}
            </button>
            <div className="flex-1" />
            {selected && (
              <div className={clsx("px-3 py-1 text-[11px] truncate max-w-md", muted)}>
                {selected.path} · {formatBytes(selected.size)}
                {selected.is_dir ? ` · ${formatNumber(selected.file_count)} Dateien` : ""}
              </div>
            )}
            {selected && (
              <button
                onClick={() => moveToTrash([selected.path])}
                disabled={trashBusy}
                className="px-2 py-1 mr-1 text-red-400 hover:bg-red-500/10 rounded text-[11px]"
              >
                <Trash2 size={12} className="inline mr-1" />Papierkorb
              </button>
            )}
          </div>
        </div>
      )}

      {result && panel === "duplicates" && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setPanel("main")} className="text-sky-400 hover:underline text-[12px]">← Übersicht</button>
            <h2 className="font-medium">Duplikate</h2>
            <span className={muted}>{formatBytes(totalWasted)} verschwendet</span>
          </div>
          {result.duplicates.length === 0 ? (
            <p className={muted}>Keine Duplikate gefunden.</p>
          ) : (
            <div className="space-y-3 max-w-3xl">
              {result.duplicates.map((g) => (
                <div key={g.hash} className={clsx("border rounded p-2", border, panelBg)}>
                  <div className="flex justify-between text-[12px] mb-1">
                    <span>{g.files.length}× · {formatBytes(g.size)} je</span>
                    <span className="text-amber-500">−{formatBytes(g.total_wasted)}</span>
                  </div>
                  {g.files.map((f) => (
                    <label key={f} className="flex items-center gap-2 text-[11px] py-0.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedDupes.has(f)}
                        onChange={() => setSelectedDupes((prev) => {
                          const n = new Set(prev);
                          if (n.has(f)) n.delete(f); else n.add(f);
                          return n;
                        })}
                      />
                      <span className="truncate text-slate-400">{f}</span>
                    </label>
                  ))}
                </div>
              ))}
              {selectedDupes.size > 0 && (
                <button
                  onClick={() => moveToTrash(Array.from(selectedDupes))}
                  className="px-3 py-1.5 rounded bg-red-600/20 text-red-300 text-[12px]"
                >
                  {selectedDupes.size} in Papierkorb
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {result && panel === "recommendations" && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setPanel("main")} className="text-sky-400 hover:underline text-[12px]">← Übersicht</button>
            <h2 className="font-medium">Empfehlungen</h2>
          </div>
          {result.recommendations.length === 0 ? (
            <p className={muted}>Keine Empfehlungen.</p>
          ) : (
            <div className="space-y-2 max-w-3xl">
              {result.recommendations.map((r, i) => (
                <div key={i} className={clsx("border rounded p-3 flex justify-between gap-3", border, panelBg)}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {r.title}
                      <span className={clsx(
                        "text-[10px] px-1 rounded",
                        r.severity === "high" ? "bg-red-500/20 text-red-300" :
                        r.severity === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-slate-500/20"
                      )}>{r.severity}</span>
                    </div>
                    <p className={clsx("text-[12px] mt-0.5", muted)}>{r.description}</p>
                    <p className="text-[11px] text-slate-500 truncate mt-0.5">{r.path}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular-nums">{formatBytes(r.size)}</div>
                    <button onClick={() => moveToTrash([r.path])} className="text-[11px] text-red-400 hover:underline mt-1">
                      Papierkorb
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result && panel === "programs" && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setPanel("main")} className="text-sky-400 hover:underline text-[12px]">← Übersicht</button>
            <h2 className="font-medium">Programme</h2>
          </div>
          <div className="space-y-0.5 max-w-3xl">
            {result.installed_programs.map((p) => (
              <div key={p.path} className={clsx("flex items-center gap-3 px-2 py-1.5 rounded text-[12px] hover:bg-white/5")}>
                <AppWindow size={14} className="text-violet-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-[11px] text-slate-500">{p.path}</div>
                </div>
                <span className={clsx("text-[11px]", muted)}>{formatNumber(p.file_count)}</span>
                <span className="tabular-nums w-16 text-right">{formatBytes(p.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showDrivePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className={clsx("w-full max-w-sm rounded-lg border shadow-xl overflow-hidden", border, panelBg)}>
            <div className={clsx("flex items-center justify-between px-4 py-3 border-b", border)}>
              <span className="font-medium">Laufwerk wählen</span>
              <button onClick={() => setShowDrivePicker(false)} className="p-1 hover:bg-white/10 rounded"><X size={16} /></button>
            </div>
            <div className="p-3">
              {loadingDrives ? (
                <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={20} /></div>
              ) : (
                <div className="space-y-1 max-h-56 overflow-y-auto">
                  {availableDrives.map((d) => (
                    <button
                      key={d}
                      onClick={() => setSelectedDrive(d)}
                      className={clsx(
                        "w-full flex items-center gap-2 px-3 py-2 rounded text-left text-[13px]",
                        selectedDrive === d ? "bg-sky-600/25 border border-sky-500/50" : "hover:bg-white/5 border border-transparent"
                      )}
                    >
                      <HardDrive size={16} className="text-sky-400" />
                      {d}
                      {selectedDrive === d && <Check size={14} className="ml-auto text-sky-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className={clsx("px-3 py-3 border-t flex flex-col gap-1.5", border)}>
              <button
                onClick={() => selectedDrive && startScan(selectedDrive)}
                disabled={!selectedDrive}
                className="w-full py-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-[13px]"
              >
                {selectedDrive ? `${selectedDrive} scannen` : "Laufwerk wählen"}
              </button>
              <button
                onClick={() => { setShowDrivePicker(false); startScan(); }}
                className={clsx("w-full py-1.5 text-[12px] hover:bg-white/5 rounded", muted)}
              >
                <FolderOpen size={13} className="inline mr-1" />Anderen Ordner…
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
