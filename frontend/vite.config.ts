import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    svgr({
      // Configure svgr to allow importing SVGs as default components
      // matching: import ReactComponent from './icon.svg'
      svgrOptions: {
        exportType: 'default',
        ref: true,
        svgo: false,
        titleProp: true,
      },
      include: "**/*.svg",
    }),
  ],
  server: {
    // Use VITE_PORT env var or default to 5173
    port: parseInt(process.env.VITE_PORT || '5173'),
    strictPort: true,
    proxy: {
      // Proxy CopilotKit requests to the bridge server
      '/api/copilotkit': {
        target: process.env.BRIDGE_URL || 'http://localhost:4111',
        changeOrigin: true,
      },
    },
  },
})
