import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules that can't be bundled — must stay external on the server
  serverExternalPackages: [
    "@ruvector/rvf",
    "@ruvector/rvf-node",
    "@xenova/transformers",
    "sharp",
    "onnxruntime-node",
  ],

  // Turbopack workspace root — set to repo root (one level up from web/) so
  // the web/data -> ../data symlink resolves within the declared root.
  turbopack: {
    root: require('path').resolve(__dirname, '..'),
  },
};

export default nextConfig;
