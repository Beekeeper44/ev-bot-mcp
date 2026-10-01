/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["supertokens-node"],
  // The EV Bot screen lives in public/evbot.html and is served at /.
  // beforeFiles so it wins even if an old app/page.tsx is still in the repo.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/evbot.html" }] };
  },
  async headers() {
    return [{ source: "/evbot.html", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "X-Frame-Options", value: "DENY" }] }];
  },
};
export default nextConfig;
