import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const file = path.join(repoRoot, "apps", "console", "next.config.ts");

const src = fs.readFileSync(file, "utf8");
if (src.includes("fileURLToPath") && src.includes("workspaceRoot") && src.includes('output: "standalone"')) {
  process.exit(0);
}

let out = src;

if (!out.includes("fileURLToPath")) {
  out = out.replace(
    'import path from "node:path";\n',
    'import path from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst here = path.dirname(fileURLToPath(import.meta.url));\nconst workspaceRoot = path.resolve(here, "..", "..");\n\n'
  );
}

out = out.replace(
  /turbopack:\s*\{\s*\n\s*root:\s*[^\n]+\n\s*\}/m,
  'turbopack: {\n    root: workspaceRoot,\n  }'
);

if (!out.includes('output: "standalone"')) {
  out = out.replace(
    /const nextConfig:\s*NextConfig\s*=\s*\{\n/m,
    'const nextConfig: NextConfig = {\n  output: "standalone",\n'
  );
}

fs.writeFileSync(file, out, "utf8");
