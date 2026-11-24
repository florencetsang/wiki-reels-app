import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

const api = process.env.API_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Wiki Reels",
        short_name: "Wiki Reels",
        description: "Learn something in 60 seconds: swipeable infographic reels from Wikipedia.",
        theme_color: "#0b0b10",
        background_color: "#0b0b10",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/v1\//, /^\/img\//],
        runtimeCaching: [
          {
            // Infographics are immutable per key: cache-first, roughly 100 MB at ~150 KB each.
            urlPattern: ({ request, url }) => request.destination === "image" && /\/reels\/\d+\/infographics\//.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "infographics",
              expiration: { maxEntries: 700, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => /^\/v1\/(reels|related)\//.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "reel-meta", expiration: { maxEntries: 300 } },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { "/v1": api, "/img": api },
  },
  test: {
    environment: "jsdom",
  },
});
