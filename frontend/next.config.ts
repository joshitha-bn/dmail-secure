import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["openpgp"],
  serverExternalPackages: ["kubo-rpc-client"],
  distDir: process.env.BUILD_DIR || ".next",
}

export default nextConfig