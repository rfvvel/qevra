import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { output: { manualChunks: { 'vendor-auth': ['@supabase/supabase-js'], 'vendor-validation': ['zod'] } } } },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:3001' } },
});
