# `shopify-community-development` — what's new since `main`

_Last updated 2026-09-14 · **not in production yet** (`main` is unchanged)_

## Shopify Community (new module)
- Read any Shopify Community board by title and numbers. Free — no AI.
- Pick threads; the AI reads just the question and scores three kinds of reply — **Open**, **Growth**, **Brand** — with a reason for each.
- "Think about it differently": re-score with your own comment. Earlier scores are kept.
- Write a reply in the chosen style. Only then does the AI read the other replies, so it can beat them.
- **Brand opportunities** filter: threads where naming the client genuinely helps.
- Its own client details and knowledge — typed in, imported as JSON, or copied from Reddit.
- Choose which AI model scores and which writes, from the keys on the API keys page.
- A tidier thread screen: three score cards, a draft button on each, and the page jumps to the draft.
- **Post an approved reply through the agent** — pick the account and send it. Shopify has its own dry-run switch, which starts **on**.

## Accounts
- Reddit and Shopify Community tabs. A Shopify account needs its forum username and shows its forum trust level.
- A Shopify account can't be used for Reddit work, and the other way round.

## Posting agent
- Runs **several jobs at once** (`MAX_CONCURRENT` in its `.env`) — never two on the same account, browser profile or IP address.
- **Dry run fails safe**: if the agent can't read the switch, it posts nothing.
- A crashed job is cleared in 3 minutes instead of 15–20.
- A job that must wait for its account's posting gap now waits quietly instead of retrying every 5 seconds.
- **Posts to the Shopify Community** as well as Reddit.
- Works in **its own tab for each site**. It never takes over AdsPower's start page (IP details), a tab on another site, or a tab where you're typing.
- The Accounts page shows every job running.
- Restart the agent from its panel once to pick all of this up.

## Not done yet
- Shopify posting hasn't been tried on the live forum — the dry-run test is next.
- Recording how posted replies perform (likes, replies, accepted) — skipped for now.
