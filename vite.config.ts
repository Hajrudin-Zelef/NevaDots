import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig({
  plugins: [react()],
  // La bibliothèque de skills (data/skills) et le bureau de plans contiennent
  // des tests tiers : jamais découverts par notre suite.
  test: {
    exclude: [...configDefaults.exclude, 'data/**', 'OffLineFork/**'],
  },
  css: { postcss: { plugins: [darkTheme()] } },
  build: {
    outDir: 'dist/client',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split the biggest vendors so they cache independently and download
        // in parallel instead of one 2.8 MB bundle.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@copilotkit') || id.includes('@ag-ui'))
            return 'vendor-copilotkit';
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('scheduler')
          )
            return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
