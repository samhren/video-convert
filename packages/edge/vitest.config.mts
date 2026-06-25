import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// No specs exist yet — keep `vitest run` green until real tests are added.
		passWithNoTests: true,
		poolOptions: {
			workers: {
				// JobDO uses `new_sqlite_classes`, and the per-test isolated-storage
				// stacking can't currently roll back SQLite's `.sqlite-shm`/`-wal`
				// sidecar files (vitest-pool-workers known issue:
				// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage).
				// We don't rely on it: every test addresses a uniquely-named DO
				// instance, so storage is already isolated by id.
				isolatedStorage: false,
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
