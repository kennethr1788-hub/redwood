import { applyDisplayNames } from "../../launcher/src/display-names.js";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss(), { name: "display-names", transformIndexHtml: (html) => applyDisplayNames(html) }],
  build: { outDir: "dist" },
});
