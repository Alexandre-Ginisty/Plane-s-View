/**
 * Connection quality monitor and streaming profile.
 *
 * ## Why this exists
 *
 * Every streaming constant in this app used to be a single number tuned on a
 * good connection: 128 parallel tile requests, refine to zoom 17, accept 6 px
 * of screen-space error. On a fast link those numbers are right. On a weak one
 * they are actively destructive, and in a way that is worth spelling out
 * because it is counter-intuitive:
 *
 * **Asking for more makes you get less.** 128 parallel requests over a 500
 * kB/s link give each request 4 kB/s. A 40 kB satellite tile then needs ten
 * seconds, so *every* tile misses the 12 s timeout at roughly the same moment,
 * the whole batch fails together, and the retry logic asks for 128 more. The
 * ground never finishes at any zoom level — which is exactly the "the ground
 * does not load" symptom. With twelve requests in flight each gets 40 kB/s,
 * every tile lands in a second, and the picture fills in ring by ring.
 *
 * The same logic applies to depth. Refining to z17 on a weak link means the
 * quadtree spends the whole pipe on tiles four levels below what it could
 * actually finish, so the viewer sits looking at z11 blur while z17 requests
 * time out behind it. Capping the depth to what the link can deliver produces
 * a complete, coarser picture — which looks far better than an incomplete
 * sharp one.
 *
 * So the profile is not a "quality setting". It is a statement about what this
 * connection can actually deliver, and every consumer derives its numbers from
 * it: the tile loader its concurrency and timeouts, the globe its zoom ceiling
 * and error target, the traffic client its query radius.
 *
 * `profile.ts` is the policy (grades and what each one permits),
 * `monitor.ts` the measurement, `environment.ts` the browser hints.
 */

export * from './profile';
export * from './environment';
export * from './monitor';
