# Architecture

How one bill moves from a receipt photo to settled payments. Setup and
credentials are in [setup.md](setup.md). Technology choices are in [stack.md](stack.md).

## Components

- **Cloudflare Worker**: all server code, run by Cloudflare once per request,
  with nothing idling in between. Entry: `src/index.ts`.
- **D1**: Cloudflare's hosted SQLite, passed to the Worker as the `DB` binding.
  Schema: `migrations/`.
- **Discord**: forwards every command and button tap to the Worker's
  *interaction endpoint* (`POST /interactions`) and needs a reply within 3 s.
- **Claude Haiku** (Anthropic API): reads the receipt into structured data.
- **Split page**: HTML and a JSON API served by the same Worker at `/b/<bill id>`.

```mermaid
flowchart TB
  subgraph discordside["Discord"]
    users(["People in the server"])
    dapi["Discord API"]
  end
  subgraph worker["Cloudflare Worker (src/index.ts)"]
    verify["Signature check<br/>discord/verify.ts"]
    router["Router<br/>discord/interactions.ts"]
    handlers["Handlers<br/>discord/handlers/*"]
    rest["Discord REST client<br/>discord/rest.ts"]
    extract["Receipt reader<br/>extract/*"]
    money["Split engine<br/>money/*"]
    token["Link signer<br/>web/token.ts"]
    page["Page + API<br/>web/page.ts, client.ts, api.ts"]
    db["Data access<br/>db/*"]
  end
  d1[("D1")]
  anthropic["Anthropic API"]
  browser["Browser"]

  users --> dapi -- "POST /interactions" --> verify --> router --> handlers
  handlers --> extract --> anthropic
  handlers --> rest --> dapi
  handlers --> token
  handlers --> money
  handlers --> db
  browser -- "/b/:billId (token)" --> page
  page --> token
  page --> money
  page --> db
  page --> rest
  db --> d1
```

## One bill, step by step

**1. `/split`.** Discord POSTs the interaction. `src/discord/verify.ts` checks
its Ed25519 signature (a public-key signature only Discord can make) against
`DISCORD_PUBLIC_KEY`, and rejects timestamps over 5 minutes old. The
`custom_id` prefix of each button tells `src/discord/interactions.ts` which
handler to call. Reading takes longer than 3 s, so
`src/discord/handlers/split.ts` replies "thinking..." at once and continues in
`ctx.waitUntil` (work allowed to run after the response).

**2. Reading the receipt.** `src/extract/claude.ts` sends the photo's Discord
URL to Claude with a forced tool call (a fixed JSON schema in
`src/extract/schema.ts`), so the photo never passes through the Worker or gets
stored. Prices arrive as strings and are parsed into integer cents. Then the
items plus tax are checked against the printed total. A bill that doesn't
match can be fixed but not confirmed.

**3. Saving and posting.** `src/db/bills.ts` writes the draft to D1. Each
change bumps the bill's `revision`, so a button drawn from an older version
is refused. `src/discord/render.ts` draws the message, and
`src/discord/rest.ts` posts it with the *interaction token* (a 15-minute
credential to edit that reply).

**4. Joining.** **Open the split** (`src/discord/handlers/roster.ts`) adds the
tapper to the bill and replies privately with
`/b/<bill id>?t=<token>`. The token (`src/web/token.ts`) is HMAC-signed: JSON
naming the bill, the person and a 30-minute expiry, plus a signature only
`TOKEN_SIGNING_KEY` can produce. It is the page's only login.

**5. Claiming.** `src/index.ts` checks the token before loading the bill and
serves `src/web/page.ts` with the client script from `src/web/client.ts`. The
script calls `src/web/api.ts` with the token as a Bearer header. People claim
their own lines and can add guests, whom they tap onto lines and answer for
(`src/money/debtors.ts` decides who owes for whom). The payer can also edit
lines, tax, tip and anyone's guests. Writes
only land while the SQL `WHERE` still sees a draft. The page polls every
5 s. The Discord message updates at most every 3 s per bill, through a lease
stored in D1, since Worker instances share no memory.

**6. Confirming.** `confirmBill` (`src/db/bills.ts`) requires the payer, a
current revision, a matching total and every line claimed.
`src/money/split.ts` splits each line between its claimants and gives tax and
tip in proportion to subtotal. Largest-remainder rounding (round everyone
down, then give spare cents to the largest fractions) makes shares sum to the
cent. The shares are frozen in the `shares` table, and the message becomes
the owe card.

**7. Paying.** `/paywith` stores the payer's handle (`src/db/handles.ts`).
**Pay my share** (`src/discord/handlers/owe.ts`) builds Venmo or Cash App links
with the remaining amount (`src/web/paylink.ts`). Zelle gets written
instructions.

**8. Recording.** **I paid** (`src/discord/handlers/settle.ts`) inserts into
`settlements` (`src/db/settlements.ts`). The checks run inside the insert, so
racing taps cannot overpay. The payment is announced in the channel, and
`/ledger` totals who still owes the payer. A guest has no Discord account, so
the payer marks them paid on the page instead; that is a settlement against
the guest, and it counts toward whoever answers for them.

**9. Corrections.** **That's not mine** or **Reopen**
(`src/discord/handlers/lifecycle.ts`) returns the bill to draft and pauses
paying. Re-confirming announces any changed amounts.

```mermaid
sequenceDiagram
  autonumber
  actor Payer
  actor Diner
  participant D as Discord
  participant W as Worker
  participant DB as D1
  participant C as Claude
  participant B as Browser

  Payer->>D: /split with photo
  D->>W: POST /interactions (signed)
  W-->>D: deferred reply
  W->>C: photo URL
  C-->>W: items, tax, total
  W->>DB: save draft
  W->>D: post bill message
  Diner->>D: Open the split
  D->>W: POST /interactions
  W->>DB: add participant
  W-->>D: private signed link
  Diner->>B: open link
  B->>W: GET /b/:billId?t=token
  B->>W: POST /b/:billId/claim
  W->>DB: write claim
  W->>D: edit message (max every 3 s)
  Payer->>D: Confirm
  D->>W: POST /interactions
  W->>DB: freeze shares
  W-->>D: owe card
  Diner->>D: Pay my share, then I paid
  D->>W: POST /interactions
  W->>DB: insert settlement
  W-->>D: payment announced
```

## Deployment

On each push to `main`, `.github/workflows/deploy.yml` type-checks, tests,
applies D1 migrations, then runs `wrangler deploy`. Tests run inside workerd
(the Workers runtime) against a real D1 database.
