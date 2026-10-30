# Setup

Deploying your own copy. Prerequisites: a Cloudflare account, a
[Discord application](https://discord.com/developers/applications), an
Anthropic API key, and Node 22. Run `npm ci` first.

## 1. Collect credentials

Put the five app credentials in a git-ignored `.dev.vars` file, one
`NAME=value` per line, *before* sending them anywhere. Cloudflare cannot read
a stored secret back, and the bot token and API key are shown only once.

| Name | Where to get it |
| --- | --- |
| `DISCORD_APPLICATION_ID` | Discord app, General Information |
| `DISCORD_PUBLIC_KEY` | Discord app, General Information |
| `DISCORD_BOT_TOKEN` | Discord app, Bot page (shown once, and resetting it invalidates the copy on the Worker) |
| `ANTHROPIC_API_KEY` | Anthropic Console (shown once) |
| `TOKEN_SIGNING_KEY` | Any long random string, e.g. `openssl rand -base64 32` |

## 2. Cloudflare

Wrangler asks you to log in on first use (or run `npx wrangler login`).

1. `npx wrangler d1 create aazhi`. Put the printed `database_id` in
   `wrangler.jsonc` under the `DB` binding, replacing the original
   deployment's id, and commit it (CI deploys from the committed file).
   Decline Wrangler's offer to write the config: it names the binding
   `aazhi`, not `DB`.
2. `npx wrangler d1 migrations apply DB --remote`
3. Store the secrets. Accept Wrangler's offer to create an empty Worker for
   them:

   ```sh
   for n in DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN \
            ANTHROPIC_API_KEY TOKEN_SIGNING_KEY; do
     printf '%s' "$(sed -n "s/^$n=//p" .dev.vars)" | npx wrangler secret put "$n"
   done
   ```

4. `npx wrangler deploy`. It prints the Worker URL. On a new account it first
   asks you to register a `workers.dev` subdomain, which is public and
   account-wide.

## 3. GitHub Actions

Add two repository secrets under Settings > Secrets and variables > Actions:

- `CLOUDFLARE_API_TOKEN`: start from the Edit Cloudflare Workers template and
  add D1 Edit.
- `CLOUDFLARE_ACCOUNT_ID`

After that, every push to `main` tests, migrates and deploys. Deploys keep the
Worker secrets from step 2. To deploy by hand, run the migration and deploy
commands from step 2 yourself.

## 4. Discord

1. Set the Interactions Endpoint URL to `<worker URL>/interactions`. Discord
   sends a signed test ping when you save, so this must come after the deploy.
2. Install the bot via OAuth2 > URL Generator. Scopes: `bot`,
   `applications.commands`. Permissions: View Channels, Send Messages, Attach
   Files, Embed Links, Read Message History. No privileged intents are needed.
   Attach Files is what lets `/log` put a suspicious receipt up for a vote. A
   server that installed the bot before `/log` has to grant it, or `/log`
   refuses to run there.
3. `npm run register-commands`, which reads `.dev.vars`. Rerun it whenever
   `src/discord/commands.ts` changes: it replaces the whole command set.

To test, run `/split` with a receipt photo. Watch the logs with
`npx wrangler tail`.

| Symptom | Check |
| --- | --- |
| Interaction fails immediately | Endpoint URL, `DISCORD_PUBLIC_KEY` |
| "Couldn't reach the receipt reader" | `ANTHROPIC_API_KEY`, Anthropic credit balance |

## Credentials reference

| Name | Used for | Stored in | Secret | If leaked |
| --- | --- | --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Discord API paths, command registration | Worker secret, `.dev.vars` | No | Nothing. It is public |
| `DISCORD_PUBLIC_KEY` | Verifying requests come from Discord | Worker secret, `.dev.vars` | No | Nothing. It can't sign |
| `DISCORD_BOT_TOKEN` | Posting and editing as the bot, reading a server's name, registering commands | Worker secret, `.dev.vars` | Yes | Attacker can post as the bot, edit or delete its messages, and replace its commands. Reset it on the Bot page |
| `ANTHROPIC_API_KEY` | Reading receipts | Worker secret, `.dev.vars` | Yes | Attacker can spend your Anthropic credit. Revoke it in the Console |
| `TOKEN_SIGNING_KEY` | Signing split-page and profile links | Worker secret, `.dev.vars` | Yes | Attacker can forge page links as anyone on a known bill, including the payer. Can't record payments. Rotate it freely |
| D1 `database_id` | Telling Wrangler which database is `DB` | `wrangler.jsonc` (committed) | No | Nothing without account access |
| `CLOUDFLARE_API_TOKEN` | CI migrations and deploys | GitHub Actions secret | Yes | **Worst case:** attacker can deploy code that reads every Worker secret, and read or drop the database. Roll it in Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Choosing the CI deploy account | GitHub Actions secret | No | Nothing on its own |
| Wrangler login | Running setup commands manually | Your home directory | Yes | Everything your Cloudflare user can do. Run `npx wrangler logout` on untrusted machines |
