import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { JobDO } from '../src/job-do';

// These run fully locally under @cloudflare/vitest-pool-workers: Miniflare
// executes them inside the real workerd runtime with real Durable Object storage
// semantics. The single-threaded execution and storage persistence the design
// relies on are runtime properties, so we test the real runtime, not a mock.

type JobStatus = 'pending' | 'reassembling' | 'done' | 'failed';

interface JobState {
	n: number | null;
	done: number[];
	complete: boolean;
	status: JobStatus;
}

// Each test gets an isolated DO instance via a unique name.
function stubFor(name: string) {
	const id = env.JOB_DO.idFromName(name);
	return env.JOB_DO.get(id);
}

type Stub = ReturnType<typeof stubFor>;

function post(stub: Stub, path: string, body: unknown): Promise<Response> {
	return stub.fetch(`https://do${path}`, {
		method: 'POST',
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

async function init(stub: Stub, n: number): Promise<JobState> {
	const res = await post(stub, '/init', { n });
	expect(res.status).toBe(200);
	return res.json();
}

async function done(stub: Stub, chunkIndex: number): Promise<JobState> {
	const res = await post(stub, '/done', { chunkIndex });
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
		expect(s.status).toBe('pending');
	});

	// Failure mode 1: chunks finish out of order. Completion depends only on the
	// set reaching N distinct expected indexes, never on arrival order.
	it('completes at N even when chunks are reported out of order', async () => {
		const stub = stubFor('out-of-order');
		await init(stub, 3);

		let s = await done(stub, 2);
		expect(s.complete).toBe(false);
		s = await done(stub, 0);
		expect(s.complete).toBe(false);
		s = await done(stub, 1);

		expect(s.complete).toBe(true);
		expect(s.done).toEqual([0, 1, 2]);
		expect(s.status).toBe('done');
	});

	// Failure mode 2: SQS at-least-once redelivery. A duplicate "done" for an
	// already-counted chunk must not advance completion or change the set.
	it('does not advance on a duplicate chunk report', async () => {
		const stub = stubFor('duplicate');
		await init(stub, 3);

		await done(stub, 0);
		const afterDup = await done(stub, 0);
		expect(afterDup.done).toEqual([0]);
		expect(afterDup.complete).toBe(false);

		// The two distinct remaining chunks still bring it to completion — proving
		// the duplicate neither double-counted nor corrupted the set.
		await done(stub, 1);
		const s = await done(stub, 2);
		expect(s.done).toEqual([0, 1, 2]);
		expect(s.complete).toBe(true);
	});

	// Failure mode 3: reassembly must fire EXACTLY ONCE, even when extra "done"
	// reports (including duplicates) arrive after the job is already complete.
	it('fires reassembly exactly once despite extra post-completion reports', async () => {
		const stub = stubFor('fire-once');
		await init(stub, 2);

		await done(stub, 0);
		const s = await done(stub, 1); // completes here
		expect(s.complete).toBe(true);
		expect(s.status).toBe('done');

		// Extra duplicate reports after completion must not re-fire reassembly...
		const afterDup0 = await done(stub, 0);
		const afterDup1 = await done(stub, 1);
		// ...and completion must STAY latched, never flip back to false.
		expect(afterDup0.complete).toBe(true);
		expect(afterDup1.complete).toBe(true);
		expect(afterDup1.status).toBe('done');

		const fireCount = await runInDurableObject(stub, (instance: JobDO) => instance.reassembleCount);
		expect(fireCount).toBe(1);
	});

	// Bug #1 regression: completion is a latch. An out-of-range report arriving
	// after completion is rejected and can never recompute completion back to false.
	it('keeps completion latched when a stray out-of-range report arrives after completion', async () => {
		const stub = stubFor('latched');
		await init(stub, 2);
		await done(stub, 0);
		const completed = await done(stub, 1);
		expect(completed.complete).toBe(true);

		// A stray index outside [0, n) is rejected outright (bug #2 closes #1 here).
		const stray = await post(stub, '/done', { chunkIndex: 99 });
		expect(stray.status).toBe(400);

		const s = await state(stub);
		expect(s.complete).toBe(true);
		expect(s.status).toBe('done');
		expect(s.done).toEqual([0, 1]);
	});

	// Bug #3: init is idempotent under at-least-once delivery. A redelivered init
	// must not wipe progress or re-arm reassembly.
	it('treats a duplicate init with the same n as a no-op (does not wipe progress)', async () => {
		const stub = stubFor('reinit-same');
		await init(stub, 3);
		await done(stub, 0);
		await done(stub, 1);

		// Redelivered init with the same n: progress is preserved.
		const reinit = await init(stub, 3);
		expect(reinit.done).toEqual([0, 1]);
		expect(reinit.complete).toBe(false);

		// And the job can still complete normally.
		const s = await done(stub, 2);
		expect(s.complete).toBe(true);
	});

	it('rejects re-init with a different n as a conflict', async () => {
		const stub = stubFor('reinit-conflict');
		await init(stub, 3);
		await done(stub, 0);

		const res = await post(stub, '/init', { n: 5 });
		expect(res.status).toBe(409);

		// Original state is untouched.
		const s = await state(stub);
		expect(s.n).toBe(3);
		expect(s.done).toEqual([0]);
	});

	it('rejects invalid init requests', async () => {
		const stub = stubFor('init-validation');

		expect((await post(stub, '/init', 'not json')).status).toBe(400);
		expect((await post(stub, '/init', {})).status).toBe(400);
		expect((await post(stub, '/init', { n: 0 })).status).toBe(400);
		expect((await post(stub, '/init', { n: -1 })).status).toBe(400);
		expect((await post(stub, '/init', { n: 2.5 })).status).toBe(400);
		expect((await post(stub, '/init', { n: 'three' })).status).toBe(400);
	});

	// Bug #2: only the EXPECTED chunk indexes count. Unknown / out-of-range /
	// malformed indexes are rejected, so done.size can never exceed n.
	it('rejects done reports for unknown or malformed chunk indexes', async () => {
		const stub = stubFor('done-validation');

		// Done before init.
		expect((await post(stub, '/done', { chunkIndex: 0 })).status).toBe(409);

		await init(stub, 2);
		expect((await post(stub, '/done', 'not json')).status).toBe(400);
		expect((await post(stub, '/done', {})).status).toBe(400);
		expect((await post(stub, '/done', { chunkIndex: -1 })).status).toBe(400);
		expect((await post(stub, '/done', { chunkIndex: 2 })).status).toBe(400); // == n, out of range
		expect((await post(stub, '/done', { chunkIndex: 99 })).status).toBe(400);
		expect((await post(stub, '/done', { chunkIndex: 1.5 })).status).toBe(400);
		expect((await post(stub, '/done', { chunkIndex: '0' })).status).toBe(400);

		// None of the rejected reports were counted.
		const s = await state(stub);
		expect(s.done).toEqual([]);
		expect(s.complete).toBe(false);
	});

	// State must survive eviction: it is written through to DO storage, which is
	// what the constructor hydrates from on restart.
	it('persists n, done, and status to durable storage', async () => {
		const stub = stubFor('persistence');
		await init(stub, 2);
		await done(stub, 1);

		await runInDurableObject(stub, async (_instance: JobDO, ctxState) => {
			expect(await ctxState.storage.get('n')).toBe(2);
			expect(await ctxState.storage.get('done')).toEqual([1]);
			expect(await ctxState.storage.get('status')).toBe('pending');
		});

		await done(stub, 0); // completes -> reassembles

		await runInDurableObject(stub, async (_instance: JobDO, ctxState) => {
			expect((await ctxState.storage.get<number[]>('done'))!.sort()).toEqual([0, 1]);
			expect(await ctxState.storage.get('status')).toBe('done');
		});
	});

	// Bug #4: a crash mid-reassembly must leave a RETRYABLE state, never a
	// falsely-completed one. We inject a failing reassemble(), confirm the job
	// lands in `failed` (still complete: all chunks are in), then confirm a later
	// trigger retries and succeeds.
	it('marks reassembly failed and retries on a subsequent report', async () => {
		const stub = stubFor('reassembly-failure');
		await init(stub, 1);

		// Make the next reassembly throw.
		await runInDurableObject(stub, (instance: JobDO) => {
			(instance as unknown as { reassemble: () => Promise<void> }).reassemble = () =>
				Promise.reject(new Error('boom'));
		});

		const failed = await done(stub, 0);
		expect(failed.complete).toBe(true); // all chunks reported — completion latched
		expect(failed.status).toBe('failed');

		// Repair reassembly, then a redelivered report retries it to success.
		await runInDurableObject(stub, (instance: JobDO) => {
			(instance as unknown as { reassemble: () => Promise<void>; reassembleCount: number }).reassemble =
				function (this: JobDO) {
					(this as unknown as { reassembleCount: number }).reassembleCount++;
					return Promise.resolve();
				};
		});

		const retried = await done(stub, 0);
		expect(retried.status).toBe('done');
		expect(retried.complete).toBe(true);
	});
});
