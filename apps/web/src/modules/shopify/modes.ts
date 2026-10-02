// The three kinds of reply. Their own file because both the analysis (which
// scores them) and the draft (which writes them) need the list, and neither
// should import the other to get it.
//
//   OPEN    names nobody, needs nothing, works on ANY thread. The goal is
//           ENGAGEMENT: be more useful than what is already there.
//   GROWTH  the client's expertise with the client absent.
//   BRAND   names the client. Needs a knowledge source that supports it.

export const REPLY_MODES = ['open', 'growth', 'brand'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export const MODE_LABEL: Record<ReplyMode, string> = {
  open: 'Open',
  growth: 'Growth',
  brand: 'Brand',
};

export const MODE_HELP: Record<ReplyMode, string> = {
  open: 'The most useful answer in the thread. Names nobody, needs nothing, works anywhere.',
  growth: "The client's expertise with the client absent. Builds standing, never mentions them.",
  brand: 'Names the client. Only where a knowledge source actually supports it.',
};
