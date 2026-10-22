import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type MouseEvent } from "react";
import type { CsvStructureCommand } from "../shell/shell-commands.ts";

/** Controls exposed to the workspace Find command and focus restoration. */
export interface CsvTableHandle {
  focus(): void;
  findNext(query: string): "found" | "wrapped" | "missing";
  runStructure(command: CsvStructureCommand): void;
}

interface CsvTableProps {
  rows: string[][];
  readOnly?: boolean;
  onEdit?(rows: string[][]): void;
  onSave?(): void;
  ref?: React.Ref<CsvTableHandle>;
  onFind(): void;
  onFocusChange?(focus: { row: number; column: number }): void;
}

interface CellDraft { row: number; column: number; value: string }

const rowHeight = 36;
const overscan = 4;

/** Presents CSV headings and values as one keyboard-navigable, editable table. */
export function CsvTable({ rows, readOnly = true, onEdit, onSave, ref,
  onFind, onFocusChange }: CsvTableProps): React.ReactElement {
  const scroll = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusDraftPending = useRef(false);
  const draftRef = useRef<CellDraft | null>(null);
  const [draft, setDraft] = useState<CellDraft | null>(null);
  const [position, setPosition] = useState({ row: 0, column: 0 });
  const [firstVisibleRow, setFirstVisibleRow] = useState(1);
  const [visibleRows, setVisibleRows] = useState(20);
  const columns = rows[0].length;
  const row = Math.min(position.row, readOnly ? rows.length - 1 : rows.length);
  const column = Math.min(position.column, columns - 1);
  const windowStart = Math.max(1, firstVisibleRow - overscan);
  const windowEnd = Math.min(rows.length,
    firstVisibleRow + visibleRows + overscan);

  useEffect(() => {
    if (!readOnly && rows.length === 1 && rows[0].length === 1 && rows[0][0] === "") {
      beginEdit(0, 0);
    }
  }, []);

  useLayoutEffect(() => {
    if (readOnly && draftRef.current) {
      const current = draftRef.current;
      focusDraftPending.current = false;
      setCellDraft(null);
      move(current.row, current.column);
      return;
    }
    if (focusDraftPending.current && input.current) {
      input.current.focus();
      input.current.select();
      focusDraftPending.current = false;
      return;
    }
    if (!focusPending.current) return;
    if (position.row > rows.length) return;
    const target = cellAt(position.row, column);
    if (!target) return;
    focusPending.current = false;
    target.focus();
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
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

  function move(nextRow: number, nextColumn: number,
    lastRow = readOnly ? rows.length - 1 : rows.length,
    lastColumn = columns - 1): void {
    const targetRow = Math.max(0, Math.min(lastRow, nextRow));
    const targetColumn = Math.max(0, Math.min(lastColumn, nextColumn));
    focusPending.current = true;
    if (targetRow < windowStart || targetRow >= windowEnd) {
      const start = Math.max(1, targetRow - Math.floor(visibleRows / 2));
      setFirstVisibleRow(start);
      if (scroll.current) scroll.current.scrollTop = Math.max(0, (start - 1) * rowHeight);
    }
    setPosition({ row: targetRow, column: targetColumn });
  }

  function setCellDraft(next: CellDraft | null): void {
    draftRef.current = next;
    setDraft(next);
  }

  function beginEdit(nextRow: number, nextColumn: number): void {
    if (readOnly || !onEdit) return;
    focusDraftPending.current = true;
    setPosition({ row: nextRow, column: nextColumn });
    setCellDraft({ row: nextRow, column: nextColumn,
      value: rows[nextRow]?.[nextColumn] ?? "" });
  }

  function commitEdit(nextRow?: number, nextColumn?: number): void {
    const current = draftRef.current;
    if (!current) return;
    setCellDraft(null);
    const inserting = current.row === rows.length;
    if (!readOnly && current.value !== (rows[current.row]?.[current.column] ?? "")) {
      const updated = rows.map((values) => [...values]);
      if (inserting) updated.push(Array(columns).fill(""));
      updated[current.row][current.column] = current.value;
      onEdit?.(updated);
    }
    if (nextRow !== undefined && nextColumn !== undefined) {
      move(nextRow, nextColumn, inserting && current.value !== ""
        ? rows.length + 1 : rows.length);
    }
  }

  function editKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      commitEdit();
      onSave?.();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      const current = draftRef.current;
      setCellDraft(null);
      if (current) move(current.row, current.column);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const current = draftRef.current;
      if (current) commitEdit(current.row + 1, current.column);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const current = draftRef.current;
      if (current) {
        const index = current.row * columns + current.column + (event.shiftKey ? -1 : 1);
        const lastRow = current.row === rows.length && current.value !== ""
          ? rows.length + 1 : rows.length;
        const bounded = Math.max(0, Math.min((lastRow + 1) * columns - 1, index));
        commitEdit(Math.floor(bounded / columns), bounded % columns);
      }
    }
  }

  function cellContent(value: string, cellRow: number, cellColumn: number): React.ReactNode {
    if (!readOnly && draft?.row === cellRow && draft.column === cellColumn) {
      return <textarea ref={input} className="csv-cell-editor" aria-label={
        `Edit ${cellRow === 0 ? "heading" : cellRow === rows.length
          ? "new row" : `row ${cellRow}`}, column ${cellColumn + 1}`}
        value={draft.value} onChange={(event) => setCellDraft({ ...draft,
          value: event.target.value.replace(/\r\n?/g, "\n") })}
        onKeyDown={editKeyDown} onBlur={() => commitEdit()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()} />;
    }
    return <span className="csv-cell-preview">{value}</span>;
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

  function runStructure(command: CsvStructureCommand): void {
    if (readOnly || !onEdit || !scroll.current) return;
    const focused = position;
    if (focused.row < 0 || focused.row > rows.length
        || focused.column < 0 || focused.column >= columns) return;
    const rowCommand = command === "add-row-above" || command === "add-row-below"
      || command === "delete-row";
    if (rowCommand && focused.row === rows.length) return;
    if ((command === "add-row-above" || command === "delete-row") && focused.row === 0) return;
    if (command === "delete-column" && columns === 1) return;
    const updated = rows.map((values) => [...values]);
    let nextRow = focused.row;
    let nextColumn = focused.column;
    if (command === "add-row-above" || command === "add-row-below") {
      nextRow += command === "add-row-below" ? 1 : 0;
      updated.splice(nextRow, 0, Array(columns).fill(""));
    } else if (command === "delete-row") {
      if (updated[focused.row].some((value) => value !== "")
          && !window.confirm(`Delete row ${focused.row} and its values?`)) {
        move(focused.row, focused.column);
        return;
      }
      updated.splice(focused.row, 1);
      nextRow = focused.row < updated.length ? focused.row : focused.row - 1;
    } else if (command === "add-column-left" || command === "add-column-right") {
      nextColumn += command === "add-column-right" ? 1 : 0;
      for (const values of updated) values.splice(nextColumn, 0, "");
    } else if (command === "delete-column") {
      if (updated.some((values) => values[focused.column] !== "")
          && !window.confirm(`Delete column ${focused.column + 1} and its values?`)) {
        move(focused.row, focused.column);
        return;
      }
      for (const values of updated) values.splice(focused.column, 1);
      nextColumn = focused.column < columns - 1 ? focused.column : focused.column - 1;
    }
    setCellDraft(null);
    onEdit(updated);
    move(nextRow, nextColumn, updated.length, updated[0].length - 1);
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (draftRef.current && input.current) input.current.focus();
      else move(row, column);
    }, findNext, runStructure,
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
    if (event.key === "Enter") {
      event.preventDefault();
      beginEdit(row, column);
      return;
    }
    if (event.key === "Delete" && !readOnly && onEdit) {
      event.preventDefault();
      if (rows[row]?.[column]) {
        const updated = rows.map((values) => [...values]);
        updated[row][column] = "";
        onEdit(updated);
      }
      return;
    }
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
        const bounded = Math.max(0, Math.min(
          (readOnly ? rows.length : rows.length + 1) * columns - 1, index));
        nextRow = Math.floor(bounded / columns);
        nextColumn = bounded % columns;
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
    event.clipboardData.setData("text/plain", rows[copyRow]?.[copyColumn] ?? "");
    event.preventDefault();
  }

  function click(event: MouseEvent<HTMLTableCellElement>, nextRow: number,
    nextColumn: number): void {
    event.currentTarget.focus();
    move(nextRow, nextColumn);
  }

  function doubleClick(event: MouseEvent<HTMLTableCellElement>, nextRow: number,
    nextColumn: number): void {
    event.preventDefault();
    beginEdit(nextRow, nextColumn);
  }

  return <div className="csv-table-workspace" onFocusCapture={(event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-row][data-column]");
    if (cell && scroll.current?.contains(cell)) {
      onFocusChange?.({ row: Number(cell.dataset.row), column: Number(cell.dataset.column) });
    }
  }}>
    <div ref={scroll} className="csv-table-scroll"
      onScroll={(event) => setFirstVisibleRow(Math.max(1,
        Math.floor(event.currentTarget.scrollTop / rowHeight) + 1))}>
      <table className="csv-table" aria-label="CSV table view" aria-rowcount={rows.length + 1}
        style={{ width: `max(100%, ${columns * 12}rem)` }}>
        <thead><tr aria-rowindex={1}>
        {rows[0].map((heading, index) => <th scope="col" key={index}
          data-row="0" data-column={index} tabIndex={row === 0 && column === index ? 0 : -1}
          onClick={(event) => click(event, 0, index)}
          onDoubleClick={(event) => doubleClick(event, 0, index)}
          onKeyDown={keyDown} onCopy={copy}>
          {cellContent(heading, 0, index)}</th>)}
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
            onDoubleClick={(event) => doubleClick(event, rowIndex, columnIndex)}
            onKeyDown={keyDown} onCopy={copy}>
            {cellContent(value, rowIndex, columnIndex)}</td>)}
          </tr>;
        })}
        {windowEnd < rows.length && <tr className="csv-spacer-row" aria-hidden="true">
          <td colSpan={columns} style={{ height: (rows.length - windowEnd) * rowHeight }} />
        </tr>}
        <tr className="csv-insertion-placeholder" aria-label="Insertion placeholder"
          aria-rowindex={rows.length + 1}>
          {rows[0].map((_, columnIndex) => <td key={columnIndex}
            data-row={rows.length} data-column={columnIndex}
            tabIndex={!readOnly && row === rows.length && column === columnIndex ? 0 : -1}
            onClick={readOnly ? undefined : (event) => click(event, rows.length, columnIndex)}
            onDoubleClick={readOnly ? undefined : (event) =>
              doubleClick(event, rows.length, columnIndex)}
            onKeyDown={readOnly ? undefined : keyDown} onCopy={readOnly ? undefined : copy}>
            {cellContent("", rows.length, columnIndex)}
            {draft?.row !== rows.length && columnIndex === 0 &&
              <span className="csv-insertion-hint" aria-hidden="true">+ New row</span>}
          </td>)}
        </tr>
      </tbody></table>
    </div>
    <div className="csv-focused-value" aria-live="polite">
      <span>Focused value (row {row === 0 ? "heading" : row}, column {column + 1})</span>
      <pre>{rows[row]?.[column] ?? ""}</pre>
    </div>
  </div>;
}
