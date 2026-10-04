import { defineConfig } from "vite";
import { applyDisplayNames } from './src/display-names.js';

export default defineConfig({
  plugins: [{name: 'placeholder-display-names', transformIndexHtml: html => applyDisplayNames(html)}],
  server: {
    host: "127.0.0.1",
    port: 4191,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4191,
    strictPort: true,
  },
});
