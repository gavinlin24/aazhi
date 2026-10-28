# AAzhi Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord bot that turns a photographed restaurant receipt into exact per-person amounts and tracks settlement until the debt clears.

**Architecture:** A single Cloudflare Worker serves three surfaces: Discord's interactions endpoint, an assignment web page, and that page's JSON API. State lives in D1. The share engine is pure TypeScript with no platform dependency, so the money arithmetic is unit-testable without a Worker runtime. Receipt extraction defers the Discord interaction and completes through the follow-up webhook.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono (routing), Cloudflare D1 (SQLite), Claude Haiku 5.5 (vision extraction), Vitest with `@cloudflare/vitest-plugin`, Wrangler.

**Spec:** `docs/specs/2026-10-28-aazhi-design.md`

## Global Constraints

- **All money is integer cents.** No floating-point value ever holds an amount. Prices become cents at extraction time.
- **USD only.** No currency field, no conversion.
- **Proration denominator is always the bill subtotal**, never the claimed-so-far subtotal.
- **Leftover cents from splitting one item** go one each to the first `r` claimants in ascending participant-id order. Never click order.
- **Final per-person rounding is largest remainder**, tie-broken by ascending participant id, so shares sum to the distributable total exactly.
- **No privileged Discord intents and no gateway connection.** Interactions only.
- **Every interaction is acknowledged within 3 seconds.** Anything slower defers (type 5) and completes via the follow-up webhook, which allows 15 minutes.
- **Interaction tokens expire in 15 minutes.** Edits to a bill message after that use the bot token with the stored `channel_id` and `message_id`.
- **One bot message per bill**, edited in place. Message edits are coalesced to at most one per 3 seconds per bill.
- **Ed25519 signature verification runs before any interaction body is parsed.** Algorithm name is `"Ed25519"`, not `NODE-ED25519`.
- **Access tokens are stateless**, HMAC-signed, 30-minute expiry, bound to `(bill_id, participant_id)`. No session rows.
- **No receipt images are stored.** Fetch the Discord CDN URL during extraction and persist only parsed data.
- **No AI attribution in commits.** No `Co-Authored-By` trailers.
- **Conventional Commits**, lowercase, imperative, no trailing period.

## Review Focus

Five input classes the spec implies but does not give a task. Each line's test is added to the task that owns the code, named in brackets.

- **A photo that is not a readable receipt** (a menu, a selfie, a blurred shot). Extraction returns nothing usable. Expect a plain message saying it could not read a receipt, and no bill created. [Task 4]
- **Nobody has claimed anything yet.** The claimed subtotal is zero, so proration divides by a zero numerator and largest remainder has nothing to distribute. Expect every share at `$0.00`, `fullyClaimed` false, and no crash or `NaN`. [Task 1]
- **A receipt with no readable printed total.** The reconciliation gate has nothing to check against. Expect the payer to be asked for the total rather than the gate silently passing. [Task 4]
- **Two people claiming the same item at the same moment.** Expect both claims to land and the item to split between them, with neither write lost. [Task 7]
- **An expired, truncated, or tampered access token.** Expect a refusal that tells the person to tap the button again, never a partial render or a wrong identity. [Task 6]

---

### Task 1: Project scaffold and the share engine

The money arithmetic is the project's one unrecoverable failure mode, so it is built first, pure, and property-tested before any platform code exists.

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`
- Create: `src/money/types.ts`
- Create: `src/money/split.ts`
- Create: `docs/plans/2026-10-28-aazhi-core-loop.md` (this plan)
- Test: `test/money/split.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/money/types.ts
export type Cents = number;
export type ParticipantId = string;

export interface LineItem {
  id: string;
  label: string;
  cents: Cents;                 // negative for a discount or comp
  claimedBy: ParticipantId[];
}

export interface BillInput {
  items: LineItem[];
  taxCents: Cents;
  tipCents: Cents;
  payer: ParticipantId;
  participants: ParticipantId[];
  pardoned: ParticipantId[];
}

export interface Share {
  participant: ParticipantId;
  subtotalCents: Cents;         // what this person ordered
  taxCents: Cents;              // displayed tax slice
  tipCents: Cents;              // displayed tip slice, absorbs the stray cent
  owedCents: Cents;             // === subtotalCents + taxCents + tipCents
  pardoned: boolean;
}

export interface SplitResult {
  billSubtotalCents: Cents;
  distributableCents: Cents;    // billSubtotal + tax + tip
  claimedSubtotalCents: Cents;
  unclaimedCents: Cents;        // distributable share of unclaimed lines
  shares: Share[];
  payerCollectsCents: Cents;
  fullyClaimed: boolean;
}

// src/money/split.ts
export function splitBill(input: BillInput): SplitResult;
```

**Decisions the signature does not carry:**

- `owedCents` comes from largest remainder over `distributableCents`. The displayed `taxCents` is `round(taxCents * subtotal / billSubtotal)`, and `tipCents` is then `owedCents - subtotalCents - taxCents`. The stray cent lands on the tip line, which is the discretionary number, so the three displayed lines always sum to the total. **The spec guarantees the column adds up but does not say where the stray cent goes; this pins it.**
- A pardon is applied after shares are computed: the pardoned person's `owedCents` is unchanged and `pardoned` is true, and `payerCollectsCents` simply excludes them. Pardoning never redistributes.
- `payerCollectsCents` is `distributableCents` minus the payer's own `owedCents` minus every pardoned person's `owedCents`.
- Largest remainder distributes up to `round(claimedSubtotal * distributable / billSubtotal)`, not to `distributable`, so a partly claimed bill does not hand unclaimed money to claimants.
- A `billSubtotalCents` of zero returns all-zero shares rather than dividing.

- [ ] **Step 1: Scaffold the project**

`npm init`, then add `typescript`, `wrangler`, `vitest`, `@cloudflare/vitest-plugin`, `hono`, `@cloudflare/workers-types`, and `discord-api-types` (the interaction payload types every Discord task annotates against). `tsconfig.json` targets `es2022` with `"types": ["@cloudflare/workers-types"]` and `strict: true`. `wrangler.jsonc` declares `name: "aazhi"`, `main: "src/index.ts"`, a recent `compatibility_date`, and a `d1_databases` entry binding `DB` (database id filled in Task 2). `.gitignore` covers `node_modules`, `.wrangler`, `dist`, `.dev.vars`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/money/split.test.ts
import { describe, expect, it } from "vitest";
import { splitBill } from "../../src/money/split";
import type { BillInput } from "../../src/money/types";

// The Saigon Kitchen bill from the spec. Subtotal 25150, tax 2232, tip 5030,
// distributable 32412.
const SAIGON: BillInput = { /* 13 items, 8 participants, payer "gavin" */ };

it("shares sum to the distributable total", () => {
  const r = splitBill(SAIGON);
  expect(r.distributableCents).toBe(32412);
  expect(r.shares.reduce((s, x) => s + x.owedCents, 0)).toBe(32412);
});

it("tax and tip ride each person's own subtotal", () => {
  const byId = Object.fromEntries(splitBill(SAIGON).shares.map(s => [s.participant, s]));
  expect(byId.marcus.subtotalCents).toBe(3450);
  expect(byId.marcus.taxCents).toBe(306);
  expect(byId.marcus.tipCents).toBe(690);
  expect(byId.marcus.owedCents).toBe(4446);
  expect(byId.gavin.owedCents).toBe(4833);
  expect(byId.priya.owedCents).toBe(5091);
  expect(byId.lena.owedCents).toBe(3093);
});

it("a displayed share's three lines always sum to its total", () => {
  for (const s of splitBill(SAIGON).shares) {
    expect(s.subtotalCents + s.taxCents + s.tipCents).toBe(s.owedCents);
  }
});

it("splits a shared item between exactly its claimants", () => {
  // 1500 across marcus, dani, omar
  const byId = Object.fromEntries(splitBill(SAIGON).shares.map(s => [s.participant, s]));
  expect(byId.theo.subtotalCents).toBe(2650); // pho 2100 + shared 550, no tea
});

it("gives leftover cents to the lowest participant ids in a stable order", () => {
  // one 1000 item across three claimants: 334 / 333 / 333 by sorted id
  const r = splitBill(oneItem(1000, ["c", "a", "b"]));
  const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
  expect([byId.a.subtotalCents, byId.b.subtotalCents, byId.c.subtotalCents])
    .toEqual([334, 333, 333]);
});

it("is invariant under claim order", () => {
  const shuffled = shuffleClaims(SAIGON);
  expect(splitBill(shuffled).shares).toEqual(splitBill(SAIGON).shares);
});

it("does not inflate claimants when lines are unclaimed", () => {
  // the spec's draft state: iced teas and sparkling water unclaimed
  const r = splitBill(withUnclaimed(SAIGON, ["tea", "water"]));
  const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
  expect(byId.marcus.owedCents).toBe(3802);
  expect(byId.jess.owedCents).toBe(3738);
  expect(r.unclaimedCents).toBe(2706);
  expect(r.fullyClaimed).toBe(false);
});

it("handles a bill nobody has claimed yet", () => {           // Review Focus
  const r = splitBill(withUnclaimed(SAIGON, "all"));
  expect(r.claimedSubtotalCents).toBe(0);
  expect(r.fullyClaimed).toBe(false);
  expect(r.shares.every(s => s.owedCents === 0)).toBe(true);
  expect(r.shares.every(s => Number.isInteger(s.owedCents))).toBe(true);
});

it("absorbs a pardon into the payer and moves nobody else", () => {
  const base = splitBill(SAIGON);
  const r = splitBill({ ...SAIGON, pardoned: ["lena"] });
  expect(r.shares).toEqual(base.shares.map(s =>
    s.participant === "lena" ? { ...s, pardoned: true } : s));
  expect(r.payerCollectsCents).toBe(base.payerCollectsCents - 3093);
});

it("prorates a negative line item like any other", () => {
  const r = splitBill(withItem(SAIGON, { id: "comp", label: "Comped dessert", cents: -800, claimedBy: ["theo"] }));
  expect(r.shares.reduce((s, x) => s + x.owedCents, 0)).toBe(r.distributableCents);
  expect(r.shares.every(s => s.owedCents >= 0)).toBe(true);
});

it("accepts a zero tip and rejects a negative one", () => {
  expect(splitBill({ ...SAIGON, tipCents: 0 }).distributableCents).toBe(27382);
  expect(() => splitBill({ ...SAIGON, tipCents: -100 })).toThrow();
});
```

Add one property test with 1,000 generated bills (random item counts, prices, claim sets, tax, tip) asserting: shares sum to `distributableCents` when fully claimed, every share's three lines sum to its total, and the result is permutation-invariant.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/money/split.test.ts`
Expected: FAIL, `splitBill` is not defined.

- [ ] **Step 4: Implement `splitBill(input: BillInput): SplitResult` in `src/money/split.ts`**

Order of operations: per-item split into per-participant subtotals (stable sorted claimants, leftover cents to the first `r`); sum to `billSubtotalCents` and `claimedSubtotalCents`; compute `distributableCents`; largest remainder over the claimed target; derive displayed tax then tip; apply pardons; compute `payerCollectsCents`. Reject a negative `tipCents`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json wrangler.jsonc vitest.config.ts .gitignore src/money test/money docs/plans
git commit -m "feat(money): add the share engine with exact-cent proration"
```

---

### Task 2: D1 schema and the bill repository

**Files:**
- Create: `migrations/0001_initial.sql`
- Create: `src/db/bills.ts`
- Modify: `wrangler.jsonc` (fill the D1 `database_id`, add `migrations_dir`)
- Modify: `vitest.config.ts` (add `readD1Migrations` so tests get the schema)
- Create: `test/apply-migrations.ts`
- Test: `test/db/bills.test.ts`

**Interfaces:**
- Consumes: `LineItem`, `ParticipantId`, `Cents` from Task 1.
- Produces:

```ts
export type BillStatus = "reading" | "draft" | "confirmed" | "superseded" | "deleted";

export interface Participant {
  billId: string;
  id: ParticipantId;              // a Discord user id, or a generated id for a guest
  kind: "member" | "guest";
  displayName: string;
  addedBy: ParticipantId | null;  // set for a guest, whose share is owed by this member
}

export interface BillRow {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  payerId: ParticipantId;
  place: string | null;
  billDate: string | null;        // ISO date from the receipt
  taxCents: Cents;
  tipCents: Cents;
  printedTotalCents: Cents | null;
  status: BillStatus;
  revision: number;               // bumped on every mutation, for confirm's check
  createdAt: string;
  confirmedAt: string | null;
}

export function createBill(db: D1Database, b: Omit<BillRow, "revision" | "createdAt" | "confirmedAt">): Promise<BillRow>;
export function getBill(db: D1Database, id: string): Promise<BillRow | null>;
export function getBillItems(db: D1Database, billId: string): Promise<LineItem[]>;
export function getParticipants(db: D1Database, billId: string): Promise<Participant[]>;
export function openDraftInChannel(db: D1Database, channelId: string): Promise<BillRow | null>;
export function toSplitInput(db: D1Database, billId: string): Promise<BillInput>;
export function bumpRevision(db: D1Database, billId: string): Promise<number>;
```

**Decisions:**
- The spec names reopening as a lifecycle state, but a reopened bill behaves identically to a draft, so reopen sets `status` back to `"draft"` rather than adding a sixth value every query would have to treat as a draft anyway. `confirmedAt` surviving a reopen is what distinguishes a bill that was once confirmed.

Tables: `bills`, `bill_items`, `item_claims`, `participants`, `shares`, `settlements`. `participants` carries `(bill_id, id, kind, display_name)` where `kind` is `"member" | "guest"`, so a guest is a row scoped to one bill with no global identity, per the spec's non-goal. `shares` is written only at confirm, freezing the numbers. `settlements` stores an amount, not a flag, so partial payments are ordinary.

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a bill and its items into split engine input", async () => { /* createBill, insert items and claims, toSplitInput, splitBill, assert Marcus 4446 */ });
it("finds the one open draft in a channel and ignores confirmed bills", async () => { /* ... */ });
it("bumps the revision on every mutation", async () => { /* ... */ });
it("scopes a guest participant to its own bill", async () => { /* same guest name on two bills yields two unrelated rows */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/db`
Expected: FAIL, no such table.

- [ ] **Step 3: Write `migrations/0001_initial.sql` and implement `src/db/bills.ts`**

Index `item_claims(bill_item_id)`, `bill_items(bill_id)`, and `bills(channel_id, status)` so the open-draft lookup and the page render are each one indexed query.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations src/db test/db test/apply-migrations.ts wrangler.jsonc vitest.config.ts
git commit -m "feat(db): add the bill schema and repository"
```

---

### Task 3: Discord interactions endpoint

**Files:**
- Create: `src/index.ts`
- Create: `src/discord/verify.ts`
- Create: `src/discord/interactions.ts`
- Create: `scripts/register-commands.ts`
- Test: `test/discord/verify.test.ts`, `test/discord/interactions.test.ts`

**Interfaces:**
- Produces:

```ts
export function verifyRequest(rawBody: string, signature: string | null, timestamp: string | null, publicKey: string): Promise<boolean>;
export type InteractionHandler = (body: APIInteraction, env: Env, ctx: ExecutionContext) => Promise<Response>;
```

Secrets, all via `wrangler secret`: `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `ANTHROPIC_API_KEY`, `TOKEN_SIGNING_KEY`.

`scripts/register-commands.ts` registers two application commands: a `CHAT_INPUT` command `split` with a required `receipt` attachment option and two optional ones (`page_2`, `page_3`), and a `MESSAGE` command named `Split this receipt`. There is no option for naming diners: the roster fills as people open the split, per the spec.

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a request with a bad signature before parsing the body", async () => { /* expect 401, and the body parser must not have run */ });
it("rejects a request with a missing signature header", async () => { /* expect 401 */ });
it("answers Discord's PING with a PONG", async () => { /* type 1 in, { type: 1 } out */ });
it("verifies a signature produced by a known Ed25519 keypair", async () => { /* generateKey("Ed25519"), sign timestamp+body, expect true */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/discord`
Expected: FAIL.

- [ ] **Step 3: Implement verification and the interaction router**

`verifyRequest` imports the public key with `crypto.subtle.importKey("raw", hexToBytes(publicKey), "Ed25519", false, ["verify"])` and verifies over `timestamp + rawBody`. `src/index.ts` is a Hono app whose `POST /interactions` reads the raw body as text, verifies, and only then parses. Unverified requests get 401 with no body parse.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/discord scripts test/discord
git commit -m "feat(discord): verify interaction signatures and answer the handshake"
```

---

### Task 4: Receipt extraction

**Files:**
- Create: `src/extract/schema.ts`
- Create: `src/extract/claude.ts`
- Test: `test/extract/claude.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Extraction {
  place: string | null;
  billDate: string | null;
  items: { label: string; cents: Cents; confidence: number }[];
  taxCents: Cents | null;
  printedTotalCents: Cents | null;
}

export type ExtractionResult =
  | { ok: true; extraction: Extraction; reconciles: boolean; discrepancyCents: Cents | null }
  | { ok: false; reason: "unreadable" | "not-a-receipt" | "model-error" };

export function extractReceipt(imageUrls: string[], apiKey: string): Promise<ExtractionResult>;
export function reconciles(e: Extraction): { ok: boolean; discrepancyCents: Cents | null };
```

**Decisions:**
- Reconciliation is `sum(items) + tax === printedTotal`, exact, zero tolerance.
- `printedTotalCents` of `null` means the gate cannot run. `reconciles` returns `{ ok: false, discrepancyCents: null }`, which callers must surface as "enter the total" rather than treating as a pass. **The spec requires the gate but does not say what happens when the total is unreadable; this pins it.**
- Extraction calls the Messages API on `claude-haiku-5-5` with the photo as an image block and a tool whose input schema is the `Extraction` shape, so the model returns a validated tool call rather than prose to parse. On a schema violation, retry once; a second failure is `model-error`.
- Send the photo at full resolution rather than downsampling. A receipt is a dense document, which is the case the high-resolution tier exists for, and the image costs about five hundredths of a cent either way.
- Log the `usage` block from the first successful call. The plan's cost estimate assumes a receipt photo hits the 4,784 visual-token cap, and that is the one number worth confirming against reality rather than trusting.
- A response with zero items, or no monetary content, is `not-a-receipt`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reconciles a receipt whose items and tax match the printed total", () => {
  expect(reconciles({ ...SAIGON_EXTRACTION })).toEqual({ ok: true, discrepancyCents: null });
});
it("reports the exact discrepancy when a price was misread", () => {
  // 3200 read as 8200
  expect(reconciles(misread)).toEqual({ ok: false, discrepancyCents: 5000 });
});
it("refuses to pass the gate when the printed total is unreadable", () => {   // Review Focus
  expect(reconciles({ ...SAIGON_EXTRACTION, printedTotalCents: null }))
    .toEqual({ ok: false, discrepancyCents: null });
});
it("reports a photo that is not a receipt rather than inventing a bill", async () => {  // Review Focus
  // stub fetch: model returns an empty item list
  await expect(extractReceipt(["https://cdn/x.jpg"], "k"))
    .resolves.toEqual({ ok: false, reason: "not-a-receipt" });
});
it("retries once on a schema violation and then gives up", async () => { /* two bad responses -> model-error, fetch called twice */ });
it("reports a model error rather than a crash when the credit balance is empty", async () => {
  // the API returns 400 with "credit balance is too low"
  await expect(extractReceipt(["https://cdn/x.jpg"], "k"))
    .resolves.toEqual({ ok: false, reason: "model-error" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extract`
Expected: FAIL.

- [ ] **Step 3: Implement `src/extract/schema.ts` and `src/extract/claude.ts`**

Prices arrive as decimal strings in the model's JSON and become cents with a string-based parse, never `parseFloat` times 100, so `19.50` cannot become `1949`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract test/extract
git commit -m "feat(extract): read receipts and check them against the printed total"
```

---

### Task 5: `/split` creates a draft bill and posts its message

**Files:**
- Create: `src/discord/rest.ts`
- Create: `src/discord/render.ts`
- Create: `src/discord/handlers/split.ts`
- Modify: `src/discord/interactions.ts`
- Test: `test/discord/split.test.ts`, `test/discord/render.test.ts`

**Interfaces:**
- Consumes: `extractReceipt` (Task 4), `createBill` / `openDraftInChannel` (Task 2), `splitBill` (Task 1).
- Produces:

```ts
export function editBillMessage(bill: BillRow, env: Env): Promise<void>;   // coalesced
export function followUp(interactionToken: string, body: unknown, env: Env): Promise<void>;
export function ephemeral(content: string, components?: unknown[]): APIInteractionResponse;
export function renderBill(bill: BillRow, result: SplitResult, items: LineItem[], participants: Participant[]): APIInteractionResponseCallbackData;
```

**Decisions:**
- Both entry points converge on one function taking a list of image URLs, a guild, a channel, and an invoking user.
- The invoking user is the payer. Reassignment is Task 8.
- The handler responds type 5 (deferred) immediately, extracts, then edits via follow-up.
- Creating a bill supersedes any existing open draft in that channel: its status becomes `superseded`, and its message is edited to say so with its components stripped.
- `editBillMessage` coalesces: at most one edit per bill per 3 seconds, last state winning.

- [ ] **Step 1: Write the failing tests**

```ts
it("defers within the interaction deadline rather than waiting on extraction", async () => { /* response type is 5 */ });
it("creates a draft bill and posts a message with provisional amounts and no pay controls", async () => { /* ... */ });
it("supersedes an existing open draft in the same channel", async () => { /* old status superseded, components stripped */ });
it("renders the running amount for each participant and the unclaimed shortfall", () => {
  const data = renderBill(bill, splitBill(draftState), items, participants);
  expect(JSON.stringify(data)).toContain("$38.02");   // Marcus, draft
  expect(JSON.stringify(data)).toContain("$27.06");   // unclaimed
});
it("renders no pay control while the bill is a draft", () => { /* ... */ });
it("tells the payer what it misread instead of offering Confirm", async () => { /* unreconciled extraction */ });
it("coalesces rapid edits to one call per bill", async () => { /* 5 edits in 1s -> 1 fetch */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/discord/split.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the handler, the renderer, and the REST helpers**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord test/discord
git commit -m "feat(discord): turn a posted receipt into a draft bill"
```

---

### Task 6: Signed access tokens and the assignment page

**Files:**
- Create: `src/web/token.ts`
- Create: `src/web/page.ts`
- Create: `src/web/client.ts`
- Modify: `src/index.ts` (add `GET /b/:billId`)
- Modify: `src/discord/interactions.ts` (handle the `Open the split` button)
- Test: `test/web/token.test.ts`, `test/web/page.test.ts`

**Interfaces:**
- Produces:

```ts
export function mintToken(billId: string, participantId: ParticipantId, key: string, nowMs: number): Promise<string>;
export function readToken(token: string, key: string, nowMs: number): Promise<{ billId: string; participantId: ParticipantId } | null>;
export function renderPage(bill: BillRow, result: SplitResult, items: LineItem[], participants: Participant[], viewer: ParticipantId): string;
```

**Decisions:**
- Token is `base64url(payload) + "." + base64url(HMAC-SHA256(payload))`, payload `{b, p, exp}`. `readToken` returns `null` for a bad signature, a malformed token, or an expired one. It never distinguishes the three to a caller, so nothing leaks about why.
- Tapping `Open the split` mints a token for the tapping user and replies ephemerally with the URL. It also adds that user to `participants` if absent, so opening the split is how the roster fills.
- The page is server-rendered HTML with one inline script. No build step, no framework.

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a token", async () => { /* mint then read, same bill and participant */ });
it("refuses an expired token", async () => { /* exp in the past -> null */ });              // Review Focus
it("refuses a token whose payload was edited", async () => { /* flip a byte -> null */ });  // Review Focus
it("refuses a truncated token", async () => { /* drop the signature -> null */ });          // Review Focus
it("returns 403 and tells the visitor to tap the button again", async () => { /* ... */ });
it("adds the tapping user to the roster", async () => { /* ... */ });
it("renders every line item and a chip per participant", () => { /* ... */ });
it("marks the viewer so the page knows whose chip is editable", () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web`
Expected: FAIL.

- [ ] **Step 3: Implement tokens, the route, the button handler, and the renderer**

HMAC via `crypto.subtle.importKey("raw", ..., { name: "HMAC", hash: "SHA-256" }, ...)`. Compare signatures with a constant-time comparison, not `===`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web src/index.ts test/web
git commit -m "feat(web): serve the assignment page behind a signed per-person link"
```

---

### Task 7: Claiming and editing

**Files:**
- Create: `src/web/api.ts`
- Modify: `src/web/client.ts`
- Modify: `src/index.ts`
- Test: `test/web/api.test.ts`

**Interfaces:**
- Produces: `POST /b/:billId/claim`, `POST /b/:billId/item`, `PATCH /b/:billId`, each taking the token as a bearer header and returning the recomputed `SplitResult` so the page re-renders from one response.

**Decisions:**
- Claims are per-row upserts into `item_claims`, never a whole-bill write, so simultaneous claims cannot clobber each other.
- Permissions: the payer may claim for anyone and may edit items, tax, tip, and pardons. Everyone else may only add or remove themselves, and only on a bill in `draft`. Any write to a non-draft bill is refused.
- Every successful write bumps the bill revision and triggers a coalesced Discord message edit.

- [ ] **Step 1: Write the failing tests**

```ts
it("lets a participant add and remove only themselves", async () => { /* self ok, other -> 403 */ });
it("lets the payer claim on anyone's behalf", async () => { /* ... */ });
it("keeps both claims when two people claim one item at once", async () => {  // Review Focus
  await Promise.all([claim(marcusToken, "noodles"), claim(daniToken, "noodles")]);
  const item = (await getBillItems(db, billId)).find(i => i.id === "noodles")!;
  expect(item.claimedBy.sort()).toEqual(["dani", "marcus"]);
});
it("refuses any write to a confirmed bill", async () => { /* 409 */ });
it("lets the payer correct a misread price and reconcile the bill", async () => { /* 8200 -> 3200, reconciles true */ });
it("lets the payer add a missed line and delete a hallucinated one", async () => { /* ... */ });
it("refuses a non-payer editing a price", async () => { /* 403 */ });
it("lets the payer enter the tip as a dollar amount", async () => { /* 5030 -> distributable 32412 */ });
it("converts a tip percentage against the pre-tax subtotal", async () => {
  await patch(payerToken, { tipPercent: 20 });
  expect((await getBill(db, billId))!.tipCents).toBe(5030);   // 20% of 25150, not of 27382
});
it("returns the recomputed shares with every write", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web/api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the API and wire the page's script to it**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web test/web
git commit -m "feat(web): claim items and correct the bill from the page"
```

---

### Task 8: Confirm, reopen, delete

**Files:**
- Create: `src/discord/handlers/lifecycle.ts`
- Modify: `src/discord/interactions.ts`, `src/db/bills.ts`
- Test: `test/discord/lifecycle.test.ts`

**Interfaces:**
- Produces:

```ts
export function confirmBill(db: D1Database, billId: string, revision: number): Promise<{ ok: true } | { ok: false; reason: "stale" | "unreconciled" | "not-payer" | "not-draft" }>;
export function reopenBill(db: D1Database, billId: string): Promise<AmountChange[]>;
export function deleteBill(db: D1Database, billId: string): Promise<void>;
export function splitOrphansEvenly(db: D1Database, billId: string): Promise<void>;
export function reassignPayer(db: D1Database, billId: string, to: ParticipantId): Promise<void>;

export interface AmountChange { participant: ParticipantId; wasCents: Cents; nowCents: Cents; settledCents: Cents; }
```

**Decisions:**
- `confirmBill` takes the revision the payer's view was built from and returns `stale` if the bill changed in between, so a concurrent edit cannot slip past the reconciliation gate.
- Confirm is hard-gated on reconciliation and soft-gated on full claiming: with orphans, the payer is offered `splitOrphansEvenly` first.
- Confirm materialises `shares`, freezing the numbers.
- `reopenBill` returns the amount changes for anyone who has already settled, so the caller can state them out loud. It never adjusts quietly.
- Delete against a bill with settlements requires a second confirmation naming the amount discarded.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses to confirm a bill that does not reconcile", async () => { /* unreconciled */ });
it("refuses to confirm when the bill changed since the payer's view", async () => { /* stale */ });
it("refuses to confirm for anyone but the payer", async () => { /* not-payer */ });
it("freezes the shares at confirm", async () => { /* shares rows match splitBill, later item edits do not move them */ });
it("offers to split orphan lines evenly and then confirms", async () => { /* 2 orphans -> all claimed -> ok */ });
it("reports every amount change when reopening a bill someone paid", async () => {
  expect(await reopenBill(db, billId)).toEqual([
    { participant: "marcus", wasCents: 4446, nowCents: 4110, settledCents: 4446 },
  ]);
});
it("keeps claims intact across a reopen", async () => { /* ... */ });
it("requires a second confirmation to delete a bill with settlements", async () => { /* ... */ });
it("reassigns the payer to another member of the roster", async () => {
  // somebody else's card went down, so the invoker is not the payer
  await reassignPayer(db, billId, "priya");
  const r = splitBill(await toSplitInput(db, billId));
  expect(r.payerCollectsCents).toBe(32412 - 5091);
});
it("refuses to reassign the payer to someone off the roster", async () => { /* throws */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/discord/lifecycle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the lifecycle transitions**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord src/db test/discord
git commit -m "feat(discord): freeze a bill on confirm and unfreeze it on reopen"
```

---

### Task 9: The owe card

**Files:**
- Modify: `src/discord/render.ts`
- Create: `src/discord/handlers/owe.ts`
- Create: `src/web/paylink.ts`
- Create: `migrations/0002_payment_handles.sql`
- Test: `test/discord/owe.test.ts`, `test/web/paylink.test.ts`

**Interfaces:**
- Produces:

```ts
export function payLink(method: "venmo" | "cashapp" | "zelle", handle: string, cents: Cents, note: string): { url: string } | { instructions: string };
export function renderMath(share: Share, items: LineItem[], bill: BillRow): string;
```

**Decisions:**
- Confirmed bills render each participant as a mention with their frozen amount and a one-line item summary, plus `Pay my share`, `Show my math`, and `That's not mine`, and payer-only `Reopen` and `Delete`.
- `Show my math` is ephemeral: the person's items, their displayed tax and tip slices, and the fraction used.
- `That's not mine` calls `reopenBill`, so pay controls vanish for everyone, and posts who flagged it.
- Zelle returns instructions, not a URL, because the network is closed to third parties.
- The handle comes from a `payment_handles` table keyed on Discord user id, holding one row per method. The payer sets theirs once with a `/paywith` command and it is reused on every later bill. **The spec leaves the diner-to-handle mapping to the builder; this is that call.** A payer with no handle on file gets a `Pay my share` button that asks them to set one, rather than a dead link.

- [ ] **Step 1: Write the failing tests**

```ts
it("renders frozen amounts and pay controls once confirmed", () => { /* contains $44.46 and Pay my share */ });
it("shows a person's math adding exactly to their total", () => {
  const text = renderMath(marcusShare, items, bill);
  expect(text).toContain("$34.50");
  expect(text).toContain("$3.06");
  expect(text).toContain("$6.90");
  expect(text).toContain("$44.46");
});
it("prefills a Venmo link with the amount and note", () => { /* ... */ });
it("gives instructions rather than a link for Zelle", () => { /* ... */ });
it("asks the payer to set a handle instead of rendering a dead link", () => { /* no row on file */ });
it("reuses a handle set on an earlier bill", async () => { /* ... */ });
it("darkens pay controls for everyone when one person objects", async () => { /* status back to draft */ });
it("names who objected in the channel", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/discord/owe.test.ts test/web/paylink.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the owe card, the math view, and pay links**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord src/web test
git commit -m "feat(discord): post the owe card with pay, math, and objection controls"
```

---

### Task 10: Settlement and the ledger

**Files:**
- Create: `src/db/settlements.ts`
- Create: `src/discord/handlers/settle.ts`
- Modify: `src/discord/interactions.ts`
- Test: `test/db/settlements.test.ts`

**Interfaces:**
- Produces:

```ts
export function recordSettlement(db: D1Database, billId: string, participantId: ParticipantId, cents: Cents, recordedBy: ParticipantId): Promise<void>;
export function undoSettlement(db: D1Database, settlementId: string): Promise<void>;
export function outstanding(db: D1Database, billId: string): Promise<{ participant: ParticipantId; owedCents: Cents; settledCents: Cents }[]>;
export function ledger(db: D1Database, payerId: ParticipantId, guildId?: string): Promise<LedgerRow[]>;

export interface LedgerRow {
  participant: ParticipantId;
  displayName: string;
  owedCents: Cents;      // across bills, after pardons
  settledCents: Cents;
  billCount: number;
}
```

**Decisions:**
- A share is clear when its settlements sum to its owed amount. Partial payments are ordinary.
- A payee records their own payment; the payer can undo any of them.
- `ledger` without `guildId` rolls up across every server, with it scopes to one, because a debt belongs to a bill and a bill belongs to a group.
- Settling posts a short follow-up naming who paid and what remains. It does not edit the owe card, so the frozen message stays the record.

- [ ] **Step 1: Write the failing tests**

```ts
it("clears a share when settlements reach the owed amount", async () => { /* ... */ });
it("tracks a partial payment against the remainder", async () => { /* 4000 of 4446 -> 446 left, not clear */ });
it("lets the payer undo a settlement", async () => { /* ... */ });
it("refuses a settlement recorded for someone else by a non-payer", async () => { /* ... */ });
it("rolls the ledger up across servers and scopes it to one", async () => { /* two guilds, both views */ });
it("excludes a pardoned share from what the payer is owed", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/db/settlements.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement settlement recording and the ledger queries**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db src/discord test/db
git commit -m "feat(settle): record payments and report who still owes"
```

---

### Task 11: Guests, pardons, and deployment

**Files:**
- Modify: `src/web/api.ts`, `src/web/client.ts`, `src/web/page.ts`, `src/discord/render.ts`
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md` (setup and deploy steps)
- Test: `test/web/guests.test.ts`

**Interfaces:**
- Produces: `POST /b/:billId/guest` and `POST /b/:billId/pardon`, both payer-only.

**Decisions:**
- A guest is a `participants` row with `kind: "guest"` and no Discord id, scoped to that bill, appearing in no cross-bill query.
- A guest cannot tap anything, so their share is owed by the member who added them. `added_by` carries that, and the owe card renders the pair as one amount against that member.
- Deployment is Wrangler from GitHub Actions on push to the default branch.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds a guest scoped to one bill with no global identity", async () => { /* ... */ });
it("bills a guest's share to the member who added them", async () => {
  // Dani adds Sam, Sam claims a 2000 item
  const card = renderBill(/* ... */);
  expect(JSON.stringify(card)).toContain("Dani, including Sam");
});
it("refuses a non-payer adding a guest", async () => { /* 403 */ });
it("absorbs a pardon into the payer without moving anyone else", async () => { /* ... */ });
it("refuses a pardon on a draft bill", async () => { /* pardons apply to confirmed amounts */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web/guests.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement guests, pardons, and the deploy workflow**

- [ ] **Step 4: Run the whole suite and a typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src .github README.md test
git commit -m "feat: support guest diners and pardons, and deploy from CI"
```

---

## Deferred to a later plan

- **Statistics.** Times two people have eaten together, who fronts most often, median time to settle, most-ordered item, favourite restaurant, pardons given and received. Every row these need is written from Task 2 onward, so this is a query-and-render plan with no schema change.
- **Automatic settlement from bank notification emails.** The spec's own deferral. Settlements are already a separate record from shares, so this adds a new way to create one.
