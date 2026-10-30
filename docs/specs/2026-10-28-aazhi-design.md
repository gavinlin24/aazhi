# AAzhi: design

A Discord bot that splits a restaurant bill from a photo of the receipt.

Date: 2026-10-28
Status: design complete, ready to plan

## Intent and why

Eight friends go out. One person's card covers the whole bill. Today the
rest of that evening is unpaid labour for whoever paid: dividing the
receipt, working out that the person who ordered the $45 steak owes more
tax than the person who ordered the $12 soup, posting eight numbers in a
group chat, then remembering for the next two weeks who still hasn't
sent anything.

This bot removes all of that. The payer photographs the receipt, runs one
command in the Discord server the group already lives in, everyone taps
the items they ordered, and the bot produces exact amounts and keeps score
until the debt clears.

Two further intents shape the design and should not be traded away:

- **It has to be good enough to still be in use in a year.** This is not a
  demo. Friction anywhere in the common path is a defect.
- **It has to be free to host, permanently.** No subscription, no server to
  keep alive, no component whose death is discovered at the table. Reading a
  receipt is the one paid call, at about $0.00083 each.

A third, secondary intent: the author wants to be able to explain this
project in a job interview. That argues for correctness being provable
rather than approximate, and for the hard parts (receipt extraction,
exact money arithmetic, multi-user state) being solved properly rather
than hand-waved.

## Goals

1. The payer never does arithmetic.
2. Every diner's amount accounts for what that person ordered, including
   their proportional share of tax and tip.
3. Nobody creates an account, installs anything, or logs in.
4. Shared plates split between exactly the people who shared them.
5. The payer can forgive someone's share.
6. The payer can see at a glance who still owes them money.
7. Mistakes, whether the vision model's or a person's, are cheap to fix
   and impossible to miss.
8. Running totals and group statistics accumulate from the first bill
   onward.

## Non-goals

- **Moving money.** The bot tells people what to send and to whom, and
  records that it arrived. Funds never pass through this system. Zelle has
  no third-party API (the network is operated by Early Warning Services
  and is closed by design), Venmo's developer API has been shut to new
  entrants since 2016, and routing friends' money through a card processor
  would add per-transaction fees and money-transmitter exposure to a
  friend-group utility.
- **Automatic settlement detection, in version one.** The design keeps the
  door open for it (see "Deferred") but version one settles with a tap.
- **Non-restaurant expenses.** Rent, utilities, trips. The whole design
  assumes a printed itemised receipt.
- **Currencies other than USD.**
- **Any durable record of a guest diner.** Guests are supported, but they
  are a label on one bill and nothing more. See "Guests" below.

## Anti-goals

Things that would make this a failure even if it technically worked:

- **A bill that doesn't reconcile.** If the eight shares don't add up to
  the printed total plus the tip, to the penny, the system has lied about
  money to people who trust each other. This is the one unrecoverable
  failure.
- **A silent amount change.** Any adjustment to what someone owes after
  they've been told a number must be stated out loud, never quietly
  applied.
- **Needing a quorum.** No flow may block on all eight people responding.
  One unresponsive friend must never be able to stall a bill.
- **Anything to maintain.** A component that needs babysitting, restarting,
  or paying for will eventually be left to rot, and the project dies.
- **A chat full of bot noise.** One message per bill.

## Constraints

- **Free tier, permanently, for everything but receipt reading.** Compute,
  database, and the page have to sit inside free allowances at friend-group
  volume. Receipt reading is paid per call, at about $0.00083 a receipt.
- **Discord's interaction model.** A bot that reads messages posted in a
  channel needs a permanently open socket plus the privileged Message
  Content intent. That means an always-on process, which conflicts with
  the free-and-unmaintained constraint. The bot is therefore
  **interaction-only**: it wakes when deliberately invoked and holds no
  persistent connection. It requires no privileged intents.
- **Discord's three-second deadline.** An interaction must be acknowledged
  within three seconds. Receipt reading takes longer, so every scan
  defers immediately and completes through the follow-up webhook, which
  allows fifteen minutes.
- **Vision model accuracy.** The extraction will sometimes be wrong. The
  design treats this as expected, not exceptional, and makes correction a
  first-class flow.

## How it works

### Entry

Two entry points, sharing one code path, because Discord's two mechanisms
have opposite strengths and the cheap answer is to support both.

**`/split` with the photo attached.** Discord's attachment picker is part
of the command, so this is one action, not two. This is the path for the
common case, which is a receipt that fits in one photograph.

A Discord slash command accepts **one file per named option**, not a
multi-select, so a three-page receipt would need three named slots on the
command, which clutters it on a phone for the single-photo case that
dominates. `/split` therefore exposes a primary `receipt` option plus two
optional extra slots, and no more.

**The message command, for multi-page receipts.** Send all the photographs
in one ordinary Discord message, which accepts up to ten attachments,
then long-press that message and pick **Split this receipt**. The bot
receives the whole message including every attachment. This path exists
because it is a precise fit for the rule below: one message's photos, one
bill, no limits to juggle.

Neither path needs a privileged intent. A message context menu command
delivers the full message object to the app without the Message Content
intent, precisely because the user explicitly handed that message over.

**Only photos attached to one invocation belong to that bill.** There
is no merging of later photos into an existing bill, no inference from
timing, no "is this the same receipt?" prompt. If the payer attaches two
of three pages, they re-run `/split` with all three. The earlier session
is superseded (see below). This was chosen over multi-message merging
deliberately: every inference rule for merging is silently wrong in some
real case, and a silently wrong bill is an anti-goal.

### Session lifecycle

A bill is a **session**, and it is a draft until the payer confirms it.
The bot posts exactly one message per session and edits that message in
place as the state changes.

**1. Reading.** The message says the receipt is being read. The bot fetches
the attachments, sends them to the vision model, and extracts line items,
subtotal, tax, and the printed total.

**2. Draft.** The message shows the extracted line items, who has claimed
what, and **what each person currently owes**. It updates in place as
claims and corrections come in. There are no pay controls in this state.
It carries an **Open the split** button and, once eligible, a **Confirm**
button that only the payer can use.

Showing live amounts during the draft is load-bearing. Nobody can tell
whether a bill looks right without seeing their own number, so the numbers
must precede confirmation, not follow it.

**3. Confirmed.** The payer confirms. Amounts lock, the message becomes the
owe card, and pay controls appear. This is the only state in which anyone
is asked for money.

**Superseded.** A new `/split` in the same channel supersedes any
unconfirmed draft by the same payer there. The bot edits the old message
to say so and strips its buttons, so nobody claims items on a session
that will never be confirmed. At most one open draft exists per payer per
channel at a time; two payers' drafts sit side by side.

**Reopened.** The payer can return a confirmed bill to draft with all
claims intact, correct whatever was wrong, and confirm again. This is the
primary repair tool, because deleting a bill over one misread digit makes
eight people redo their work.

**Deleted.** The payer can delete a bill outright, for an extraction so bad
it isn't worth repairing.

### Access: how the link knows who you are

The bot posts a **button**, never a link. A link in a channel can be used
by anyone who can see the channel and cannot tell who opened it.

When someone taps **Open the split**, Discord's interaction payload
identifies the tapper. The bot replies with an ephemeral message, visible
only to that person, containing a URL carrying a signed token bound to
`(bill id, person id, expiry)`. The page therefore knows who the visitor
is without any login, and the identity is attested by Discord rather than
self-asserted. Tokens are short-lived (30 minutes, re-obtainable by
tapping the button again) and stateless, so the database stores no session
rows.

No diner ever creates an account or enters a password.

### The assignment page

The whole bill on one screen. Each line item is a row; each row carries a
chip per diner.

**Who the chips are.** The bot has no roster of who was there and must
not ask the payer to build one as a gate. So: the chips are everyone who
has opened the split, seeded optionally by the payer. `/split` carries an
optional member picker for "who was there", which lets the payer do
the whole bill themselves at the table; leaving it empty is fine, because
anyone who opens the split is added to the roster by that act, and the
payer can add a server member from the page at any time. A server with
fifty members never renders fifty chips.

Tapping a chip assigns that line to that person; tapping
two chips splits that line between exactly those two. Even-splitting the
whole bill is just "every chip on every row," so there is no separate
mode to learn and no distinction in the data model between a personal
item and a shared one.

Rows with nobody on them are visibly flagged. Per-person totals, the bill
total, tax and tip sit on the same screen and move as the page is used.

**Permissions.**

- The payer may touch any row, and may edit the bill itself: correct an
  item's name or price, add a line the model missed, delete a line it
  hallucinated, and adjust tax and tip.
- Everyone else may add or remove **only themselves**, on any row, and may
  keep editing freely for as long as the bill is a draft.

This resolves a tension that ran through the whole design conversation.
Self-claiming is more accurate, because each person knows what they
ordered; payer-assignment is faster, because it doesn't wait on eight
people. Both are the same screen with different permissions, so the payer
can do the lot at the table when people are slow and otherwise let them
claim for themselves.

Pay controls never appear on this page. Its only job is making the bill
true.

### Guests

A party of eight will sometimes include somebody's partner who has no
account in the server. Anyone on the bill can add a guest by typing a
name, and that name gets a chip like anyone else.

**A guest is a label on one bill and nothing more.** No person row, no
cross-bill identity, no history, no appearance in any statistic. Two
guests called Sam on two different bills are unrelated, and the bot never
tries to connect them.

A guest cannot tap anything, so **whoever adds a guest answers for them**.
Nobody is asked who the guest came with: the person who typed the name taps
the guest onto what they had, can rename or remove them while the bill is a
draft, and is who the guest settles up with. Their share is owed by that
member, and the owe card names it that way ("Dani, including Sam: $71.40")
so there is always a real account to collect from and no row in the ledger
with nobody behind it. The payer can tidy up any guest too.

A guest the payer adds simply owes the payer. They get their own row on the
owe card ("Kim (guest)") and in the payer's `/ledger`, and the payer can
forgive them like anyone else.

Once the bill is confirmed, a guest can be marked paid in two ways, told
apart by who marks it:

- **The payer:** the guest paid the payer directly. That is recorded as a
  payment for the guest's whole share, so it comes off what the member who
  added them owes, and the channel is told like any payment.
- **The member who added them:** the guest paid that member back. That is
  bookkeeping between the two of them; the member still owes the payer the
  guest's share.

### Correctness: the receipt proves its own read

A receipt prints its own total, which makes the extraction self-checking.
The bot sums its extracted line items, adds its extracted tax, and
compares against the extracted printed total.

**If those do not reconcile exactly, Confirm is unavailable.** The draft
message says so in concrete terms, names the discrepancy, and points at
the lines the model was least confident about. The payer fixes the lines
until the arithmetic closes.

This is a stronger guarantee than eight people eyeballing a photo, it is
automatic, and it costs nothing, because the restaurant already did the
arithmetic. It also means the vision model never has to be perfect, which
it will not be.

Receipts carrying a service charge, a comp, or a discount get those as
ordinary line items, positive or negative, prorated like anything else.

### Confirming

The payer taps **Confirm**. Two gates:

- **The arithmetic must reconcile** (above). Hard gate.
- **Every line must be claimed.** Soft gate: Confirm stays available with
  lines unclaimed, and tapping it offers to split the orphans evenly
  among everyone who claimed anything. Requiring every diner to respond
  would let one unresponsive person stall the bill, which is an
  anti-goal.

On confirm, shares are computed and frozen, the message becomes the owe
card, and pay controls appear.

### The owe card

The message everyone actually reads, so it carries the weight: each
person mentioned with their amount and a one-line summary of what it
covers, with the payer named as the person to pay.

Per-person controls:

- **Pay my share.** Opens Venmo with the amount and note prefilled when the
  payer has linked a Venmo username. Venmo is the only pay app. Without one,
  the person pays however they normally would and taps "I paid".
- **Show my math.** The person's items, their slice of tax, their slice of
  tip, and the arithmetic that produced the number. People can only judge
  whether a bill is right if they can see why.
- **That's not mine.** The bot read the line correctly but a human
  assigned it wrong: Theo has been charged for Jess's drink. Tapping this
  returns the bill to draft, which darkens pay controls for everyone and
  marks the amounts provisional again while leaving every claim intact.
  The bot says in the channel who flagged it and that payment is paused
  until the payer confirms again. One person's objection freezes payment
  and no group approval is ever required, because nobody should be able to
  pay into a bill somebody knows is wrong, and waiting on eight people is
  how a tool gets abandoned.

### Settling

The payee taps to mark their own payment. This trusts the friend group,
which is the right default here: the alternative, the payer confirming
each payment individually, puts them back to doing bookkeeping, which is
the problem this project exists to solve. The payer can undo any
settlement.

Paid is yes or no. Tapping I paid records the whole remaining balance, and
the payer's undo takes the whole of it back.

A confirmed bill stays open until its debts clear. Nothing expires.

### When a reopened bill changes someone's amount

If someone has already paid and their amount then changes, the bot says
so explicitly: "Marcus paid $44.46 and now owes $41.10, so you owe him
$3.36." Deleting a bill against which payments exist requires a stronger
confirmation naming what is being discarded. Silent money changes are an
anti-goal.

### Pardons

The payer can waive any diner's share. The pardon is applied **after**
shares are computed, so the payer absorbs it out of their own pocket and
nobody else's share moves. Pardoning is a gift from the payer, not a
redistribution across the table. Because it is that payer's gift, handing
a reopened bill to a different payer clears every pardon; the new payer
forgives only what they choose to.

## The money arithmetic

This is the part that has to be exactly right, so it is specified rather
than left to the builder.

**All money is integer cents throughout.** No floating-point value ever
holds an amount. Prices enter as cents at extraction time.

**Splitting one line item across `n` claimants.** `base = floor(cents / n)`;
`r = cents - base * n`; the `r` leftover cents go one each to the first
`r` claimants in a **stable order** (ascending person id). Stable order
matters: ordering by click sequence makes pennies move when the page
re-renders.

**Per-person subtotal** is the sum of their line-item shares.

**Bill subtotal** is the sum of all line items, claimed or not.

**Distributable total** is bill subtotal + tax + tip (service charges and
discounts are line items and so are already in the subtotal).

**Tip** is entered by the payer as a **dollar amount**, because that is what
they actually wrote on the slip and it is the only value guaranteed to
match their card statement. A percent field is offered as a convenience
that computes against the pre-tax subtotal, which is the ordinary
convention; it writes a dollar amount and then gets out of the way.

**Proration.** Tax and tip ride each person's own subtotal:

```
person_share_exact = person_subtotal / bill_subtotal * distributable
```

The denominator is always **bill subtotal**, never the claimed-so-far
subtotal. Using the claimed subtotal would inflate early claimants'
numbers and then shrink them as others claim, which looks like the bot
changing its mind about money. Instead, the unclaimed remainder is
displayed as an explicit shortfall during the draft. At confirm time every
line is claimed, so the two denominators are equal and the column sums to
the bill.

**Final rounding uses the largest-remainder method.** Take each person's
floor in cents, then distribute the leftover cents one at a time to the
largest fractional parts, tie-broken by person id for determinism. This
guarantees the shares sum to the distributable total exactly, always.
Naive per-person rounding does not, and a column that doesn't add up to
the paper is the project's one unrecoverable failure.

**The payer** is a diner like anyone else and has a share. What they are
owed is the sum of everyone else's shares, less anything pardoned. During
the draft that counts only claimed lines, so the unclaimed shortfall is
never shown as money owed; once every line is claimed it equals the
distributable total less the payer's own share.

**Property test, not example test.** For randomly generated bills,
assignments, tax, and tips: the shares must always sum to the
distributable total, no share may be negative unless the bill is, and the
result must be invariant under permutation of claim order. This is the
test that matters.

## Identity, groups, and scope

- **A person is a Discord account.** The same account in every server, so
  the same human is one row regardless of where they were organised.
- **A group is a Discord server.** The bot works in any server it is
  added to.
- **A debt belongs to a bill, and a bill belongs to a group.** This is the
  important consequence: "what Priya owes you" and "what Priya owes you
  in the climbing server" are both views over the same rows. Neither has
  to be chosen now, and neither needs a migration later.

## Statistics

Every bill already records who ate, who paid, who ordered what, and when
each share settled, so statistics are queries rather than new
infrastructure.

**Record everything from the first bill, ship the stats page later.** Data
not captured is gone permanently; storing it costs nothing.

Worth building:

- Times any two people have eaten together, in this server.
- Who fronts the bill most often.
- Most-ordered item per person.
- Most-visited restaurant; most expensive night.
- Pardons given and received.

These are what make the bot something to open rather than something to
endure.

**Everything is visible to everyone in one server**, money included. No
statistic looks across servers: people use different names in different
groups, and what they spend with one group is not the other's business.
Guests appear in no statistic, because no guest record survives its bill.

## Stack

These are the author's calls, made for them, not decisions they signed
off on individually.

**Cloudflare Workers** for all compute: the Discord interactions endpoint,
the assignment page, and its API. The free allowance is 100,000 requests
a day, there are no cold starts, and nothing sleeps. Platforms whose free
tier idles a service out, which includes several obvious alternatives,
cannot meet Discord's three-second deadline on the first interaction
after a quiet period.

**Cloudflare D1** (SQLite) for storage, on the same free account: 5 GB and
a daily row budget orders of magnitude above friend-group traffic. One
platform, one deploy, one place for things to go wrong.

**Claude Haiku 5.5 on the Anthropic API** for receipt extraction, at
roughly $0.00083 per receipt, so a dollar covers about 1,200 bills.
Gemini's free tier was considered and rejected: Google no longer
publishes its free-tier request limits in its documentation, and
free-tier content is used to improve Google's products, with human
review. Extraction asks for structured JSON against a fixed schema and
retries on schema violation.

**No image storage.** Discord already hosts the attachment. The bot fetches
it at scan time, extracts, and persists only the parsed data. That
removes a storage dependency and means receipt photographs are not
accumulated anywhere. Discord attachment URLs are signed and expire, so
the fetch happens during the scan, which it does anyway.

**Ed25519 request verification** on every interaction, via WebCrypto, which
Workers provides. The interactions endpoint is public, so unverified
requests are rejected before anything else happens.

**No privileged Discord intents**, no gateway connection, nothing always-on.

**Deploy** with Wrangler from CI on push to the default branch.

## Data model sketch

Indicative, not prescriptive; the builder owns the final schema.

- `groups` — Discord guild id, name.
- `people` — Discord user id, display name. Global, not per group.
- `bills` — group, channel, Discord message id, payer, place, date,
  subtotal, tax, tip, printed total, status
  (`reading` | `draft` | `confirmed` | `superseded` | `deleted`),
  timestamps.
- `bill_items` — bill, label, cents, position, source (`ocr` | `manual`),
  extraction confidence.
- `item_claims` — item, person. The many-to-many that drives everything.
- `shares` — bill, person, subtotal, owed, pardoned, `settled_at`.
  Materialised at confirm so a confirmed bill's numbers are frozen rather
  than recomputed. `settled_at` is a timestamp rather than a flag, because a
  boolean throws the moment away permanently.
- `settlements` — bill, person, cents, recorded at, recorded by.

Access tokens are signed and stateless, so they are not stored.

## Traps worth knowing before you start

Each of these will cost a day if discovered late.

- **Interaction tokens expire in fifteen minutes; a draft bill lives for
  hours.** Editing the bill message as claims arrive must go through the
  REST API using the bot token and the stored channel and message ids, not
  the interaction token that created it. Store the message id at post
  time.
- **Message edits are rate limited.** Eight people claiming thirteen items
  produces a burst of edits to one message. Coalesce them: at most one
  edit every few seconds per bill, with the last state winning. The
  assignment page, not the Discord message, is the live surface.
- **Confirm must be version-checked.** Take the bill's revision with the
  confirm request and reject it if the bill changed in between, or a
  concurrent edit can slip a bill past the reconciliation gate between
  the check and the freeze.
- **Discord attachment URLs are signed and expire.** Fetch during the scan,
  which this design does anyway, and never persist the URL expecting it to
  work later.
- **The interactions endpoint is public.** Verify the Ed25519 signature
  before parsing anything, and respond to Discord's `PING` type correctly
  or the endpoint will not validate when you register it.
- **The payer defaults to whoever invoked the command**, which is right
  almost always and wrong when somebody else's card went down. The draft
  page lets the payer be reassigned to another member of the roster.
- **A settlement is an amount, not a flag**, and a share is clear when its
  settlements sum to what is owed. The page only ever records the whole
  remaining balance, so rows from before that rule that fall short read as
  unpaid.

## Left to the builder

- The extraction prompt and its JSON schema, and the retry strategy when
  the model returns something that doesn't validate. Expect iteration
  against real receipts.
- Whether the assignment page polls for other people's changes or refreshes
  on demand. Polling every few seconds is one cheap indexed query and
  makes a shared page feel alive; it is not obviously necessary.
- Front-end approach for the assignment page. A build step is a
  maintenance cost on a project whose point is not needing maintenance,
  so prefer server-rendered HTML with modest client-side JavaScript
  unless there's a reason not to.
- Concurrency on simultaneous claims. Write claims as individual upserts
  rather than persisting whole-bill state, so two people editing at once
  cannot clobber each other.
- Everything about how the stats page looks, when it is built.
- Mapping from a diner to the payer's payment handle, needed for the
  prefilled deep links.

## Deferred, deliberately

**Automatic settlement from bank notification emails.** The payer's bank
emails them whenever a Zelle payment lands, naming the sender and the
amount. Watching that inbox through the Gmail API, which is free, would
let the bot settle debts with nobody tapping anything. It was cut from
version one to avoid debugging mail subscriptions before the splitting
arithmetic is proven.

The design keeps it reachable: debts and settlements are already separate
records, so auto-settlement adds a new way to create a settlement rather
than changing anything.

Two things that path will need. Matching must key on the **sender's name**,
not the amount, because several diners commonly owe identical amounts; it
therefore needs each person's payment name, captured once. And when
matching is genuinely ambiguous it must ask rather than guess, degrading
to one tap rather than to wrong accounting.

## Open questions

None outstanding. The two that were open are resolved above: guests are
supported as a bill-local label with no stored record, owed through the
member who added them; and all statistics are visible to everyone in the
group.
