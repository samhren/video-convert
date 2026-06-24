import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { JobDO } from '../src/job-do';

// These run fully locally under @cloudflare/vitest-pool-workers: Miniflare
// executes them inside the real workerd runtime with real Durable Object storage
// semantics. The single-threaded execution and storage persistence the design
// relies on are runtime properties, so we test the real runtime, not a mock.

interface JobState {
	n: number | null;
	done: string[];
	complete: boolean;
	reassemblyFired: boolean;
}

// Each test gets an isolated DO instance via a unique name.
function stubFor(name: string) {
	const id = env.JOB_DO.idFromName(name);
	return env.JOB_DO.get(id);
}

type Stub = ReturnType<typeof stubFor>;

async function init(stub: Stub, n: number): Promise<JobState> {
	const res = await stub.fetch('https://do/init', {
		method: 'POST',
		body: JSON.stringify({ n }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

async function done(stub: Stub, chunkId: string): Promise<JobState> {
	const res = await stub.fetch('https://do/done', {
		method: 'POST',
		body: JSON.stringify({ chunkId }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

async function state(stub: Stub): Promise<JobState> {
	const res = await stub.fetch('https://do/state');
	expect(res.status).toBe(200);
	return res.json();
}

describe('JobDO', () => {
	it('initializes and reports empty, not-complete state', async () => {
		const stub = stubFor('positive-path');
		await init(stub, 3);

		const s = await state(stub);
		expect(s.n).toBe(3);
		expect(s.done).toEqual([]);
		expect(s.complete).toBe(false);
		expect(s.reassemblyFired).toBe(false);
	});

	// Failure mode 1: chunks finish out of order. Completion depends only on the
	// set size reaching N, never on arrival order.
	it('completes at N even when chunks are reported out of order', async () => {
		const stub = stubFor('out-of-order');
		await init(stub, 3);

		let s = await done(stub, 'c');
		expect(s.complete).toBe(false);
		s = await done(stub, 'a');
		expect(s.complete).toBe(false);
		s = await done(stub, 'b');

		expect(s.complete).toBe(true);
		expect([...s.done].sort()).toEqual(['a', 'b', 'c']);
		expect(s.reassemblyFired).toBe(true);
	});

	// Failure mode 2: SQS at-least-once redelivery. A duplicate "done" for an
	// already-counted chunk must not advance completion or change the set.
	it('does not advance on a duplicate chunk report', async () => {
		const stub = stubFor('duplicate');
		await init(stub, 3);

		await done(stub, 'a');
		const afterDup = await done(stub, 'a');
		expect(afterDup.done).toEqual(['a']);
		expect(afterDup.complete).toBe(false);

		// The two distinct remaining chunks still bring it to completion — proving
		// the duplicate neither double-counted nor corrupted the set.
		await done(stub, 'b');
		const s = await done(stub, 'c');
		expect([...s.done].sort()).toEqual(['a', 'b', 'c']);
		expect(s.complete).toBe(true);
	});

	// Failure mode 3: reassembly must fire EXACTLY ONCE, even when extra "done"
	// reports (including duplicates) arrive after the job is already complete.
	it('fires reassembly exactly once despite extra post-completion reports', async () => {
		const stub = stubFor('fire-once');
		await init(stub, 2);

		await done(stub, 'a');
		const s = await done(stub, 'b'); // completes here
		expect(s.complete).toBe(true);
		expect(s.reassemblyFired).toBe(true);

		// Extra reports after completion: a brand-new id and duplicates.
		await done(stub, 'b');
		await done(stub, 'a');
		const final = await done(stub, 'c');
		expect(final.reassemblyFired).toBe(true);

		const fireCount = await runInDurableObject(stub, (instance: JobDO) => instance.reassembleCount);
		expect(fireCount).toBe(1);
	});
});
