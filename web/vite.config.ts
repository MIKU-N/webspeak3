import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

function landingSlashRedirect(): Plugin {
  const redirect = (server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: () => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/landing') {
        res.statusCode = 302
        res.setHeader('Location', '/landing/')
        res.end()
        return
      }
      next()
    })
  }

  return {
    name: 'landing-slash-redirect',
    configureServer: redirect,
    configurePreviewServer: redirect,
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [landingSlashRedirect(), react()],
  // Set by the GitHub Pages workflow to the repo subpath (e.g. /webspeak3/);
  // the normal Docker build serves from the domain root and leaves this unset.
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing/index.html'),
      },
    },
  },
})
