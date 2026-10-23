import { defineConfig } from "vite";

// base "./" so dist/ serves from any static path (docs/design.md).
export default defineConfig({
  base: "./",
  server: { port: 5174 },
  build: { target: "es2022" },
});
