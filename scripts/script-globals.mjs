// Collects names that classic (non-module) scripts publish to their shared global scope.
// Used by eslint.config.mjs so cross-file references in the dashboard/content contexts are checked
// instead of being silently allowed.
import { readFileSync, existsSync } from 'node:fs';
import * as espree from 'espree';

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'root']); // 'root' = UMD wrapper parameter

export function collectGlobals(files) {
  const names = new Set();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const ast = espree.parse(readFileSync(file, 'utf8'), { ecmaVersion: 2024, sourceType: 'script' });
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') names.add(node.id.name);
      if (node.type === 'VariableDeclaration') for (const d of node.declarations) collectPattern(d.id, names);
    }
    walk(ast, node => {
      if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') return;
      const { object, property, computed } = node.left;
      if (
        !computed &&
        object.type === 'Identifier' &&
        GLOBAL_OBJECTS.has(object.name) &&
        property.type === 'Identifier'
      )
        names.add(property.name);
    });
  }
  return Object.fromEntries([...names].map(n => [n, 'writable']));
}

function collectPattern(p, names) {
  if (!p) return;
  if (p.type === 'Identifier') names.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach(x => collectPattern(x.value || x.argument, names));
  else if (p.type === 'ArrayPattern') p.elements.forEach(x => collectPattern(x, names));
  else if (p.type === 'RestElement') collectPattern(p.argument, names);
  else if (p.type === 'AssignmentPattern') collectPattern(p.left, names);
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, visit));
    else if (v && typeof v.type === 'string' && key !== 'parent') walk(v, visit);
  }
}

export function scriptSrcs(htmlFile, base = '') {
  const html = readFileSync(htmlFile, 'utf8');
  return [...html.matchAll(/<script(?![^>]*type="module")[^>]*\ssrc="([^"]+)"/g)].map(
    m => base + m[1].replace(/^\//, '')
  );
}
