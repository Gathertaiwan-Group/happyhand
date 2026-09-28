import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // 🔴 合併後三站同住一個 Supabase 專案，快樂手的表在 happyhands schema。
    // 任何新的 supabase client 若漏帶 db:{schema}，PostgREST 會靜默落到 public（＝小時光的同名表），
    // 不會有錯誤訊息。所以禁止在工廠以外的地方直接 import supabase 套件——要用就走 lib/supabase/*。
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/supabase/client.ts", "lib/supabase/server.ts", "middleware.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@supabase/ssr",
              message:
                "不要自己建 client：用 lib/supabase/{client,server}.ts 的工廠（它們帶了 db:{schema:'happyhands'}）。",
            },
            {
              name: "@supabase/supabase-js",
              message:
                "不要自己建 client：用 lib/supabase/{client,server}.ts 的工廠。只要型別的話用 import type。",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
