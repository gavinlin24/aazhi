# Why this stack

Every choice here is downstream of two requirements that fight each other:
the bot must cost nothing to run, forever, and it must answer Discord
within three seconds. That pair eliminated most of the obvious options
before any preference came into it.

It very nearly holds. Hosting, storage, and the web page are free with no
expiry and no sleeping. The one component that charges anything is reading
the receipt photo, at about a tenth of a cent each, which works out to
about a dime a year at the volume one group of friends generates.

## The decision that set all the others

Discord offers two ways for a bot to exist.

**A gateway bot** holds an open WebSocket to Discord and receives events as
they happen. This is what almost every Discord bot tutorial builds, and it
is the only way to notice a photo somebody drops into a channel
unprompted. It needs the `MESSAGE_CONTENT` privileged intent, and more
importantly it needs a process that is always running.

**An HTTP interactions bot** has no connection to Discord at all. Discord
holds a URL, and when a user explicitly invokes the bot, Discord makes a
signed HTTPS request to that URL and waits for the reply. Nothing runs in
between.

The first option is the nicer product: photograph the receipt, drop it in
the chat, done. It is also incompatible with free hosting. An always-on
process has to live somewhere, and free tiers that host a long-running
process either idle it out after a few minutes or have stopped being free.
Idling is the fatal part, not the cost: the first interaction after a quiet
evening pays the wake-up, and Discord's three-second deadline does not
care why you were slow.

So the product was redesigned around the constraint rather than the
constraint being argued with. `/split` takes the photo as a command
attachment, and Discord's **message context menu** covers the rest: right
click a message that already has photos in it, pick "Split this receipt,"
and Discord hands the bot the entire message including its attachments.
That works without any privileged intent, because the user explicitly
invoked the bot on that specific message. One extra click buys a stack
with no server in it.

One correction worth stating, because the usual version of this story is
wrong: `MESSAGE_CONTENT` is not hard to obtain. Discord grants it by a
toggle in the developer portal until an app reaches 10,000 users, at which
point you apply. The blocker was never Discord's permission. It was the
always-on process the gateway requires.

## Compute: Cloudflare Workers

Chosen for one property the alternatives do not have: **nothing idles.** A
Worker has no cold start to pay, so the three-second deadline is never at
risk, including on the first request in a week.

The free plan allows 100,000 requests a day and 10 ms of CPU time per
request. The CPU ceiling sounds alarming and is not, because waiting is
not CPU: a `fetch` to the vision model, a D1 query, a call back to
Discord's API all cost wall-clock time and no CPU. What actually runs on
the CPU here is an Ed25519 signature check, some integer arithmetic, and
string building. Ten milliseconds is a large budget for that.

Rejected:

- **Vercel and Netlify functions.** Cold starts on the free tier, against a
  three-second deadline.
- **Fly.io, Railway, Render.** Either they sleep an idle service or the
  free tier is gone. Both break the requirement.
- **AWS Lambda.** The free allowance genuinely is permanent and generous,
  but it needs API Gateway in front of it, has cold starts, and brings an
  AWS account's worth of surface area to maintain for a bot that splits
  dinner.
- **A small VPS.** Not free, and now you patch a server.

## Storage: Cloudflare D1

D1 is SQLite on the same account and the same deploy as the Worker. One
vendor, one `wrangler deploy`, one place for things to go wrong.

The data is relational and the relationships are the entire product.
`item_claims` is a many-to-many between line items and people, and nearly
every question the bot answers is a join over it: what does this person
owe, who has not paid, how often have these two eaten together. A
key-value store would mean maintaining those indexes by hand.

Free limits and what they mean at this size: 5 GB across the account and
500 MB per database, 5 million row reads and 100,000 row writes a day. A
confirmed eight-person bill with thirteen items is roughly 25 rows, so the
write budget is thousands of dinners a day.

One free-plan limit does constrain the design: **50 queries per Worker
invocation.** Rendering a bill must be a handful of queries with joins, not
a query per line item and another per person. That is good practice
anyway; here it is enforced.

Rejected:

- **Supabase or Neon.** Both are Postgres, which is more database than this
  needs, and both free tiers pause or expire an idle project. That is the
  same idling problem one layer down.
- **Workers KV.** No joins, and the claims table is the product.
- **Durable Objects.** Genuinely the right tool for coordinating concurrent
  edits to one bill, and worth revisiting if simultaneous claiming turns
  out to be messier than per-row upserts handle. Not worth the complexity
  on day one.

## Receipt extraction: Claude Haiku 5.5

Reading a photographed receipt is the one job here that needs a model, and
it is a narrow job: find the line items, find the tax, find the printed
total, return JSON. Not reasoning, not conversation. Extraction.

**Claude Haiku 5.5 on the Anthropic API**, which is the cheapest model in
the current lineup and the one described for exactly this: "high-volume,
latency-sensitive tasks such as classification, extraction, and routing."
It takes image input, and at $0.10 per million input tokens and $0.50 per
million output it is close to free per call.

What one receipt actually costs. Claude bills images as visual tokens, one
per 28x28 pixel patch, capped per model. Haiku 5.5 is on the
high-resolution tier, so a phone photo is scaled to the 4,784-token cap:

| | tokens | cost |
|---|---|---|
| receipt photo | 4,784 | $0.000478 |
| prompt and schema | ~500 | $0.000050 |
| JSON for 13 items | ~600 | $0.000300 |
| **per receipt** | | **$0.00083** |

A tenth of a cent. A single dollar buys about 1,200 receipts. Ten dinners
a month costs under a cent a month, so about a dime a year.

High resolution is worth keeping rather than downsampling to cut the image
cost by two thirds: a crumpled thermal receipt is a dense document, which
is precisely the case the extra fidelity exists for.

Three reasons this beats the alternatives considered.

- **Quality is the highest of the options.** Extraction accuracy is not a
  correctness issue here (see below), but it is a friction issue: every
  misread line is somebody fixing a number by hand. This is the axis worth
  paying for, and the payment is a tenth of a cent.
- **The content is not trained on.** Under Anthropic's commercial terms,
  API inputs and outputs are not used for model training by default. A
  receipt carries the restaurant, the date, the time, often a server's
  name, and sometimes the last digits of a card. Google's Gemini free tier
  is the opposite by design: its pricing table says free-tier content is
  "used to improve our products," and its terms add that "human reviewers
  may read, annotate, and process your API input and output." Paid Gemini
  is exempt, which makes the Gemini decision "pay, or be the training
  data."
- **The cost is already covered.** Claude Max subscriptions include
  monthly API credits, $100 on Max 5x and $200 on Max 20x, which expire at
  the end of each billing cycle with no rollover. At a tenth of a cent per
  receipt, the smaller allowance covers about 120,000 receipts a month.

Rejected:

- **Gemini free tier.** Genuinely free of charge on Flash models, so cost
  was never the objection. Two things were: the quota is no longer
  published anywhere in the documentation (the rate-limits page now sends
  you to your own AI Studio dashboard), and free-tier content is used for
  training with human review. The quota mattered less than it first
  appears at a few receipts a week; the data term did not shrink with
  volume.
- **Cloudflare Workers AI.** Attractive for keeping one vendor and letting
  the photo never leave Cloudflare, on a published 10,000 Neuron daily
  allowance. Rejected on quality: Moondream 3 and Gemma 4 list OCR, but an
  open 9B model reads a crumpled thermal receipt less well than Haiku
  does, and the saving over Haiku is a tenth of a cent.
- **Self-hosted OCR, Tesseract compiled to WASM.** Free forever with no
  external call at all, and the only option that keeps the photo entirely
  in-process. Two blockers: classical OCR returns text, not structure, so
  the item-and-price parsing problem remains unsolved, and the Workers free
  plan's 10 ms CPU limit is a hard ceiling that WASM OCR would blow
  through, since unlike a network call that work is genuinely CPU.

**Extraction still sits behind one function**, `extractReceipt`, that the
rest of the code never looks past, because it is the only component whose
choice rests on somebody else's pricing rather than a structural property.
Swapping providers should stay a one-file change, and the cost of keeping
it that way is one interface.

### Why a weaker model would not have broken anything

Worth stating, because it is the load-bearing part of the design and it is
easy to mistake for optimism about the model.

A receipt prints its own total. The extracted line items plus the
extracted tax are reconciled against that printed total before a bill can
be confirmed, and they have to match to the cent. A misread price
therefore produces a visible "this does not add up, fix this line" rather
than a wrong number that quietly becomes somebody's debt.

So extraction quality buys fewer corrections. It does not buy correctness.
Correctness comes from the gate, which is why the model choice here is a
convenience decision rather than a risk decision, and why a tenth of a
cent is the right amount to spend on it.

## No image storage

Discord already hosts the attachment, so the bot fetches it at extraction
time and persists only the parsed line items. This removes a storage
dependency entirely and means a pile of receipt photographs is not
accumulating anywhere. It is also forced: Discord attachment URLs are
signed and expire, so an URL stored for later would not work later.

## Language and router: TypeScript and Hono

TypeScript earns its place on one specific class of bug. Money here is
integer cents in a named type, and a function that takes `Cents` will not
silently accept a dollars-and-decimals float. The bug this project most
needs to not have is an arithmetic one, and the type system is free
enforcement.

Hono is a 14 kB router built for Workers, with no Node polyfills and no
build step beyond what Wrangler already does. Workers gives you a single
`fetch` handler and no routing; this project needs three routes and the
alternative is hand-rolling a worse router. Rejected: Express, which needs
Node compatibility shims to run here at all, and that is the whole reason
to not use it.

## Testing: Vitest with @cloudflare/vitest-plugin

Two deliberately different testing strategies, split on the same line the
code is split on.

**The money engine is pure.** `splitBill` takes a bill and returns shares,
touching no platform API, so it tests in plain Vitest with no runtime
involved and runs in milliseconds. That is why it is built first and
separately: the most important code in the project has the cheapest,
fastest tests, so there is no excuse for it to be under-tested. It gets
property tests over a thousand randomly generated bills on top of the
specific cases.

**Everything touching D1 runs against real D1.** `@cloudflare/vitest-plugin`
executes tests inside workerd, the actual Workers runtime, and
`applyD1Migrations` loads the real schema into a real database per test.
The alternative, a mocked SQL layer, is the standard way to ship a query
that passes every test and fails in production, because the mock agrees
with whatever you wrote.

## Where this breaks

Useful to know the ceiling rather than discover it.

The binding limit is **D1 row writes** at 100,000 a day. A confirmed
eight-person bill is roughly 25 rows, so that is around 4,000 bills a day.
**Workers requests** at 100,000 a day comes next, and a bill costs a few
dozen requests across its entire life, so the two run out at a similar
point. Nothing else is close.

Extraction is no longer one of the ceilings, which is the useful thing
about having priced it: it scales with money rather than with a quota, and
the money is negligible. It is the component that would survive going
viral; the database is the one that would not.

For a group of friends, every limit here is three or four orders of
magnitude away. If this ever did outgrow them, the Workers paid plan is $5
a month and raises all of them by orders of magnitude, and **no
architectural change is required to get there.** That is the real argument
for this stack: the free version and the version that scales are the same
program.
