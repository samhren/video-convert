// Runs before every test file (see `setupFiles` in vitest.config.ts).
// Adds jest-dom's custom matchers (e.g. `toBeInTheDocument`) to Vitest's
// `expect`, and clears the DOM between tests so renders don't leak.
import { afterEach } from "vite-plus/test";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
	cleanup();
});
