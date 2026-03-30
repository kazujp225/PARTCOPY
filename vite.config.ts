import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.PARTCOPY_API_PORT || '3001'

export default defineConfig({
  plugins: [react({ jsxRuntime: 'automatic' })],
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']
  },
  server: {
    port: 5180,
    watch: {
      ignored: ['**/.partcopy/**']
    },
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        timeout: 600000,
      },
      '/assets': `http://localhost:${apiPort}`
    }
  }
})
