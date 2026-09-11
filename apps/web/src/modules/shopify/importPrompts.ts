// The prompts behind "Copy AI prompt" on the Shopify client and knowledge
// screens — pasted into any chat model, whose JSON is then pasted back.
//
// PURE. Written for the Shopify merchant community rather than borrowed from
// Reddit's (modules/reddit/import-prompts.ts): there are no subreddits or search
// keywords here, and what lands on a merchant forum is a practical, specific
// answer from somebody who has done the thing — not a link to a pricing page.
//
// The anti-crosstalk header is Reddit's, for Reddit's reason: a chat that has
// discussed three clients will otherwise happily generate for the wrong one.

export interface ClientPromptContext {
  /** Name or URL, as the operator typed it. May be blank. */
  company: string;
}

export interface SourcesPromptContext {
  name: string;
  websiteUrl: string;
  companyDescription: string;
  targetCustomer: string;
  productService: string;
  brandMentionStyle: string;
  forbiddenPhrases: string[];
}

const ANTI_CROSSTALK_HEADER = `IMPORTANT — SCOPE OF THIS REQUEST
This prompt is about ONE specific company, identified below. If we have discussed other businesses or projects in this conversation, IGNORE THEM completely. Do not generate JSON for any company other than the one named here. If you are unsure which company I mean, STOP and ask me before generating anything.`;

const TOOL = `WHAT THE TOOL DOES
It reads the Shopify Community forum (community.shopify.com) — merchants asking how to run their stores: SEO, email, analytics, apps, themes, checkout, marketing. For a thread a person picks, it scores whether a reply could help, and whether naming the company would genuinely help the merchant. A human reviews every reply before anything is posted. Replies are meant to be useful first, written like an experienced merchant or practitioner — never marketing copy.`;

export function buildClientImportPrompt(ctx: ClientPromptContext): string {
  const company = ctx.company.trim();
  const companyLine = company
    ? `Company name (or URL): ${company}`
    : 'Company name (or URL): [REPLACE THIS LINE with the specific company you want me to generate for]';

  return `You are helping me describe a client company for our internal Shopify Community engagement tool.

${ANTI_CROSSTALK_HEADER}

THE COMPANY
${companyLine}

${TOOL}

WHAT I NEED FROM YOU
A single JSON object describing the company above. I will paste it into the tool's "Import JSON" field on the Client details tab.

OUTPUT FORMAT
Return exactly one fenced \`\`\`json\`\`\` block. No prose, no commentary.

SCHEMA
{
  "companyDescription": string,   // 2–3 plain sentences. What they do, for whom, what is distinctive. A stranger must understand it.
  "targetCustomer": string,       // Which merchants benefit, specifically: store size, stage, platform setup, the situation they are in. Not "e-commerce businesses".
  "productService": string,       // One sentence on what they actually sell or offer — including free tools, guides or apps if they have them.
  "brandMentionStyle": string,    // 2–4 sentences. WHEN a reply may name them (only where it is the answer), HOW (once, plainly, after being useful), what to lead with (the merchant's problem). Include "never push, never spam".
  "forbiddenPhrases": string[]    // 4–8 hype-y, absolute or anti-competitive phrases the company must never be quoted saying. E.g. "the best", "guaranteed", "100%", attacks on competitors.
}

QUALITY BAR
- Describe what the company does for a MERCHANT, in a merchant's words. The forum is practical and allergic to marketing.
- If the company publishes guides, research, free tools or an app on the Shopify App Store, say so — those are what a merchant forum finds genuinely useful.
- No "best", "revolutionary", "game-changer", "leading", "seamless".
- Do not invent customers, numbers or features. If you are unsure, leave it out.

PROCESS
Ask up to 3 clarifying questions if you need to — typically (a) do they have a Shopify app or integration, (b) who is their typical merchant, (c) brand voice rules. Otherwise generate directly.

ADDITIONAL CONTEXT (optional)
[paste anything else about this company here — site URL, main competitors, pricing model, voice notes]
`;
}

export function buildShopifySourcesPrompt(p: SourcesPromptContext): string {
  const multi = (v: string) => (v.trim() ? v : '(not specified)');
  const list = (v: string[]) => (v.length ? v.join(', ') : '(none)');

  return `You are helping me set up knowledge sources for a client in our internal Shopify Community engagement tool.

${ANTI_CROSSTALK_HEADER}

THE COMPANY
Company name: ${p.name || '(not specified)'}
Website: ${p.websiteUrl || '(not specified)'}
Description: ${multi(p.companyDescription)}
Target customer: ${multi(p.targetCustomer)}
Product / service: ${multi(p.productService)}
Brand mention style: ${multi(p.brandMentionStyle)}
Forbidden phrases: ${list(p.forbiddenPhrases)}

${TOOL}

WHAT KNOWLEDGE SOURCES ARE FOR
Each source distils one page the company has published into a summary, the factual points it supports, the kinds of merchant question it answers, and the problems it speaks to. The tool matches sources to a merchant's question by the words in the title, key points and answer angles — so those must use the words a MERCHANT would use, not internal product names. A reply may only name the company where a source genuinely supports it, and may only state what the source says.

On a merchant forum, a practical guide, a how-to, a teardown, a free tool, research with real numbers, or a help-centre page that answers the exact question lands far better than a pricing or landing page.

WHAT I NEED FROM YOU
A JSON array of knowledge sources for the company above. I will paste it into the "Import JSON" field on the Knowledge tab.

OUTPUT FORMAT
Return exactly one fenced \`\`\`json\`\`\` block containing an array. No prose.

SCHEMA (array of these)
{
  "type": "url",               // "url" for any web page; "pasted_text" only for content with no page.
  "title": string,             // Short and specific: "How to fix duplicate product pages in Shopify", "Email flows for first-time buyers", "Pricing".
  "url": string,               // Full https:// URL of a page that really exists. Null only for pasted_text.
  "summary": string,           // 2–3 factual sentences. What the page actually says. Not promotional.
  "keyPoints": string[],       // 3–5 short factual claims the page supports — each quotable in a reply without further citation.
  "answerAngles": string[],    // 2–4 phrases for the KINDS of merchant question this answers, in merchant words ("products not showing in Google", "abandoned cart emails not sending").
  "relatedProblems": string[]  // 3–5 ways a merchant would describe the underlying pain in their own words.
}

COVERAGE
Aim for 5–8 sources. Skew toward genuinely useful material:
- Guides, how-tos, documentation and help-centre answers on problems merchants actually post about (pick 3–5)
- Free tools, templates, calculators, research or data with quotable findings (pick 1–2)
- What the company sells and how it works — one page, maybe a comparison (pick 1–2)

For every source ask: "Would a merchant who asked this on the forum thank me for pointing here, or would it read as a sales pitch?" If a pitch, drop it.

QUALITY BAR
- Only pages that exist. Do not invent URLs, statistics, quotes or features.
- summary and keyPoints must be things the page supports.
- Respect the brand mention style and forbidden phrases above.
- No "best", "game-changer", "revolutionary", "seamless".

PROCESS
Ask up to 3 clarifying questions if you need to — typically (a) which guides or help pages are most used, (b) any free tools or app-store listing, (c) the main competitor. Otherwise generate directly from what you know about the company.
`;
}
