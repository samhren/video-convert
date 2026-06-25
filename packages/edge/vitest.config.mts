import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// No specs exist yet — keep `vitest run` green until real tests are added.
		passWithNoTests: true,
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
		coverage: {
			// The workerd pool cannot use the v8 provider (no V8 inspector inside
			// the runtime — it reports 0%). Istanbul instruments the source and
			// works correctly here.
			provider: "istanbul",
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.ts"],
		},
	},
});
