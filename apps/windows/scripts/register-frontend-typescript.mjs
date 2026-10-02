import { register } from "node:module";

// Node's built-in type stripping does not support TSX. The existing Vite
// transformer handles both TypeScript formats in the test process.
register(new URL("./load-frontend-typescript.mjs", import.meta.url), import.meta.url);
