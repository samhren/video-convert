import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
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
	},
});
