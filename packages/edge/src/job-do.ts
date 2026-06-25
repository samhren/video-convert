import { DurableObject } from 'cloudflare:workers';

/**
 * JobDO — the race-free single source of truth for one job's chunk-completion
 * state. Its single-threaded execution is the whole reason this lives in a
 * Durable Object rather than a DB (see CLAUDE.md): completion-counting is
 * correct by design, no external locks needed.
 *
 * Correctness invariants enforced here:
 *  - Completion is a SET of the EXPECTED chunk indexes, never a counter. SQS is
 *    at-least-once, so the same chunk can report "done" more than once;
 *    `done.add(i)` is idempotent. `/done` validates each index against the
 *    expected range `[0, n)` and rejects anything else, so `done.size > n` is
 *    structurally impossible — counting unknown ids can never reach completion.
 *  - Completion and reassembly are tracked by a LATCHED status state machine
 *    (`pending -> reassembling -> done | failed`), not by recomputing
 *    `done.size === n` on read. Once the job leaves `pending` it never returns,
 *    so a stray report can't flip completion back off.
 *  - Reassembly fires EXACTLY ONCE on success: the `done` status short-circuits
 *    any later trigger. A crash mid-reassembly leaves the job in `reassembling`
 *    (or `failed`), so a subsequent report RETRIES it rather than treating it as
 *    permanently complete.
 *
 * State is persisted to DO storage so it survives eviction; an in-memory copy is
 * hydrated on construction and kept write-through in sync.
 */

const KEY_N = 'n';
const KEY_DONE = 'done';
const KEY_STATUS = 'status';

/**
 * Reassembly lifecycle. `pending` means not all chunks are in yet. `reassembling`
 * means all chunks reported and reassembly is in flight (also the resting state
 * after a crash mid-reassembly — retried on the next trigger). `done` is the only
 * terminal success state; `failed` is retried.
 */
type JobStatus = 'pending' | 'reassembling' | 'done' | 'failed';

interface JobState {
	n: number | null;
	done: number[];
	complete: boolean;
	status: JobStatus;
}

export class JobDO extends DurableObject {
	private n: number | null = null;
	private done = new Set<number>();
	private status: JobStatus = 'pending';

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
			this.done = new Set((await ctx.storage.get<number[]>(KEY_DONE)) ?? []);
			this.status = (await ctx.storage.get<JobStatus>(KEY_STATUS)) ?? 'pending';
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

		// Idempotency guard: this design is built on at-least-once delivery, so a
		// duplicate/redelivered init must NOT wipe progress or re-arm reassembly.
		// Re-init with the same n is a no-op; a different n is a conflict.
		if (this.n !== null) {
			if (this.n === n) {
				return this.json(this.snapshot());
			}
			return this.error(`job already initialized with n=${this.n}`, 409);
		}

		this.n = n;
		this.done = new Set();
		this.status = 'pending';
		await this.ctx.storage.put({
			[KEY_N]: n,
			[KEY_DONE]: [] as number[],
			[KEY_STATUS]: this.status,
		});

		return this.json(this.snapshot());
	}

	private async handleDone(request: Request): Promise<Response> {
		let body: { chunkIndex?: unknown };
		try {
			body = await request.json();
		} catch {
			return this.error('invalid JSON body', 400);
		}

		if (this.n === null) {
			return this.error('job not initialized', 409);
		}

		// Validate against the EXPECTED chunks. Only indexes the job was initialized
		// with count toward completion; an out-of-range or non-integer index is
		// rejected. This is what keeps `done.size` capped at `n`.
		const chunkIndex = body.chunkIndex;
		if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex)) {
			return this.error('chunkIndex must be an integer', 400);
		}
		if (chunkIndex < 0 || chunkIndex >= this.n) {
			return this.error(`chunkIndex out of range [0, ${this.n})`, 400);
		}

		// Idempotent: re-reporting an already-counted chunk (SQS redelivery) is a
		// no-op for the set. Only persist when the set actually changed.
		const sizeBefore = this.done.size;
		this.done.add(chunkIndex);
		if (this.done.size !== sizeBefore) {
			await this.ctx.storage.put(KEY_DONE, [...this.done]);
		}

		await this.maybeReassemble();

		return this.json(this.snapshot());
	}

	/**
	 * Drive the reassembly state machine. Fires once all expected chunks are in,
	 * and is safe to call on every `/done`: the terminal `done` status
	 * short-circuits, while `reassembling` (crash mid-flight) or `failed` are
	 * retried. The status is persisted BEFORE reassembly runs so a crash leaves a
	 * retryable state rather than a falsely-completed one.
	 */
	private async maybeReassemble(): Promise<void> {
		if (this.done.size !== this.n) return;
		if (this.status === 'done') return;

		this.status = 'reassembling';
		await this.ctx.storage.put(KEY_STATUS, this.status);

		try {
			await this.reassemble();
			this.status = 'done';
		} catch {
			this.status = 'failed';
		}
		await this.ctx.storage.put(KEY_STATUS, this.status);
	}

	/**
	 * Stub — reassembly is not this pass. When implemented it will: sort
	 * the chunks by index, run an ffmpeg stream-copy concat (concat demuxer, not a
	 * re-encode — boundaries are keyframe-aligned), and write the final output to
	 * S3. Output handling must be idempotent so a retry after a crash is safe.
	 * For now it only records that it fired so the exactly-once guarantee is
	 * observable in tests.
	 */
	private async reassemble(): Promise<void> {
		this.reassembleCount++;
		// TODO: sort chunks by index -> ffmpeg concat demuxer stream copy -> write final to S3.
	}

	private snapshot(): JobState {
		return {
			n: this.n,
			done: [...this.done].sort((a, b) => a - b),
			// Latched: derived from the state machine, NOT recomputed from
			// `done.size === n`. Once the job leaves `pending` it stays complete.
			complete: this.status !== 'pending',
			status: this.status,
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
