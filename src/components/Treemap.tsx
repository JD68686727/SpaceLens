import { useMemo, useState, useEffect, useRef } from "react";
import type { FileNode } from "../lib/types";
import { CATEGORY_HEX } from "../lib/types";
import { formatBytes } from "../lib/format";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: FileNode;
  depth: number;
}

function squarify(
  nodes: FileNode[],
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  maxDepth: number
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
      if (row.length >= 12) break;
    }

    const rowH = Math.max((rowSize / total) * h, 3);
    let cx = x;
    for (const node of row) {
      const nw = (node.size / rowSize) * w;
      const pad = 1;
      const rx = cx + pad;
      const ry = cy + pad;
      const rw = Math.max(nw - pad * 2, 1);
      const rh = Math.max(rowH - pad * 2, 1);

      if (
        depth < maxDepth &&
        node.is_dir &&
        node.children.length > 0 &&
        rw > 40 &&
        rh > 40
      ) {
        const kids = node.children.filter((c) => c.size > 0).slice(0, 20);
        if (kids.length > 0) {
          result.push(...squarify(kids, rx, ry, rw, rh, depth + 1, maxDepth));
        } else {
          result.push({ x: rx, y: ry, w: rw, h: rh, node, depth });
        }
      } else {
        result.push({ x: rx, y: ry, w: rw, h: rh, node, depth });
      }
      cx += nw;
    }
    cy += rowH;
    availableH -= rowH;
  }
  return result;
}

interface Props {
  root: FileNode;
  onSelect: (node: FileNode) => void;
  selectedPath?: string | null;
}

export default function Treemap({ root, onSelect, selectedPath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const [pathStack, setPathStack] = useState<FileNode[]>([root]);

  useEffect(() => {
    setPathStack([root]);
  }, [root.path]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr && cr.width > 0 && cr.height > 0) {
        setSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const current = pathStack[pathStack.length - 1];

  const rects = useMemo(() => {
    const children =
      current.children.length > 0
        ? current.children.filter((c) => c.size > 0)
        : [current];
    return squarify(children, 0, 0, size.w, size.h, 0, 1);
  }, [current, size.w, size.h]);

  const drillDown = (node: FileNode) => {
    if (node.is_dir && node.children.length > 0) {
      setPathStack((s) => [...s, node]);
    }
    onSelect(node);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-1 flex-wrap shrink-0">
        {pathStack.map((n, i) => (
          <span key={n.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-600">/</span>}
            <button
              className="hover:text-sky-400 truncate max-w-[160px]"
              onClick={() => setPathStack((s) => s.slice(0, i + 1))}
            >
              {n.name || "Root"}
            </button>
          </span>
        ))}
        {pathStack.length > 1 && (
          <button
            onClick={() => setPathStack((s) => s.slice(0, -1))}
            className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-white/5 hover:bg-white/10"
          >
            ↑ Hoch
          </button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 w-full">
        <svg width={size.w} height={size.h} className="block">
          {rects.map((r) => {
            const color = CATEGORY_HEX[r.node.category] || CATEGORY_HEX.Other;
            const isSelected = selectedPath === r.node.path;
            const showLabel = r.w > 50 && r.h > 28;

            return (
              <g
                key={`${r.node.path}-${r.depth}-${r.x}-${r.y}`}
                className="cursor-pointer"
                onClick={() => drillDown(r.node)}
              >
                <rect
                  x={r.x}
                  y={r.y}
                  width={Math.max(r.w, 0)}
                  height={Math.max(r.h, 0)}
                  fill={color}
                  opacity={isSelected ? 1 : r.depth === 0 ? 0.9 : 0.75}
                  stroke={isSelected ? "#fff" : "#1a1a1a"}
                  strokeWidth={isSelected ? 2 : 1}
                />
                {showLabel && (
                  <>
                    <text
                      x={r.x + 4}
                      y={r.y + 14}
                      fill="#fff"
                      fontSize={11}
                      fontWeight={600}
                      className="pointer-events-none"
                    >
                      {r.node.name.length > 18
                        ? r.node.name.slice(0, 16) + "…"
                        : r.node.name}
                    </text>
                    <text
                      x={r.x + 4}
                      y={r.y + 26}
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
    </div>
  );
}
