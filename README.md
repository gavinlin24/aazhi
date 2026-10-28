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
shares sum to the printed total exactly. A bill that doesn't reconcile has lied
about money to people who trust each other, which is the one unrecoverable
failure.

## Stack

- TypeScript on Cloudflare Workers. Discord reaches the bot over HTTP
  interactions, so there is no always-on process to keep alive and no privileged
  Discord intents to request.
- Cloudflare D1 for storage.
- Claude Haiku 5.5 on the Anthropic API for receipt extraction, at roughly $0.00083 per receipt.
- Runs inside free tiers at friend-group volume.

Why each piece was chosen: [docs/stack.md](docs/stack.md).

## Status

In development. The design is in [`docs/specs`](docs/specs).
