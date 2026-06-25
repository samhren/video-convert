import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// AWS Fargate ffmpeg worker runs on Node — no DOM, no workerd.
		environment: "node",
		// No specs exist yet — keep `vitest run` green until real tests are added.
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.ts"],
		},
	},
});
