import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const sharedAlias = {
  '@shared': resolve(__dirname, 'app/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'app/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'app/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: { alias: sharedAlias },
    root: resolve(__dirname, 'app/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'app/renderer/panel.html'),
          ball: resolve(__dirname, 'app/renderer/ball.html'),
          help: resolve(__dirname, 'app/renderer/help.html')
        }
      }
    }
  }
})
