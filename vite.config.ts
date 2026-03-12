import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.PARTCOPY_API_PORT || '3001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      ignored: ['**/.partcopy/**']
    },
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/assets': `http://localhost:${apiPort}`
    }
  }
})
