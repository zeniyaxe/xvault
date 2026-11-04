// Formatting-agnostic views of the source tree for structural tests.
// The extension source is Prettier-formatted, so structural assertions match either a compact view (formatting
// whitespace removed) or a collapsed view (whitespace runs folded to one space). Identifiers always stay separated.
// Code that a test executes must come from the unmodified text, e.g. via topLevelDeclaration().
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const identifier = /[\w$]/;

export function readSource(path) {
  return fs.readFileSync(new URL(path, root), 'utf8');
}

// `function f(a, b) {\n  return a;\n}` → `function f(a,b){return a;}`
export function compactSource(text) {
  return text.replace(/\s+/g, (space, offset, all) =>
    identifier.test(all[offset - 1] || '') && identifier.test(all[offset + space.length] || '') ? ' ' : ''
  );
}

// `let a = 0,\n  b = 0;` → `let a = 0, b = 0;`
export function collapseSource(text) {
  return text.replace(/\s+/g, ' ');
}

// The complete top-level declaration whose first line starts with `signature`, through the first later line that
// closes it at column 0 (`}`, `};`, `})`, `]`).
export function topLevelDeclaration(text, signature) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(signature));
  if (start < 0) throw new Error(`Declaration not found: ${signature}`);
  if (!/[{([]\s*$/.test(lines[start])) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^[}\])]/.test(line));
  if (end < 0) throw new Error(`Declaration is not closed: ${signature}`);
  return lines.slice(start, end + 1).join('\n');
}
