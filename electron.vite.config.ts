import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const developmentNonce = randomBytes(24).toString('base64')
process.env.BETTER_MAIL_DEV_NONCE = developmentNonce
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: entry('./src/main/index.ts'),
          'mail-worker': entry('./src/main/mail-worker.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: entry('./src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@': entry('./src/renderer/src') } },
    html: { cspNonce: developmentNonce },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'better-mail-development-csp',
        transformIndexHtml: {
          order: 'post',
          handler: (html, context) =>
            context.server
              ? html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
              : html
        }
      }
    ],
    build: { minify: true, rollupOptions: { input: entry('./src/renderer/index.html') } }
  }
})
