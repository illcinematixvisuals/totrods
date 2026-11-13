import { defineConfig } from "vite";

// base: "./" makes the built site use relative paths, so the dist/ folder
// works from any URL or sub-folder (handy when sharing a zip or hosting on itch.io).
export default defineConfig({
  base: "./",
  server: { port: 5173 },
  preview: { port: 8080 },
  build: { chunkSizeWarningLimit: 6000 },
});
