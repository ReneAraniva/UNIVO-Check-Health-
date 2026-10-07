import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  assetsInclude: ['**/*.svg', '**/*.csv'],

  // Code-splitting: separa las librerías pesadas en chunks propios para que no
  // inflen el bundle inicial. Como las rutas ya son lazy, cada vendor se descarga
  // solo cuando se visita la pantalla que lo usa (mapa, gráficos, PDF, etc.).
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
          if (id.includes('leaflet')) return 'vendor-maps';
          if (id.includes('jspdf')) return 'vendor-pdf';
          if (id.includes('xlsx')) return 'vendor-xlsx';
          if (id.includes('@mui') || id.includes('@emotion')) return 'vendor-mui';
          if (id.includes('html5-qrcode')) return 'vendor-qr';
          if (id.includes('firebase')) return 'vendor-firebase';
          // Solo los paquetes de React en sí. El antiguo `id.includes('/react/')` también
          // atrapaba subrutas como `motion/react/` o `@sentry/react/` (una vez que pnpm
          // resuelve bien el peer de React) y las metía en este chunk de carga inicial.
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'vendor-react';
          // El resto (supabase, radix, zustand, etc.): se deja a Vite, que respeta
          // los límites de las rutas lazy en vez de forzar un mega-chunk eager.
          return undefined;
        },
      },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // Vitest corre los unit tests (src/__tests__); los E2E de Playwright viven en
    // e2e/ y se ejecutan con `pnpm e2e`, no con vitest.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/__tests__/**', 'src/shared/components/ui/**', 'src/main.tsx'],
    },
  },
})
