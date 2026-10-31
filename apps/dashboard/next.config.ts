import type { NextConfig } from "next";

const config: NextConfig = {
  // This app lives inside the engine repo, which has its own lockfile; pin the root here.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
};

export default config;
