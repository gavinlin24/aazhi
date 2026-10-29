# AAzhi

A Discord bot that splits a restaurant bill from a photo of the receipt.

Named after AA制, which is what my friends call splitting the bill.

## The problem

Eight people go out to eat and one card covers the whole thing. Everything
after that is unpaid work for whoever paid: dividing the receipt, working out
that the person who ordered the $45 steak owes more tax than the person who
ordered the $12 soup, posting eight numbers in a group chat, then remembering
for two weeks who still hasn't sent anything.

## What it does

Photograph the receipt, run `/split` in the Discord server the group already
uses. The bot reads the line items off the photo. Everyone taps what they
ordered, sharing a plate between exactly the people who shared it. The bot
works out what each person owes, including their own proportional share of tax
and tip, and keeps score until the debt clears.

Nobody creates an account, installs anything, or logs in. Discord identifies
people, so a tap on a button is proof of who tapped it.

## Correctness

Money arithmetic is the part that has to be exactly right, so two guarantees
are built in rather than hoped for.

**The receipt proves its own read.** A receipt prints its own total, so the
extracted line items plus the extracted tax are checked against it. If they
don't reconcile to the cent, the bill cannot be finalized and the bot says what
it misread. The vision model never has to be perfect, which it won't be.

**The column always adds up.** All money is integer cents, never floating
point, and per-person shares are rounded by largest remainder so the eight
shares sum to the printed total plus the tip, exactly. A bill that doesn't
reconcile has lied about money to people who trust each other, which is the one
unrecoverable failure.

## Stack

- TypeScript on Cloudflare Workers. Discord reaches the bot over HTTP
  interactions, so there is no always-on process to keep alive and no privileged
  Discord intents to request.
- Cloudflare D1 for storage.
- Claude Haiku 5.5 on the Anthropic API for receipt extraction, at roughly $0.00083 per receipt.
- Hosting, storage, and the web page run inside free tiers, with no expiry and
  nothing that sleeps. Reading a receipt is the one part that costs anything,
  at about $0.00083 each.

Why each piece was chosen: [docs/stack.md](docs/stack.md).

## Setup

You need a Cloudflare account, a Discord application, an Anthropic API key,
and Node 22. Run `npm ci` first.

### Credentials

Write all five values into a `.dev.vars` file in the project root, one
`NAME=value` line each, before sending any of them anywhere. It is git-ignored;
keep it that way.

Collecting them first is not a convenience. Cloudflare cannot read a stored
secret back, and two of these are shown exactly once by whoever issues them, so
a value sent straight up leaves no copy behind and has to be reissued the next
time something local needs it. Registering the commands is such a step.

- `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`: the Discord app's General
  Information page. Always visible there, so these two are safe to lose.
- `DISCORD_BOT_TOKEN`: the app's Bot page. Shown once, and resetting it
  invalidates the copy already stored on the Worker.
- `ANTHROPIC_API_KEY`: the Anthropic Console. Shown once.
- `TOKEN_SIGNING_KEY`: signs the links to the split page. Any long random
  string, for example from `openssl rand -base64 32`.

### Cloudflare

1. Create the database with `npx wrangler d1 create aazhi`. It prints a
   `database_id`. Put it in `wrangler.jsonc` in place of
   `REPLACE_WITH_D1_DATABASE_ID` and commit that change: CI deploys from the
   committed file, and the id is not a secret. Decline wrangler's offer to
   write the config itself, which binds the database as `aazhi` rather than the
   `DB` the code reads.
2. Create the tables with `npx wrangler d1 migrations apply DB --remote`.
3. Store the five secrets on the Worker. `npx wrangler secret put NAME` asks
   for one value at a prompt and also accepts it on stdin, so the whole set can
   go up from `.dev.vars` at once:

   ```sh
   for n in DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN \
            ANTHROPIC_API_KEY TOKEN_SIGNING_KEY; do
     printf '%s' "$(sed -n "s/^$n=//p" .dev.vars)" | npx wrangler secret put "$n"
   done
   ```

   A secret needs a Worker to live on, and the Worker does not exist until the
   first deploy, so wrangler offers to create an empty one to hold them. Accept.
4. Deploy with `npx wrangler deploy`. It prints the Worker's URL, which Discord
   needs next. On an account that has never published to `workers.dev` it stops
   to register a subdomain first: that name is account-wide and public, and
   every Worker on the account is addressed under it.

### GitHub

Under Settings, Secrets and variables, Actions, add two repository secrets
for the deploy workflow:

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers scripts and D1
  (start from the Edit Cloudflare Workers template and add D1 Edit).
- `CLOUDFLARE_ACCOUNT_ID`: the account the Worker and database live in.

### Discord

1. In the Discord Developer Portal, set the app's Interactions Endpoint URL to
   the Worker's URL followed by `/interactions`. Discord checks it with a
   signed ping when you save, so the Worker must already be deployed with
   `DISCORD_PUBLIC_KEY` set.
2. Install the bot in a server from OAuth2, URL Generator, with the `bot` and
   `applications.commands` scopes and the View Channels, Send Messages, Embed
   Links and Read Message History permissions. No privileged intent is
   required, because the bot never connects to the gateway.
3. Register the commands with `npm run register-commands`, which reads
   `.dev.vars`. Run it again whenever `src/discord/commands.ts` changes.

### Local development

- `npx wrangler d1 migrations apply DB --local` creates a local database.
- `npx wrangler dev` serves the Worker against it, reading `.dev.vars`.
- `npm test` runs the tests, which need no secrets and make no network calls.

## Deploy

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
it type-checks, runs the tests, applies any new D1 migrations with
`wrangler d1 migrations apply DB --remote`, then runs `wrangler deploy`. A
failed check stops it before anything reaches Cloudflare. To deploy by hand,
run the same two Wrangler commands with your own Cloudflare login.

## Status

In development. The design is in [`docs/specs`](docs/specs).
