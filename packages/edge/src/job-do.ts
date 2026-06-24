import { DurableObject } from 'cloudflare:workers';

/**
 * JobDO — the race-free single source of truth for one job's chunk-completion
 * state. Its single-threaded execution is the whole reason this lives in a
 * Durable Object rather than a DB (see CLAUDE.md): completion-counting is
 * correct by design, no external locks needed.
 *
 * Correctness invariants enforced here:
 *  - Completion is a SET of chunk IDs, never a counter. SQS is at-least-once, so
 *    the same chunk can report "done" more than once; `done.add(id)` is
 *    idempotent. "Finished" means `done.size === n`.
 *  - Reassembly fires EXACTLY ONCE, guarded by the persisted `reassemblyFired`
 *    flag — extra/duplicate "done" reports after completion never re-fire it.
 *
 * State is persisted to DO storage so it survives eviction; an in-memory copy is
 * hydrated on construction and kept write-through in sync.
 */

const KEY_N = 'n';
const KEY_DONE = 'done';
const KEY_REASSEMBLY_FIRED = 'reassemblyFired';

interface JobState {
	n: number | null;
	done: string[];
	complete: boolean;
	reassemblyFired: boolean;
}

export class JobDO extends DurableObject {
	private n: number | null = null;
	private done = new Set<string>();
	private reassemblyFired = false;

	/**
	 * How many times reassembly has actually fired. Not persisted — exists only so
	 * tests can assert the exactly-once guarantee via `runInDurableObject`.
	 */
	reassembleCount = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Hydrate from storage before any request is handled. blockConcurrencyWhile
		// stalls incoming events until this resolves, so handlers always see state.
		ctx.blockConcurrencyWhile(async () => {
			this.n = (await ctx.storage.get<number>(KEY_N)) ?? null;
			this.done = new Set((await ctx.storage.get<string[]>(KEY_DONE)) ?? []);
			this.reassemblyFired = (await ctx.storage.get<boolean>(KEY_REASSEMBLY_FIRED)) ?? false;
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		if (method === 'POST' && url.pathname === '/init') {
			return this.handleInit(request);
		}
		if (method === 'POST' && url.pathname === '/done') {
			return this.handleDone(request);
		}
		if (method === 'GET' && url.pathname === '/state') {
			return this.json(this.snapshot());
		}

		return new Response('Not found', { status: 404 });
	}

	private async handleInit(request: Request): Promise<Response> {
		let body: { n?: unknown };
		try {
			body = await request.json();
		} catch {
			return this.error('invalid JSON body', 400);
		}

		const n = body.n;
		if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
			return this.error('n must be a positive integer', 400);
		}

		this.n = n;
		this.done = new Set();
		this.reassemblyFired = false;
		await this.ctx.storage.put({
			[KEY_N]: n,
			[KEY_DONE]: [] as string[],
			[KEY_REASSEMBLY_FIRED]: false,
		});

		return this.json(this.snapshot());
	}

	private async handleDone(request: Request): Promise<Response> {
		let body: { chunkId?: unknown };
		try {
			body = await request.json();
		} catch {
			return this.error('invalid JSON body', 400);
		}

		const chunkId = body.chunkId;
		if (typeof chunkId !== 'string' || chunkId.length === 0) {
			return this.error('chunkId must be a non-empty string', 400);
		}
		if (this.n === null) {
			return this.error('job not initialized', 409);
		}

		// Idempotent: re-reporting an already-counted chunk (SQS redelivery) is a
		// no-op for the set. Only persist when the set actually changed.
		const sizeBefore = this.done.size;
		this.done.add(chunkId);
		if (this.done.size !== sizeBefore) {
			await this.ctx.storage.put(KEY_DONE, [...this.done]);
		}

		// Exactly-once reassembly: completion is `done.size === n` (order-independent),
		// and the persisted flag prevents any later "done" report from re-firing.
		if (this.done.size === this.n && !this.reassemblyFired) {
			this.reassemblyFired = true;
			await this.ctx.storage.put(KEY_REASSEMBLY_FIRED, true);
			await this.reassemble();
		}

		return this.json(this.snapshot());
	}

	/**
	 * Stub — reassembly is not this pass. When implemented it will: sort
	 * the chunks by index, run an ffmpeg stream-copy concat (concat demuxer, not a
	 * re-encode — boundaries are keyframe-aligned), and write the final output to
	 * S3. For now it only records that it fired so the exactly-once guarantee is
	 * observable in tests.
	 */
	private async reassemble(): Promise<void> {
		this.reassembleCount++;
		// TODO: sort chunks by index -> ffmpeg concat demuxer stream copy -> write final to S3.
	}

	private snapshot(): JobState {
		return {
			n: this.n,
			done: [...this.done],
			complete: this.n !== null && this.done.size === this.n,
			reassemblyFired: this.reassemblyFired,
		};
	}

	private json(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	}

	private error(message: string, status: number): Response {
		return this.json({ error: message }, status);
	}
}
