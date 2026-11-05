import { useMemo, useState } from "react";
import type { FileNode } from "../lib/types";
import { CATEGORY_HEX } from "../lib/types";
import { formatBytes } from "../lib/format";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: FileNode;
}

/** Simple squarified treemap layout */
function squarify(
  nodes: FileNode[],
  x: number,
  y: number,
  w: number,
  h: number
): Rect[] {
  if (nodes.length === 0 || w <= 0 || h <= 0) return [];

  const total = nodes.reduce((s, n) => s + n.size, 0);
  if (total === 0) return [];

  const sorted = [...nodes].sort((a, b) => b.size - a.size);
  const result: Rect[] = [];

  let remaining = [...sorted];
  let cy = y;
  let availableH = h;

  while (remaining.length > 0 && availableH > 2) {
    const row: FileNode[] = [];
    let rowSize = 0;

    while (remaining.length > 0) {
      const next = remaining[0];
      const newRowSize = rowSize + next.size;
      const rowH = (newRowSize / total) * h;
      const avgW = w / (row.length + 1);

      if (row.length > 0 && avgW / rowH < 0.4 && row.length >= 2) break;

      row.push(remaining.shift()!);
      rowSize = newRowSize;

      if (row.length >= 8) break;
    }

    const rowH = Math.max((rowSize / total) * h, 4);
    let cx = x;

    for (const node of row) {
      const nw = (node.size / rowSize) * w;
      result.push({ x: cx, y: cy, w: Math.max(nw, 1), h: rowH, node });
      cx += nw;
    }

    cy += rowH;
    availableH -= rowH;
  }

  return result;
}

interface Props {
  root: FileNode;
  width?: number;
  height?: number;
  onSelect: (node: FileNode) => void;
  selectedPath?: string | null;
}

export default function Treemap({
  root,
  width = 800,
  height = 500,
  onSelect,
  selectedPath,
}: Props) {
  const [pathStack, setPathStack] = useState<FileNode[]>([root]);
  const current = pathStack[pathStack.length - 1];

  const rects = useMemo(() => {
    const children =
      current.children.length > 0
        ? current.children.filter((c) => c.size > 0)
        : [current];
    return squarify(children, 0, 0, width, height);
  }, [current, width, height]);

  const drillDown = (node: FileNode) => {
    if (node.is_dir && node.children.length > 0) {
      setPathStack((s) => [...s, node]);
    }
    onSelect(node);
  };

  const goUp = () => {
    if (pathStack.length > 1) {
      setPathStack((s) => s.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 text-xs text-slate-400 mb-2 flex-wrap">
        {pathStack.map((n, i) => (
          <span key={n.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-600">/</span>}
            <button
              className="hover:text-indigo-300 truncate max-w-[140px]"
              onClick={() => setPathStack((s) => s.slice(0, i + 1))}
            >
              {n.name || "Root"}
            </button>
          </span>
        ))}
        {pathStack.length > 1 && (
          <button
            onClick={goUp}
            className="ml-2 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            ↑ Hoch
          </button>
        )}
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="rounded-lg border border-slate-800 bg-slate-900/50"
        style={{ maxHeight: height }}
      >
        {rects.map((r) => {
          const color = CATEGORY_HEX[r.node.category] || CATEGORY_HEX.Other;
          const isSelected = selectedPath === r.node.path;
          const showLabel = r.w > 50 && r.h > 28;

          return (
            <g
              key={r.node.path}
              className="cursor-pointer"
              onClick={() => drillDown(r.node)}
            >
              <rect
                x={r.x + 1}
                y={r.y + 1}
                width={Math.max(r.w - 2, 0)}
                height={Math.max(r.h - 2, 0)}
                fill={color}
                opacity={isSelected ? 1 : 0.82}
                stroke={isSelected ? "#fff" : "#0f172a"}
                strokeWidth={isSelected ? 2 : 1}
                rx={3}
              />
              {showLabel && (
                <>
                  <text
                    x={r.x + 6}
                    y={r.y + 16}
                    fill="#fff"
                    fontSize={11}
                    fontWeight={600}
                    className="pointer-events-none"
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.6)" }}
                  >
                    {r.node.name.length > 18
                      ? r.node.name.slice(0, 16) + "…"
                      : r.node.name}
                  </text>
                  <text
                    x={r.x + 6}
                    y={r.y + 30}
                    fill="rgba(255,255,255,0.85)"
                    fontSize={10}
                    className="pointer-events-none"
                  >
                    {formatBytes(r.node.size)}
                  </text>
                </>
              )}
              <title>
                {r.node.name} — {formatBytes(r.node.size)}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
