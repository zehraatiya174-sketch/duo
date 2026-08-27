import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 * `Content-Security-Policy` is intentionally strict; the only relaxations are
 * the ones Next.js genuinely requires (inline bootstrap script + styles).
 */
const CSP = [
  "default-src 'self'",
  // Next.js injects an inline bootstrap script and uses eval in dev only.
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://res.cloudinary.com https://lh3.googleusercontent.com",
  "media-src 'self' blob: https://res.cloudinary.com",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https://res.cloudinary.com https://api.cloudinary.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  {
    key: "Permissions-Policy",
    // Camera/microphone/display-capture are required for WebRTC calls.
    value:
      "camera=(self), microphone=(self), display-capture=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,

  // Pinned explicitly: Next walks up looking for a lockfile and would otherwise
  // pick a stray one in a parent directory as the workspace root.
  outputFileTracingRoot: process.cwd(),

  eslint: {
    dirs: [
      "app",
      "components",
      "features",
      "hooks",
      "lib",
      "server",
      "services",
      "socket",
      "utils",
    ],
  },

  typescript: {
    ignoreBuildErrors: false,
  },

  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "framer-motion",
      "date-fns",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-dialog",
      "emoji-picker-react",
    ],
  },

  serverExternalPackages: ["@node-rs/argon2", "sharp", "cloudinary"],

  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Uploaded media is private-by-default and must never be shared-cached.
        source: "/api/media/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
