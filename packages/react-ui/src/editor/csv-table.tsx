import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type MouseEvent } from "react";

/** Controls exposed to the workspace Find command and focus restoration. */
export interface CsvTableHandle {
  focus(): void;
  findNext(query: string): "found" | "wrapped" | "missing";
}

interface CsvTableProps {
  rows: string[][];
  ref?: React.Ref<CsvTableHandle>;
  onFind(): void;
}

const rowHeight = 36;
const overscan = 4;

/** Presents CSV headings and values as one keyboard-navigable, read-only table. */
export function CsvTable({ rows, ref, onFind }: CsvTableProps): React.ReactElement {
  const scroll = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const [position, setPosition] = useState({ row: 0, column: 0 });
  const [firstVisibleRow, setFirstVisibleRow] = useState(1);
  const [visibleRows, setVisibleRows] = useState(20);
  const columns = rows[0].length;
  const row = Math.min(position.row, rows.length - 1);
  const column = Math.min(position.column, columns - 1);
  const windowStart = Math.max(1, firstVisibleRow - overscan);
  const windowEnd = Math.min(rows.length,
    firstVisibleRow + visibleRows + overscan);

  useLayoutEffect(() => {
    if (!focusPending.current) return;
    const target = cellAt(row, column);
    if (!target) return;
    target.focus();
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    focusPending.current = false;
  });

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setVisibleRows(Math.max(1,
      Math.ceil((element.clientHeight || rowHeight * 20) / rowHeight)));
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
  }, []);

  function cellAt(nextRow: number, nextColumn: number): HTMLTableCellElement | null {
    return scroll.current?.querySelector<HTMLTableCellElement>(
      `[data-row="${nextRow}"][data-column="${nextColumn}"]`) ?? null;
  }

  function move(nextRow: number, nextColumn: number): void {
    const targetRow = Math.max(0, Math.min(rows.length - 1, nextRow));
    const targetColumn = Math.max(0, Math.min(columns - 1, nextColumn));
    focusPending.current = true;
    if (targetRow < windowStart || targetRow >= windowEnd) {
      const start = Math.max(1, targetRow - Math.floor(visibleRows / 2));
      setFirstVisibleRow(start);
      if (scroll.current) scroll.current.scrollTop = Math.max(0, (start - 1) * rowHeight);
    }
    setPosition({ row: targetRow, column: targetColumn });
  }

  function findNext(query: string): "found" | "wrapped" | "missing" {
    const needle = query.toLocaleLowerCase();
    const size = rows.length * columns;
    const current = row * columns + column;
    for (let offset = 1; offset <= size; offset += 1) {
      const index = (current + offset) % size;
      const nextRow = Math.floor(index / columns);
      const nextColumn = index % columns;
      if (rows[nextRow][nextColumn].toLocaleLowerCase().includes(needle)) {
        move(nextRow, nextColumn);
        return index <= current ? "wrapped" : "found";
      }
    }
    return "missing";
  }

  useImperativeHandle(ref, () => ({
    focus: () => move(row, column), findNext,
  }));

  function pageRows(): number {
    return Math.max(1, Math.floor(((scroll.current?.clientHeight || rowHeight * 2)
      - rowHeight) / rowHeight));
  }

  function keyDown(event: KeyboardEvent<HTMLTableCellElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); onFind(); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case "ArrowUp": nextRow -= 1; break;
      case "ArrowDown": nextRow += 1; break;
      case "ArrowLeft": nextColumn -= 1; break;
      case "ArrowRight": nextColumn += 1; break;
      case "PageUp": nextRow -= pageRows(); break;
      case "PageDown": nextRow += pageRows(); break;
      case "Tab": {
        const index = row * columns + column + (event.shiftKey ? -1 : 1);
        nextRow = Math.floor(Math.max(0, Math.min(rows.length * columns - 1, index)) / columns);
        nextColumn = Math.max(0, Math.min(rows.length * columns - 1, index)) % columns;
        break;
      }
      default: return;
    }
    event.preventDefault();
    move(nextRow, nextColumn);
  }

  function copy(event: React.ClipboardEvent<HTMLTableCellElement>): void {
    const copyRow = Number(event.currentTarget.dataset.row);
    const copyColumn = Number(event.currentTarget.dataset.column);
    event.clipboardData.setData("text/plain", rows[copyRow][copyColumn]);
    event.preventDefault();
  }

  function click(event: MouseEvent<HTMLTableCellElement>, nextRow: number,
    nextColumn: number): void {
    event.currentTarget.focus();
    move(nextRow, nextColumn);
  }

  return <div className="csv-table-workspace">
    <div ref={scroll} className="csv-table-scroll"
      onScroll={(event) => setFirstVisibleRow(Math.max(1,
        Math.floor(event.currentTarget.scrollTop / rowHeight) + 1))}>
      <table className="csv-table" aria-label="CSV table view" aria-rowcount={rows.length + 1}
        style={{ width: `max(100%, ${columns * 12}rem)` }}>
        <thead><tr aria-rowindex={1}>
        {rows[0].map((heading, index) => <th scope="col" key={index}
          data-row="0" data-column={index} tabIndex={row === 0 && column === index ? 0 : -1}
          onClick={(event) => click(event, 0, index)} onKeyDown={keyDown} onCopy={copy}>
          <span className="csv-cell-preview">{heading}</span></th>)}
      </tr></thead><tbody>
        {windowStart > 1 && <tr className="csv-spacer-row" aria-hidden="true">
          <td colSpan={columns} style={{ height: (windowStart - 1) * rowHeight }} /></tr>}
        {rows.slice(windowStart, windowEnd).map((values, index) => {
          const rowIndex = windowStart + index;
          return <tr key={rowIndex} aria-rowindex={rowIndex + 1}>
          {values.map((value, columnIndex) => <td key={columnIndex}
            data-row={rowIndex} data-column={columnIndex}
            tabIndex={row === rowIndex && column === columnIndex ? 0 : -1}
            onClick={(event) => click(event, rowIndex, columnIndex)}
            onKeyDown={keyDown} onCopy={copy}>
            <span className="csv-cell-preview">{value}</span></td>)}
          </tr>;
        })}
        {windowEnd < rows.length && <tr className="csv-spacer-row" aria-hidden="true">
          <td colSpan={columns} style={{ height: (rows.length - windowEnd) * rowHeight }} />
        </tr>}
        <tr className="csv-insertion-placeholder" aria-label="Insertion placeholder"
          aria-rowindex={rows.length + 1}>
          <td colSpan={columns}>+ New row</td>
        </tr>
      </tbody></table>
    </div>
    <div className="csv-focused-value" aria-live="polite">
      <span>Focused value (row {row === 0 ? "heading" : row}, column {column + 1})</span>
      <pre>{rows[row][column]}</pre>
    </div>
  </div>;
}
