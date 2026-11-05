import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  HardDrive,
  FolderOpen,
  AlertTriangle,
  Layers,
  ListTree,
  BarChart3,
  Loader2,
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  Trash2,
  Copy,
  AppWindow,
  LayoutGrid,
} from "lucide-react";
import type {
  ScanResult,
  FileNode,
  ScanProgress,
  DuplicateGroup,
} from "./lib/types";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "./lib/types";
import { formatBytes, formatNumber, formatDate } from "./lib/format";
import Treemap from "./components/Treemap";
import clsx from "clsx";

type ViewMode =
  | "tree"
  | "treemap"
  | "categories"
  | "largest"
  | "recommendations"
  | "duplicates"
  | "programs";

function TreeItem({
  node,
  depth = 0,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  depth?: number;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div>
      <div
        className={clsx(
          "flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer text-sm hover:bg-slate-800/80 transition-colors",
          isSelected && "bg-indigo-600/30 text-indigo-100",
          node.is_program && "border-l-2 border-violet-500"
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => onSelect(node)}
      >
        {hasChildren ? (
          <button
            className="p-0.5 hover:bg-slate-700 rounded"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            {open ? (
              <ChevronDown size={14} className="text-slate-400" />
            ) : (
              <ChevronRight size={14} className="text-slate-400" />
            )}
          </button>
        ) : (
          <span className="w-[18px]" />
        )}

        {node.is_dir ? (
          <Folder size={15} className="text-amber-400 shrink-0" />
        ) : (
          <File size={15} className="text-slate-400 shrink-0" />
        )}

        <span className="truncate flex-1 min-w-0">
          {node.name}
          {node.is_program && (
            <span className="ml-1.5 text-[10px] text-violet-300 bg-violet-500/20 px-1 rounded">
              App
            </span>
          )}
        </span>
        <span className="text-xs text-slate-400 tabular-nums shrink-0">
          {formatBytes(node.size)}
        </span>
      </div>

      {open &&
        hasChildren &&
        node.children.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("tree");
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [status, setStatus] = useState("Bereit");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = listen<ScanProgress>("scan-progress", (event) => {
      setProgress(event.payload);
      const p = event.payload;
      const phaseLabel: Record<string, string> = {
        scanning: "Scanne Dateien",
        building: "Baue Baum",
        duplicates: "Suche Duplikate",
        done: "Fertig",
      };
      setStatus(
        `${phaseLabel[p.phase] || p.phase}… ${formatNumber(p.files_scanned)} Dateien · ${formatBytes(p.bytes_scanned)}`
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const startScan = useCallback(async (path?: string) => {
    setError(null);
    setScanning(true);
    setResult(null);
    setSelected(null);
    setProgress(null);
    setSelectedDupes(new Set());
    setStatus("Starte Scan…");

    try {
      let target = path;
      if (!target) {
        const selectedPath = await open({
          directory: true,
          multiple: false,
          title: "Ordner oder Laufwerk zum Scannen wählen",
        });
        if (!selectedPath) {
          setScanning(false);
          setStatus("Bereit");
          return;
        }
        target = selectedPath as string;
      }

      const data = await invoke<ScanResult>("scan_path", { path: target });
      setResult(data);
      setSelected(data.root);
      setStatus(
        `Fertig – ${formatNumber(data.total_files)} Dateien, ${formatBytes(data.total_size)}`
      );
      setView("treemap");
    } catch (e: any) {
      setError(String(e));
      setStatus("Fehler beim Scannen");
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }, []);

  const moveToTrash = async (paths: string[]) => {
    if (paths.length === 0) return;
    const confirmed = window.confirm(
      `Wirklich ${paths.length} Element(e) in den Papierkorb verschieben?\n\n${paths.slice(0, 5).join("\n")}${paths.length > 5 ? "\n…" : ""}`
    );
    if (!confirmed) return;

    setTrashBusy(true);
    try {
      await invoke("move_to_trash", { paths });
      alert("Erfolgreich in den Papierkorb verschoben.\nBitte erneut scannen, um die Ansicht zu aktualisieren.");
    } catch (e: any) {
      alert("Fehler beim Verschieben:\n" + String(e));
    } finally {
      setTrashBusy(false);
    }
  };

  const toggleDupe = (path: string) => {
    setSelectedDupes((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const categoryEntries = result
    ? Object.entries(result.category_summary).sort((a, b) => b[1] - a[1])
    : [];

  const totalWasted = result
    ? result.duplicates.reduce((s, d) => s + d.total_wasted, 0)
    : 0;

  return (
    <div className="h-screen flex flex-col bg-surface-950 text-slate-100">
      <header className="flex items-center gap-4 px-4 py-3 border-b border-slate-800 bg-surface-900/80 backdrop-blur">
        <div className="flex items-center gap-2">
          <HardDrive className="text-indigo-400" size={22} />
          <h1 className="font-semibold text-lg tracking-tight">SpaceLens</h1>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => startScan()}
          disabled={scanning}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium transition-colors"
        >
          {scanning ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
          Ordner scannen
        </button>
      </header>

      <div className="px-4 py-1.5 text-xs text-slate-400 border-b border-slate-800/60 bg-surface-900/40">
        <div className="flex items-center gap-3">
          <span className="truncate flex-1">{status}</span>
          {error && <span className="text-red-400">Fehler: {error}</span>}
        </div>
        {scanning && progress && (
          <div className="mt-1.5">
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300 animate-pulse"
                style={{ width: progress.phase === "done" ? "100%" : "60%" }}
              />
            </div>
            <div className="truncate text-[11px] text-slate-500 mt-0.5">
              {progress.current_path}
            </div>
          </div>
        )}
      </div>

      {!result && !scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 text-slate-400">
          <HardDrive size={64} className="opacity-30" />
          <div className="text-center space-y-2">
            <p className="text-lg text-slate-300">Noch kein Scan durchgeführt</p>
            <p className="text-sm max-w-md">
              Wähle einen Ordner oder ein komplettes Laufwerk. SpaceLens zeigt übersichtlich,
              was Platz verbraucht, findet Duplikate und gibt konkrete Aufräum-Empfehlungen.
            </p>
          </div>
          <button
            onClick={() => startScan()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-medium transition-colors"
          >
            <FolderOpen size={18} />
            Jetzt scannen
          </button>
        </div>
      )}

      {scanning && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Loader2 size={48} className="animate-spin text-indigo-400" />
          <p className="text-slate-300">
            {progress?.phase === "duplicates"
              ? "Suche Duplikate…"
              : progress?.phase === "building"
              ? "Verarbeite Ergebnisse…"
              : "Scanne Dateisystem…"}
          </p>
          <p className="text-sm text-slate-500 max-w-sm text-center">
            Bei sehr großen Laufwerken kann das einige Minuten dauern.
          </p>
        </div>
      )}

      {result && (
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-52 border-r border-slate-800 bg-surface-900/50 flex flex-col shrink-0">
            <nav className="p-2 space-y-0.5">
              {(
                [
                  { id: "treemap", label: "Treemap", icon: LayoutGrid },
                  { id: "tree", label: "Baumansicht", icon: ListTree },
                  { id: "categories", label: "Kategorien", icon: Layers },
                  { id: "largest", label: "Größte Elemente", icon: BarChart3 },
                  { id: "programs", label: "Programme", icon: AppWindow },
                  { id: "duplicates", label: "Duplikate", icon: Copy },
                  { id: "recommendations", label: "Empfehlungen", icon: AlertTriangle },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={clsx(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                    view === item.id
                      ? "bg-indigo-600/20 text-indigo-300"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  )}
                >
                  <item.icon size={16} />
                  {item.label}
                  {item.id === "duplicates" && result.duplicates.length > 0 && (
                    <span className="ml-auto text-[10px] bg-amber-500/20 text-amber-300 px-1.5 rounded-full">
                      {result.duplicates.length}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            <div className="mt-auto p-3 border-t border-slate-800 text-xs space-y-1.5 text-slate-400">
              <div className="flex justify-between">
                <span>Gesamt</span>
                <span className="text-slate-200 font-medium">
                  {formatBytes(result.total_size)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Dateien</span>
                <span className="text-slate-200">{formatNumber(result.total_files)}</span>
              </div>
              {totalWasted > 0 && (
                <div className="flex justify-between text-amber-400/90">
                  <span>Duplikate</span>
                  <span>{formatBytes(totalWasted)}</span>
                </div>
              )}
            </div>
          </aside>

          <main className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3">
              {view === "treemap" && (
                <Treemap
                  root={result.root}
                  onSelect={setSelected}
                  selectedPath={selected?.path}
                />
              )}

              {view === "tree" && (
                <TreeItem
                  node={result.root}
                  selectedPath={selected?.path ?? null}
                  onSelect={setSelected}
                />
              )}

              {view === "categories" && (
                <div className="space-y-2 max-w-2xl">
                  {categoryEntries.map(([cat, size]) => {
                    const pct = (size / result.total_size) * 100;
                    return (
                      <div
                        key={cat}
                        className="bg-slate-900/60 rounded-xl p-3 border border-slate-800"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <div
                              className={clsx(
                                "w-3 h-3 rounded-full",
                                CATEGORY_COLORS[cat] || "bg-zinc-500"
                              )}
                            />
                            <span className="font-medium">
                              {CATEGORY_LABELS[cat] || cat}
                            </span>
                          </div>
                          <span className="text-sm text-slate-300">
                            {formatBytes(size)}
                          </span>
                        </div>
                        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={clsx(
                              "h-full rounded-full",
                              CATEGORY_COLORS[cat] || "bg-zinc-500"
                            )}
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {pct.toFixed(1)} % des gesamten Speichers
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {view === "largest" && (
                <div className="space-y-1">
                  {result.largest_items.map((item, i) => (
                    <div
                      key={item.path}
                      onClick={() => setSelected(item)}
                      className={clsx(
                        "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-slate-800/80",
                        selected?.path === item.path && "bg-indigo-600/20"
                      )}
                    >
                      <span className="text-xs text-slate-500 w-5">{i + 1}</span>
                      {item.is_dir ? (
                        <Folder size={16} className="text-amber-400 shrink-0" />
                      ) : (
                        <File size={16} className="text-slate-400 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm">{item.name}</div>
                        <div className="text-xs text-slate-500 truncate">{item.path}</div>
                      </div>
                      <span className="text-sm tabular-nums text-slate-300">
                        {formatBytes(item.size)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {view === "programs" && (
                <div className="space-y-2">
                  {result.installed_programs.length === 0 ? (
                    <p className="text-slate-500 text-sm p-4">
                      Keine klaren Programm-Installationen erkannt. Scanne z. B. „Program Files“
                      oder „/Applications“.
                    </p>
                  ) : (
                    result.installed_programs.map((prog) => (
                      <div
                        key={prog.path}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-violet-500/40 transition-colors"
                      >
                        <AppWindow size={18} className="text-violet-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{prog.name}</div>
                          <div className="text-xs text-slate-500 truncate">{prog.path}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-medium">{formatBytes(prog.size)}</div>
                          <div className="text-xs text-slate-500">
                            {formatNumber(prog.file_count)} Dateien
                          </div>
                        </div>
                        <button
                          onClick={() => moveToTrash([prog.path])}
                          disabled={trashBusy}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="In Papierkorb"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {view === "duplicates" && (
                <div className="space-y-4">
                  {result.duplicates.length === 0 ? (
                    <p className="text-slate-500 text-sm p-4">
                      Keine nennenswerten Duplikate gefunden (gesucht werden Dateien ≥ 1 MB).
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-slate-400">
                          {result.duplicates.length} Gruppen · ca.{" "}
                          <span className="text-amber-400 font-medium">
                            {formatBytes(totalWasted)}
                          </span>{" "}
                          verschwendet
                        </p>
                        {selectedDupes.size > 0 && (
                          <button
                            onClick={() => moveToTrash(Array.from(selectedDupes))}
                            disabled={trashBusy}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-sm"
                          >
                            <Trash2 size={14} />
                            {selectedDupes.size} in Papierkorb
                          </button>
                        )}
                      </div>

                      {result.duplicates.map((group: DuplicateGroup, gi) => (
                        <div
                          key={gi}
                          className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden"
                        >
                          <div className="px-3 py-2 bg-slate-800/50 flex items-center justify-between text-sm">
                            <span>
                              {group.files.length}× identische Datei ·{" "}
                              {formatBytes(group.size)} pro Stück
                            </span>
                            <span className="text-amber-400">
                              +{formatBytes(group.total_wasted)} verschwendet
                            </span>
                          </div>
                          <div className="divide-y divide-slate-800/80">
                            {group.files.map((f, fi) => (
                              <label
                                key={fi}
                                className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-800/40 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedDupes.has(f)}
                                  onChange={() => toggleDupe(f)}
                                  className="rounded border-slate-600"
                                />
                                <span className="truncate flex-1 text-slate-300">{f}</span>
                                {fi === 0 && (
                                  <span className="text-[10px] text-slate-500 shrink-0">
                                    Original behalten?
                                  </span>
                                )}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {view === "recommendations" && (
                <div className="space-y-3 max-w-2xl">
                  {result.recommendations.length === 0 ? (
                    <p className="text-slate-500 text-sm p-4">
                      Keine besonderen Empfehlungen – sieht relativ aufgeräumt aus.
                    </p>
                  ) : (
                    result.recommendations.map((rec, i) => (
                      <div
                        key={i}
                        className="bg-slate-900/60 border border-slate-800 rounded-xl p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span
                                className={clsx(
                                  "text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded",
                                  rec.severity === "high"
                                    ? "bg-red-500/20 text-red-300"
                                    : rec.severity === "medium"
                                    ? "bg-amber-500/20 text-amber-300"
                                    : "bg-slate-500/20 text-slate-300"
                                )}
                              >
                                {rec.severity}
                              </span>
                              <h3 className="font-medium">{rec.title}</h3>
                            </div>
                            <p className="text-sm text-slate-400">{rec.description}</p>
                            <p className="text-xs text-slate-500 mt-1 truncate">{rec.path}</p>
                          </div>
                          <div className="flex flex-col items-end gap-2 shrink-0">
                            <span className="text-sm font-medium text-slate-200">
                              {formatBytes(rec.size)}
                            </span>
                            <button
                              onClick={() => moveToTrash([rec.path])}
                              disabled={trashBusy}
                              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10"
                            >
                              <Trash2 size={12} />
                              Papierkorb
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {selected && view !== "duplicates" && (
              <aside className="w-80 border-l border-slate-800 bg-surface-900/40 p-4 overflow-y-auto shrink-0">
                <h2 className="font-semibold text-lg mb-1 truncate">{selected.name}</h2>
                <p className="text-xs text-slate-500 break-all mb-4">{selected.path}</p>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Größe</span>
                    <span className="font-medium">{formatBytes(selected.size)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Typ</span>
                    <span>{selected.is_dir ? "Ordner" : "Datei"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Kategorie</span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={clsx(
                          "w-2 h-2 rounded-full",
                          CATEGORY_COLORS[selected.category] || "bg-zinc-500"
                        )}
                      />
                      {CATEGORY_LABELS[selected.category] || selected.category}
                    </span>
                  </div>
                  {selected.is_program && (
                    <div className="flex justify-between text-violet-300">
                      <span>Erkannt als</span>
                      <span>Installiertes Programm</span>
                    </div>
                  )}
                  {selected.is_dir && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Enthaltene Dateien</span>
                      <span>{formatNumber(selected.file_count)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-400">Geändert</span>
                    <span>{formatDate(selected.modified)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Zuletzt zugegriffen</span>
                    <span>{formatDate(selected.accessed)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Wichtigkeits-Score</span>
                    <span className="tabular-nums">
                      {selected.importance_score.toFixed(1)}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => moveToTrash([selected.path])}
                  disabled={trashBusy}
                  className="mt-6 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600/20 text-red-300 hover:bg-red-600/30 border border-red-500/30 text-sm transition-colors"
                >
                  <Trash2 size={15} />
                  In Papierkorb verschieben
                </button>

                {selected.is_dir && selected.children.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                      Größte Unterelemente
                    </h3>
                    <div className="space-y-1">
                      {selected.children.slice(0, 8).map((child) => (
                        <div
                          key={child.path}
                          className="flex items-center justify-between text-sm py-1 cursor-pointer hover:text-indigo-300"
                          onClick={() => setSelected(child)}
                        >
                          <span className="truncate mr-2">{child.name}</span>
                          <span className="text-slate-400 tabular-nums shrink-0">
                            {formatBytes(child.size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </aside>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
