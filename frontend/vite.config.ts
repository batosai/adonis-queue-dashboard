import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../build/resources/dashboard', import.meta.url)),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: fileURLToPath(new URL('src/main.ts', import.meta.url)) },
  },
})
