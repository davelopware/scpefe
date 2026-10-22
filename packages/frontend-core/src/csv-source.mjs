/** Parse one RFC 4180 style CSV source, retaining empty cells and rows. */
export function parseCsvSource(source) {
  if (typeof source !== "string") throw new TypeError("CSV source must be text");
  const rows = [];
  const rowStarts = [];
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let atFieldStart = true;
  let rowStart = 0;
  const fail = (message, offset) => {
    const prefix = source.slice(0, offset);
    return { valid: false, message, offset,
      line: prefix.split("\n").length,
      column: prefix.length - prefix.lastIndexOf("\n") };
  };
  if (source.includes("\r")) return fail("Use LF line endings in CSV source.", source.indexOf("\r"));
  const finishField = () => { row.push(field); field = ""; atFieldStart = true; afterQuote = false; };
  const finishRow = () => { finishField(); rows.push(row); rowStarts.push(rowStart); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (afterQuote) {
      if (char === ",") finishField();
      else if (char === "\n") { finishRow(); rowStart = index + 1; }
      else return fail("Only a comma or line break may follow a closing quote.", index);
    } else if (char === '"') {
      if (!atFieldStart) return fail("A quote inside a cell must be doubled.", index);
      quoted = true; atFieldStart = false;
    } else if (char === ",") finishField();
    else if (char === "\n") { finishRow(); rowStart = index + 1; }
    else { field += char; atFieldStart = false; }
  }
  if (quoted) return fail("Close the quoted cell with a double quote.", source.length);
  if (source.length === 0 || rowStart < source.length) finishRow();
  const columns = rows[0].length;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].length !== columns) {
      return fail(`Row ${index + 1} has ${rows[index].length} cells; expected ${columns}.`,
        rowStarts[index]);
    }
  }
  return { valid: true, rows };
}

/** Serialize a rectangular CSV table using UTF-8 compatible LF source text. */
export function writeCsvSource(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])
      || rows[0].length === 0) throw new TypeError("CSV needs a heading row");
  const width = rows[0].length;
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== width
        || row.some((cell) => typeof cell !== "string" || cell.includes("\r"))) {
      throw new TypeError("CSV rows must have the same number of text cells");
    }
    return row.map((cell) => /[",\n]/.test(cell) || cell === ""
      ? `"${cell.replace(/"/g, '""')}"` : cell).join(",");
  }).join("\n");
}

/** Reject malformed CSV before any publication path uses source text. */
export function requireValidCsvSource(source) {
  const result = parseCsvSource(source);
  if (!result.valid) throw new TypeError(`Invalid CSV at line ${result.line}, column ${result.column}: ${result.message}`);
  return source;
}

/** Parse and write CSV in the stable source representation used for publication. */
export function serializeCsvSource(source) {
  const result = parseCsvSource(source);
  if (!result.valid) throw new TypeError(`Invalid CSV at line ${result.line}, column ${result.column}: ${result.message}`);
  return writeCsvSource(result.rows);
}
