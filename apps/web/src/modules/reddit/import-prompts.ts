// ============================================================
// User-facing prompts for the "Bulk import from JSON" sections.
// Built dynamically so we can bake in the company identifier and
// avoid the AI confusing this request with other businesses the
// user has discussed in the same chat session.
// ============================================================

import type { RedditProject } from './types';

/** The company context the sources prompt bakes in. A subset of RedditProject so
 *  callers (e.g. Engage's split Project + module config) can build it directly. */
export type SourcesPromptContext = Pick<
  RedditProject,
  | 'name'
  | 'websiteUrl'
  | 'companyDescription'
  | 'targetCustomer'
  | 'productService'
  | 'brandMentionStyle'
  | 'forbiddenPhrases'
>;

const ANTI_CROSSTALK_HEADER = `IMPORTANT — SCOPE OF THIS REQUEST
This prompt is about ONE specific company, identified below. If we have discussed other businesses or projects in this conversation, IGNORE THEM completely. Do not generate JSON for any company other than the one named here. If you are unsure which company I mean, STOP and ask me before generating anything.`;

export function buildProjectImportPrompt(companyIdentifier: string): string {
  const identifier = companyIdentifier.trim();
  const companyLine = identifier
    ? `Company name (or URL): ${identifier}`
    : `Company name (or URL): [REPLACE THIS LINE with the specific company you want me to generate for]`;

  return `You are helping me set up a new project in our internal Reddit Visibility tool.

${ANTI_CROSSTALK_HEADER}

THE COMPANY
${companyLine}

WHAT THE TOOL DOES
For a given client, the tool monitors target subreddits for relevant discussions, scores each post as REPLY / MAYBE / SKIP, and generates short expert reply drafts grounded in a small set of knowledge sources. A human reviews every draft before anything is posted. Replies are meant to be helpful first, conversational, and Reddit-native — not marketing copy.

WHAT I NEED FROM YOU
A single JSON object representing the project setup for the company above. I will paste it into the tool's "Bulk import" field.

OUTPUT FORMAT
Return exactly one fenced \`\`\`json\`\`\` block. No prose, no commentary, no apologies.

SCHEMA
{
  "name": string,                    // Brand name as the audience knows it. Lowercase if the brand uses lowercase.
  "websiteUrl": string,              // Full URL with https://
  "companyDescription": string,      // 2–3 sentences in plain language. What we do, who for, what's distinctive.
  "targetCustomer": string,          // Specific roles / situations of people who benefit. Not generic.
  "productService": string,          // 1 sentence on what we sell or offer.
  "targetSubreddits": string[],      // 5–10 subreddits, no "r/" prefix. Must actually exist. Mix tight ones (where almost every post is in-domain) with broader ones (where good posts surface weekly). Avoid mega-subs with no signal.
  "keywords": string[],              // 8–14 phrases people ACTUALLY TYPE on Reddit when they have the problem we solve or are looking for alternatives. Include competitor names. Include pain phrases users use. Multi-word phrases will be auto-quoted in Reddit search. NOT generic category words.
  "brandMentionStyle": string,       // 2–4 sentences. WHEN to mention us (directly relevant posts only vs. casual asides), HOW to mention us (one-line natural reference, never push), what to lead with (the user's problem, not the brand). Include a "never push, never spam" clause.
  "forbiddenPhrases": string[]       // 4–8 hype-y / dishonest / anti-competitive phrases. E.g. "the best X", "100% guaranteed", "X is dying", absolute claims, attacks on competitors.
}

CONTENT SCOPE RULE

Do not model the company solely around the products or services it sells.

Many companies create value through both:

1. Commercial offerings (products, services, software, subscriptions, consulting, etc.)
2. Educational resources (blogs, guides, newsletters, research, tutorials, tools, calculators, community content, FAQs, documentation, learning materials, industry insights)

When generating:

* targetSubreddits
* keywords
* targetCustomer
* companyDescription
* productService

represent BOTH aspects of the business.

Weighting guideline:

* 50-60% Commercial Intent
* 20-30% Educational / Resource Intent
* 20-30% Adjacent Problems and Early-Stage Research

KEYWORD RULES

Do not generate keywords only from what the company sells.

Generate keywords from three categories:

1. Commercial Intent
   People looking for products, services, competitors, alternatives, recommendations, pricing, setup help, or buying advice.

2. Educational Content & Resources
   Topics covered by the company's blog, newsletter, guides, research, tutorials, documentation, FAQs, calculators, or learning resources.

3. Adjacent Problems
   Questions users ask before they know they need the product or service. Include frustrations, pain points, workflows, industry questions, and broader category discussions.

SUBREDDIT RULES

Do not select subreddits only where people buy products.

Include:

* Communities discussing the product/service itself
* Communities discussing the problems the product solves
* Communities discussing educational topics the company regularly publishes about

Example:

A CRM company may target:

* CRM discussions
* Sales discussions
* Marketing discussions
* Lead generation discussions

An outdoor gear brand with trail guides and conservation content may target:

* Hiking and backpacking gear discussions
* Trip planning and trail communities
* Ultralight and camping technique discussions
* National parks and conservation communities
* Adjacent outdoor fitness and trail running communities

The final project should represent the full value users receive from the company, not only the product being sold.

QUALITY BAR
- Keywords must be searchable phrases, not category words. Bad: "analytics". Good: "google analytics alternative", "GA4 confusing".
- Subreddits must actually exist and house real target customers. Don't invent.
- brandMentionStyle must explicitly say "never push, lead with the user's problem".
- No marketing voice anywhere. No "best", "revolutionary", "game-changer", "leading".

PROCESS
Ask up to 4 clarifying questions if needed — typically about (a) primary competitor for comparison, (b) current positioning, (c) subreddits we've had success in, (d) brand voice rules. Otherwise generate directly.

ADDITIONAL CONTEXT (optional)
[paste any extra info about this company here — site URL, target customers, main competitors, pricing model, brand voice notes]
`;
}

export function buildSourcesImportPrompt(project: SourcesPromptContext): string {
  const fmtMulti = (val: string) => (val.trim() ? val : '(not specified)');
  const fmtList = (arr: string[]) => (arr.length > 0 ? arr.join(', ') : '(none)');

  return `You are helping me set up knowledge sources for a project in our internal Reddit Visibility tool.

${ANTI_CROSSTALK_HEADER}

THE COMPANY
Company name: ${project.name}
Website: ${project.websiteUrl || '(not specified)'}
Description: ${fmtMulti(project.companyDescription)}
Target customer: ${fmtMulti(project.targetCustomer)}
Product / service: ${fmtMulti(project.productService)}
Brand mention style: ${fmtMulti(project.brandMentionStyle)}
Forbidden phrases: ${fmtList(project.forbiddenPhrases)}

CONTEXT
Knowledge sources are 4–8 short, factual references the tool uses to ground reply drafts in something real. They are NOT marketing copy. Each source distills one page or document into: a summary, the 3–5 key factual claims it supports, the angles it can speak to, and the customer problems it addresses. The tool's draft generator pulls from these to produce credible Reddit replies that match the brand mention style above.

Important: on Reddit, a link to a free guide, a useful newsletter issue, an open-source repo, or a research report consistently lands BETTER than a link to a pricing or product page. Skew toward genuinely-useful, non-commercial resources the company has published. Commercial pages still matter, but they are usually 1–2 sources out of the set, not the whole set.

WHAT I NEED FROM YOU
A JSON array of knowledge source objects for the company above. I will paste it into the tool's "Bulk import" field on the Knowledge tab.

OUTPUT FORMAT
Return exactly one fenced \`\`\`json\`\`\` block containing an array. No prose, no commentary.

SCHEMA (array of these)
{
  "type": "url",                     // Use "url" for any web page. Use "pasted_text" only if it's content you'd paste directly.
  "title": string,                   // Short, descriptive. Examples: "Pricing", "vs Substack", "How it works", "Case study: Morning Brew", "Newsletter archive: weekly send", "Beginner's guide to X", "Free template: Y", "Open-source repo".
  "url": string,                     // Full URL (or null when type is "pasted_text").
  "summary": string,                 // 2–3 factual sentences distilling what the page says. Not promotional.
  "keyPoints": string[],             // 3–5 short factual claims the source supports. Each one should be quotable in a Reddit reply without needing further citation.
  "answerAngles": string[],          // 2–4 short phrases describing the KINDS of Reddit questions this source helps answer.
  "relatedProblems": string[]        // 3–5 ways the target customer might describe the underlying pain in their own words.
}

COVERAGE
Aim for 4–6 sources. The best mix usually pulls from THREE buckets — and the bias should be toward educational and community resources, not product pages, because those are what work on Reddit.

EDUCATIONAL / COMMUNITY resources (pick 2–3 — these are usually the best Reddit material):
  - In-depth blog posts or long-form guides on the problem space
  - The company's newsletter (general archive + notable individual issues if there's a flagship one)
  - Free guides, frameworks, templates, calculators, or tools the company has published
  - Research / data reports with quotable findings
  - Open-source repos, public glossaries, concept explainers, documentation that helps non-customers
  - Notable podcast episodes, talks, or YouTube content the team has produced

COMMERCIAL / POSITIONING pages (pick 1–2):
  - Headline value prop / "how it works"
  - Pricing or free-tier (still answers a lot of "what should I use" questions)
  - "vs main competitor" or comparable positioning page

CREDIBILITY / PROOF (pick 0–1):
  - Case study, founder story, big customer logo, press coverage, testimonials

For each source you propose, ask yourself: "Would a Reddit user genuinely thank me for linking to this in a reply, or would it feel like a sales pitch?" If the answer is "sales pitch," drop it. Three excellent useful sources beats six mediocre commercial ones.

QUALITY BAR
- summary and keyPoints must be FACTUAL — things the source page actually supports. No fabricated stats, no invented quotes.
- answerAngles should be phrases a Reddit poster would care about, not internal marketing language.
- The angles and sources must respect the brand mention style and forbidden phrases declared above.
- No "best", "game-changer", "revolutionary", "amazing".

PROCESS
Ask up to 4 clarifying questions if needed — typically about (a) does the company publish a newsletter, blog, or research and which issues/posts have been most loved, (b) any free tools / templates / open-source things they offer, (c) the primary competitor for comparison, (d) the most differentiated proof point. Otherwise generate directly using the company info above.
`;
}
