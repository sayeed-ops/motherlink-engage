import 'server-only';

import { Resend } from 'resend';

// Transactional email.
//
// Compare with ML Studio's /api/send-invitation, which is an unauthenticated
// open relay: no token check, no rate limit, no origin check, and it
// interpolates caller-supplied `role` and `invitedByName` raw into the HTML.
// Anyone on the internet can make it send Motherlink-branded mail containing
// an attacker-chosen link.
//
// This module is never a route. It is called only from handlers that have
// already verified a platform admin. And crucially the email carries NO
// SECRET — just "you have access, sign in". There is no token to steal,
// because Google sign-in plus email matching replaced the token entirely.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3010';

/** Escape anything interpolated into HTML. ML Studio does not do this. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tell someone they have access. Returns whether it sent.
 *
 * Never throws: provisioning already succeeded by the time this runs, and the
 * recipient can sign in whether or not the mail lands. Failing the request here
 * would imply the account wasn't created, which would be a lie.
 */
export async function sendInviteEmail({
  to,
  invitedByName,
}: {
  to: string;
  invitedByName: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn('RESEND_API_KEY is not set — skipping invite email to', to);
    return false;
  }

  try {
    const resend = new Resend(apiKey);

    // TODO: verify a real sending domain. ML Studio still ships the Resend
    // sandbox sender, which limits delivery and looks untrustworthy.
    const { error } = await resend.emails.send({
      from: 'Motherlink Engage <onboarding@resend.dev>',
      to,
      subject: 'You have access to Motherlink Engage',
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#14171d">
          <h2 style="margin:0 0 12px">You have access to Motherlink Engage</h2>
          <p>${esc(invitedByName)} added you to Motherlink Engage.</p>
          <p>Sign in with Google using <strong>${esc(to)}</strong> — that address is your account, so there is no password to set and no invite code to enter.</p>
          <p style="margin:24px 0">
            <a href="${APP_URL}" style="background:#2d4a7c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Open Motherlink Engage</a>
          </p>
          <p style="color:#5c6472;font-size:13px">
            If you weren't expecting this, you can ignore it. This link grants nothing on its own —
            access is tied to your ${esc(to)} account.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend failed:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Invite email failed:', err);
    return false;
  }
}
