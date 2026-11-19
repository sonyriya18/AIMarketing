import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Responsys v17 lives in ./responsys with its own tooling; the platform never watches it.
  server: { watch: { ignored: ["**/responsys/**"] } },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // The chart library loads as a separate, cacheable file.
        manualChunks: {
          charts: ["recharts"],
        },
      },
    },
  },
});
