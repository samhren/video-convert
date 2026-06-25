import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

// Kept separate from vite.config.ts (which carries the vite-plus lint/format
// config) so the test runner stays decoupled from the build/lint pipeline.
export default defineConfig({
	plugins: [react()],
	test: {
		// React components need a DOM. happy-dom is lighter than jsdom.
		environment: "happy-dom",
		setupFiles: ["./src/test/setup.ts"],
		// No specs exist yet — keep `vitest run` green until real tests are added.
		passWithNoTests: true,
		css: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/test/**", "src/main.tsx"],
		},
	},
});
