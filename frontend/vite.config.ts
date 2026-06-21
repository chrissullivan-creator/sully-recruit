import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    host: "0.0.0.0",
    port: 3000,
    allowedHosts: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split stable third-party libs into their own cacheable chunks.
        // Previously everything landed in one ~1.3 MB index chunk, so every
        // deploy (and we ship often) invalidated the whole thing for users.
        // Now app code is small and changes per deploy; the heavy vendors
        // (React, Radix, Supabase, …) stay cached across deploys. The
        // page-only libs (editor/charts/pdf) get their own chunks too but
        // still load lazily with the route that imports them.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("@radix-ui") || id.includes("@floating-ui")) return "radix";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("@tiptap") || id.includes("prosemirror") || id.includes("linkifyjs")) return "editor";
          if (id.includes("recharts") || id.includes("/d3-") || id.includes("victory-vendor") || id.includes("internmap")) return "charts";
          if (id.includes("jspdf") || id.includes("html2canvas") || id.includes("canvg")) return "pdf";
          if (id.includes("date-fns")) return "date-fns";
          if (id.includes("lucide-react")) return "icons";
          return "vendor";
        },
      },
    },
  },
}));
