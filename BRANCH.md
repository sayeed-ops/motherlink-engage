# `commenting-pipeline-improved` — what's new since `main`

_Last updated 2026-10-25 · **in production** — everything below was promoted to `main` on 2026-10-25_

This branch carries everything from `shopify-community-development`, plus the Reddit and agent sections directly below.

## Adding an account creates its AdsPower profile too (new)
- **Add account** can now create the AdsPower browser profile as well, in one go — no more doing it twice. Owner and admin only.
- Pick the **browser** (Chrome-based or Firefox-based, always the newest) and the **operating system** (Windows, Mac, or either at random — never Linux or phones).
- **Paste the proxy however the provider gave it** — host:port:user:pass, user:pass@host:port, or Decodo's / IPRoyal's curl line. The form shows what it understood, and warns when the proxy rotates (fine for testing, not for a real account).
- **Test proxy** goes out through it once, from the server, and shows the IP, city and country — and warns if another profile already uses that proxy or IP.
- The browser's **time zone, location and language follow the proxy**.
- The **comment** (logins, recovery details) is copied word for word into the AdsPower profile, and kept in Engage **encrypted — only the owner can view it** (each view is logged).
- The account card shows **Creating profile…**, or why AdsPower refused with **Try again**. Older accounts without a profile get **Set up AdsPower profile**.
- Linking an existing profile still works, now with AdsPower's profile names to pick from. One profile may serve a Reddit and a Shopify account.

## The posting agent's cloud server sleeps when idle (new)
- The agent now runs on a **cloud server** instead of a laptop. The team uses Engage as before; nobody needs access to anyone's computer.
- When the server has had **nothing to do for a few minutes**, it shuts itself down so it stops costing money.
- **Queueing anything wakes it**: a reply, a karma comment, a warm-up or a Shopify reply. It takes about **3–5 minutes** to start, then works through everything waiting. Nothing queued while it sleeps is lost.
- Tasks **scheduled for later** wake it too, a few minutes before they are due.
- It **stays awake** while anything is running or waiting, while a "prove you are human" check is waiting for someone, and while someone is connected to it.
- The Accounts page says **"asleep"** (grey) or **"waking up"** (amber) instead of a red "offline", has a **Wake now** button, and a box to set **how many idle minutes** before it sleeps (0 = never). The change takes effect at once.
- Engage checks with AWS every 5 minutes whether the server is really on, so the chip says **asleep** whenever it is off — however it was turned off — instead of a red "offline".
- **Only the owner** sees and can use Wake now / Keep awake and the idle-minutes box. Everyone else sees the status, and the dry-run switch as before. Queueing work still wakes the server for anyone.
- **Wake now keeps it on for 30 minutes**, so there is time to connect to it whatever the idle setting. While it is already on, the same button reads **Keep awake 30 min**. Once someone is connected it never sleeps; the countdown starts when they disconnect.
- A laptop running the agent never sleeps — only the cloud server is set up to.

## Cancelling a warm-up stops it (fixed)
- **Cancel** on a running warm-up now stops the browser within seconds, even in the middle of a step. Before, it kept browsing to the end.
- A cancelled session **stays cancelled**. Before, it could be recorded as completed or failed afterwards, and counted towards the account's warm-up progress.
- Replies and comments that are already running still go through to the end.

## Opportunities: older results move to Archived (new)
- Running **Analyse** again moves the previous batch of analysed posts to **Archived** once the first new post is scored. Favourites and posts with an unposted draft stay.
- Cards show **when they were analysed**.
- Sort by newest analysed (the default), oldest analysed, highest score, or newest post.

## "Prove you are human" stops everything (new)
- If Reddit shows a CAPTCHA or a "prove you are human" check, the agent **stops the job at once** — before a step, after a page change, or in the middle of a long step (it checks every few seconds).
- It **never tries to get past it**, and **leaves the account's browser open** on the check.
- The account is **flagged**. A red banner on the account page and the warm-up page says what happened and when; the Accounts list marks it too.
- Until someone presses **I've solved it**, nothing runs from that account: replies, karma comments, warm-ups and Shopify posts are **refused when queued**, and the agent refuses any job already queued, without opening the browser.

## Popups after a page change are closed (fixed)
- A community's welcome card ("Welcome to our subreddit … Got It") arrives a moment after the page does, so the check before the next step missed it and the account browsed behind it.
- The agent now looks again shortly after any step that changed page, finds open dialogs anywhere on screen (not only at the centre), and **closes anything covering the spot it is about to click** before clicking.
- **Restart the agent** to pick both of these up.

## More ways to arrive at a post (new)
- **Nothing was removed.** Search, the scroll for the post, the title search and the browse before posting all work as before, and the plain flow is still the most common one.
- **Three new ways into a subreddit**, each chosen only when it could be true:
  - **Recent** in the left sidebar — only when the subreddit was in the account's Recent list last time the agent looked.
  - **The Communities list** in the left sidebar — only for a subreddit the account has joined.
  - **A post from it in the home feed** — only for a joined subreddit.
- **Looking in and coming back.** About one job in seven searches for the subreddit, scrolls a little (sometimes not at all), goes off to browse, then returns through Recent.
- **Reading now, commenting later.** About one job in four opens and reads the post, goes off to browse, then returns to it through **Recent Posts** on the home feed and comments. The reading is split between the two visits, not doubled.
- The time away is the **browse that already ran before every reply**, so jobs are not much longer. A job with no browse stays a single visit.
- **At most one come-back per job.**
- **Every new step falls back to the old flow.** A subreddit that isn't in the list is searched for; a post that isn't in Recent Posts is found by search, scroll and title. The plan card shows which way it went.
- The plan card shows the **first visit** as its own list, above the browse.
- The agent now records each account's **Recent list** at the end of every job and warm-up. Until an account has run once on this version, Recent is not chosen for it.
- Applies to replies and karma comments alike.
- **Restart the agent** to pick this up.

## Reddit replies read the thread first (new)
- Pressing **Draft** now reads the live thread, not just the post. The reply knows what has already been said.
- **Length and style come from the thread.** With four or more comments, the reply matches how long people there write and whether they use plain paragraphs. With fewer, it is sized to the post.
- The angle from the analysis is **sharpened against the comments**. The topic stays the same; the card shows what changed and why.
- **Three attempts are written and the best is picked.** The other two are kept under the draft to copy from.
- What the analysis decided **cannot be changed by the thread**: brand or growth, how far the client may be named, and the forbidden phrases.
- A reply can **never claim to work for the client**. Any attempt that does is thrown away before you see it.
- A post that is locked, archived, removed or deleted is refused instead of drafted.
- Each draft now makes one thread read and up to three AI calls instead of one.

## Fetching reaches every subreddit (new)
- A fetch used to start from the top of the subreddit list every time and stop at the first failure, so the ones near the end were often missed.
- It now takes **whichever subreddit has gone longest without a successful fetch first**. Anything the last run missed is at the front of the next one.
- **One failure no longer stops the run.** It carries on and tries the failed ones once more at the end.
- The result line says which subreddits were not fetched, if any.

## Joined communities are read correctly (fixed)
- The Communities tab was showing communities as **joined that nobody had joined**. The agent was counting Reddit's "Recent" list (communities the account only visited) as joined.
- It now reads **only the account's real Communities list** on Reddit.
- "Joined" is now made of three separate things: what a following session joined, what you marked yourself, and what Reddit's own list shows. Hover over **following** to see which.
- New **"not joined?"** button next to each joined community, to undo a wrong one.
- **Comment karma only writes in communities the account has joined.** Before, it could comment in a community the account had never joined.
- The old, wrong list is ignored. Each account's real list is read after its next warm-up session; until then the tab says so.
- **Restart the agent** to pick this up.

## Searching for a community works like a person does (fixed)
- The agent used to type a keyword, and if the suggestions didn't offer the community, click a link to it from the sidebar or the page behind — while scrolling the page behind the open suggestion list. It then logged that as a successful search.
- It now does **one search, typed once**: look at the suggestions, then press Enter and look down the results, then open the Communities tab. If the topic doesn't surface the community, it searches for the community by name. Opening the address directly is the last resort.
- It only clicks a community **inside the suggestions or the results**, never from the sidebar.
- It no longer scrolls the page behind the suggestion list.
- The plan shows what really happened, including when a search fell back.
- A community the agent finds **already joined** is now marked as joined.
- Every step in a plan is **numbered** (4/14), matching the agent log.

## Reddit accounts browse before they post (new)
- A reply or a karma comment now **browses for two to five minutes first**, the same way a warm-up session does, and then goes to the search bar to find the subreddit.
- The browse **never joins a community** and **never opens the subreddit it is about to post in**.
- If browsing breaks, the reply still goes ahead.
- About one job in eight skips the browse, and an account that has just finished a warm-up session does not browse twice.
- If the post can't be found by scrolling, the account **searches the subreddit for its title** before opening the link directly.
- The plan shown on a queued reply now lists the browse steps above the posting steps.
- **Popups are noticed and closed.** A welcome card after joining a community, or a new-achievement card, used to sit over the page while the account kept scrolling behind it. The account now closes it first ("Got It", the ×, or Escape) and never presses a button that would do something, like Join. Each popup it meets is written to the log.
- **No scrolling back to the top to search.** The search box is always on screen, so the account uses it where it is.
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
- **The new ways in have not been through a dry-run job.** Entering from Recent was tried once on a live page (13 October) and landed. Returning through Recent Posts, the Communities list and the home-feed route are untried on a live page.
- Shopify posting hasn't been tried on the live forum — the dry-run test is next.
- Recording how posted replies perform (likes, replies, accepted) — skipped for now.
- The Google Sheet has not been written to a live spreadsheet yet — tests, types and build are green, the Google round trip is untried.
- No reply has been drafted through the new drafting instructions yet — the prompt change is tested, the model's response to it is not.
- Growth replies have not been drafted through the new reply writing yet. Brand replies have, and were judged better.
- How long a draft takes has not been measured against the 60-second limit.
- Tested live on Reddit in dry run (4 October): the new scrolling, both kinds of search, the title search, and browsing before posting.

