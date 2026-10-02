# `commenting-pipeline-improved` — what's new since `main`

_Last updated 2026-10-02 · **not in production yet** (`main` is unchanged)_

This branch carries everything from `shopify-community-development`, plus the two Reddit sections directly below.

## Reddit replies read the thread first (new)
- Pressing **Draft** now reads the live thread, not just the post. The reply knows what has already been said.
- **Length and style come from the thread.** With four or more comments, the reply matches how long people there write and whether they use plain paragraphs. With fewer, it is sized to the post.
- The angle from the analysis is **sharpened against the comments**. The topic stays the same; the card shows what changed and why.
- **Three attempts are written and the best is picked.** The other two are kept under the draft to copy from.
- What the analysis decided **cannot be changed by the thread**: brand or growth, how far the client may be named, and the forbidden phrases.
- A reply can **never claim to work for the client**. Any attempt that does is thrown away before you see it.
- A post that is locked, archived, removed or deleted is refused instead of drafted.
- Each draft now makes one thread read and up to three AI calls instead of one.

## Reddit accounts browse before they post (new)
- A reply or a karma comment now **browses for two to five minutes first**, the same way a warm-up session does, and then goes to the search bar to find the subreddit.
- The browse **never joins a community** and **never opens the subreddit it is about to post in**.
- If browsing breaks, the reply still goes ahead.
- About one job in eight skips the browse, and an account that has just finished a warm-up session does not browse twice.
- If the post can't be found by scrolling, the account **searches the subreddit for its title** before opening the link directly.
- The plan shown on a queued reply now lists the browse steps above the posting steps.
- **Scrolling looks like a person's.** The page used to move in jumps, like pressing Page Down. It now glides in short bursts, the way a trackpad or mouse wheel moves it. Your own cursor is not used, so you can keep working on the same computer.
- **Restart the agent from its panel once to pick this up.**

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

## Posting record (new)
- Every comment a project posts — Reddit or Shopify Community — is appended to a **Google Sheet**, as one row, seconds after it goes up.
- Turned on per project, on the project page. Paste the sheet's link, share it with the address shown, pick a tab.
- **Mention IDs are numbered for you** from a prefix you set (`RM292-1` → `RM292-1-1`, `-2`, …), or left blank to fill in by hand.
- The **Content Description** column is a copy of the analysis the reply was written from — the verdict, the reasoning and the angle — so the row explains itself a year later.
- Two new columns: the **original post's title and body**, so a row can be checked against what the thread actually said.
- **Choose what the sheet is a record of**: everything the project posts, or only the comments that mention the client. Growth replies are still posted either way — they just don't take a Mention ID when they're not logged, so the numbering stays unbroken.
- It only ever **adds** rows. Nothing we write is ever edited, reordered or deleted, so the sheet stays yours to mark up.
- A sheet that is unreachable never fails a post: the comment goes up, the row waits, and the project page says what to fix.

## Drafting instructions (new)
- **House style, typed in rather than coded in.** A named, dated block of instructions that is added to the reply prompt while it is switched on, and stops mattering the moment it is turned off or deleted. No deploy.
- Two levels: one under **Settings → Drafting** for every client, and an optional set on each project's **Reddit → Settings** for that client alone. The general rule is read first, the client's refinement second.
- **A switch, not just a delete.** Turn a block off, draft the same post again, and read the two replies side by side — each card says what it was written under.
- They **cannot** override the brand mention level or the forbidden phrases. A reply the analysis said must never name the client still will not, whatever the instructions say.
- The text can't be edited once saved, so "written under this wording" always means one exact wording. Reword by adding a new block and deleting the old.

## Not done yet
- Shopify posting hasn't been tried on the live forum — the dry-run test is next.
- Recording how posted replies perform (likes, replies, accepted) — skipped for now.
- The Google Sheet has not been written to a live spreadsheet yet — tests, types and build are green, the Google round trip is untried.
- No reply has been drafted through the new drafting instructions yet — the prompt change is tested, the model's response to it is not.
- The browse-before-posting steps have not run in a real browser yet. The first dry run used an agent that had not been restarted, so it skipped them.
- Searching a subreddit for a post's title has never run.
- Growth replies have not been drafted through the new reply writing yet. Brand replies have, and were judged better.
- The new scrolling has been tested on a practice page, not on Reddit itself.
- Fetching always starts from the first subreddit in the list and stops at the first failure, so subreddits near the end can be missed. Confirmed, not fixed yet.

