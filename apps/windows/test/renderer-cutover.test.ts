import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSync } from "vite";

const entry = new URL("../src/renderer.tsx", import.meta.url);
type SyntaxNode = Record<string, unknown> & { type: string };

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function identifier(node: unknown): string | undefined {
  if (!isNode(node) || (node.type !== "Identifier"
    && node.type !== "JSXIdentifier")) return undefined;
  return typeof node.name === "string" ? node.name : undefined;
}

test("Windows renderer entry only composes the shared UI and platform adapters", async () => {
  const source = await readFile(entry, "utf8");
  const parsed = parseSync(entry.pathname, source, { lang: "tsx", sourceType: "module" });
  assert.equal(parsed.errors.length, 0);
  const program = parsed.program as unknown as SyntaxNode & { body: SyntaxNode[] };

  const imports = program.body.filter((node) => node.type === "ImportDeclaration")
    .map((node) => (node.source as { value: string }).value);
  assert.equal(imports.includes("@scpefe/react-ui"), true);
  assert.equal(imports.includes("@scpefe/frontend-core"), false,
    "session authority enters through SharedApp, never through the Windows entry");
  const declarations = program.body.map((node) => node.type === "ExportNamedDeclaration"
    ? node.declaration as SyntaxNode : node).filter(isNode);
  assert.deepEqual(declarations.filter((node) => node.type === "FunctionDeclaration")
    .map((node) => identifier(node.id)), ["mountApp"]);
  assert.equal(declarations.some((node) => node.type === "ClassDeclaration"), false);

  const forbiddenCalls = new Set(["useState", "useReducer", "useRef", "useEffect",
    "useSyncExternalStore", "addEventListener", "alert"]);
  const forbiddenConstructors = new Set(["DocumentSession", "WorkingCopy",
    "FocusManager"]);
  let sharedAppMounts = 0;
  const visit = (node: SyntaxNode): void => {
    if (node.type === "CallExpression") {
      const call = identifier(node.callee);
      assert.equal(call !== undefined && forbiddenCalls.has(call), false,
        `${call} would recreate state, focus, or unrestricted messages`);
    }
    if (node.type === "NewExpression") {
      const constructed = identifier(node.callee);
      assert.equal(constructed !== undefined && forbiddenConstructors.has(constructed), false,
        `${constructed} belongs in the shared frontend modules`);
    }
    if (node.type === "MemberExpression") {
      const member = identifier(node.property);
      assert.equal(member === "message" || member === "stack", false,
        "raw host error details must stay behind the safe catalogue adapter");
    }
    if (node.type === "JSXOpeningElement" && identifier(node.name) === "SharedApp") {
      sharedAppMounts += 1;
    }
    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      }
    }
  };
  visit(program);
  assert.equal(sharedAppMounts, 1,
    "the production entry must mount the shared UI exactly once");
});
