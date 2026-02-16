import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
