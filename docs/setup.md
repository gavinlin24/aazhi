# Running your own copy

How to deploy AAzhi to your own Cloudflare account and Discord server. For what
each credential below is for and what a leak would expose, see
[Credentials and what each one is for](architecture.md#credentials-and-what-each-one-is-for).

You need a Cloudflare account, a Discord application (create one at the
[Discord Developer Portal](https://discord.com/developers/applications)), an
Anthropic API key, and Node 22. Run `npm ci` first.

The order matters, because each step needs something the one before it made:

1. Collect the five credentials into `.dev.vars`.
2. Create the database and the Worker, store the secrets on it, and deploy it.
3. Give GitHub what it needs to deploy from then on.
4. Point Discord at the deployed Worker, install the bot, register its commands.

## 1. Credentials

Write all five values into a `.dev.vars` file in the project root, one
`NAME=value` line each, before sending any of them anywhere. It is git-ignored;
keep it that way.

```sh
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...
DISCORD_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
TOKEN_SIGNING_KEY=...
```

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

## 2. Cloudflare

Wrangler, Cloudflare's command-line tool, is installed by `npm ci`. Its
commands below act on your Cloudflare account, so it asks you to log in through
the browser the first time (or run `npx wrangler login` up front).

1. Create the database with `npx wrangler d1 create aazhi`. It prints a
   `database_id`. Put it in `wrangler.jsonc` as the `database_id` of the `DB`
   binding, replacing the one committed here (which belongs to the original
   deployment), and commit that change: CI deploys from the committed file, and
   the id is not a secret. Decline wrangler's offer to write the config itself,
   which binds the database as `aazhi` rather than the `DB` the code reads.
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

## 3. GitHub

Every push to `main` runs [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):
it type-checks, runs the tests, applies any new D1 migrations with
`wrangler d1 migrations apply DB --remote`, then runs `wrangler deploy`. A
failed check stops it before anything reaches Cloudflare. The workflow never
touches the five app secrets: they stay stored on the Worker from step 2, and a
deploy keeps them.

Under Settings, Secrets and variables, Actions, add two repository secrets
for the workflow:

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers scripts and D1
  (start from the Edit Cloudflare Workers template and add D1 Edit).
- `CLOUDFLARE_ACCOUNT_ID`: the account the Worker and database live in.

To deploy by hand instead, run the same two Wrangler commands
(`npx wrangler d1 migrations apply DB --remote`, then `npx wrangler deploy`)
with your own Cloudflare login.

## 4. Discord

1. In the Discord Developer Portal, set the app's Interactions Endpoint URL to
   the Worker's URL followed by `/interactions`. Discord checks it with a
   signed ping when you save, so the Worker must already be deployed with
   `DISCORD_PUBLIC_KEY` set.
2. Install the bot in a server from OAuth2, URL Generator, with the `bot` and
   `applications.commands` scopes and the View Channels, Send Messages, Embed
   Links and Read Message History permissions. No privileged intent is
   required, because the bot never connects to the gateway.
3. Register the commands with `npm run register-commands`, which reads
   `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` from `.dev.vars`. Run it
   again whenever `src/discord/commands.ts` changes. It replaces the whole
   command set, so a command removed from that file disappears from Discord too.

## Checking it works

Run `/split` in a channel the bot can see, with a receipt photo attached. The
bot should answer "thinking..." at once and post the bill a few seconds later.
If Discord says the interaction failed straight away, the endpoint URL or
`DISCORD_PUBLIC_KEY` is wrong. If the bot says it couldn't reach the receipt
reader, check `ANTHROPIC_API_KEY` and the Anthropic account's credit balance.
`npx wrangler tail` streams the Worker's logs live while you try it.
