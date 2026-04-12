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

  // Turbopack workspace root — silences the warning
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
