// Shown when the server has no LLM_ENCRYPTION_KEY.
//
// The wording matters. The first version said "ask an admin to configure it",
// which is wrong twice over: the person reading it is often the admin, and no
// role can fix this from inside the app. It is a deploy-time environment
// variable — and it has to be, because a master key that encrypts the database
// cannot itself live in that database.
//
// So this says what to run and where, not who to ask.

export default function EncryptionNotice() {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="text-dim small" style={{ margin: 0 }}>
        Provider keys are encrypted before they reach the database, and this server has no encryption key —
        so there is nowhere safe to put one yet. Rather than store your key in the clear, it refuses.
      </p>
      <p className="text-dim small" style={{ margin: 0 }}>
        Generate one and set it as <code>LLM_ENCRYPTION_KEY</code>:
      </p>
      <pre
        className="small"
        style={{
          margin: 0,
          padding: '8px 10px',
          background: 'var(--surface-2, rgba(127,127,127,0.08))',
          borderRadius: 6,
          overflowX: 'auto',
        }}
      >
        openssl rand -base64 32
      </pre>
      <p className="text-dim small" style={{ margin: 0 }}>
        Put it in <code>apps/web/.env.local</code> for local development, and in the hosting
        environment&apos;s variables for the deployed app — on Vercel, the <strong>same value</strong> on
        both Production and Preview, since previews share the production database. Restart afterwards; the
        value is read at boot.
      </p>
      <p className="text-dim small" style={{ margin: 0 }}>
        This is a deployment setting, not a permission — an owner account cannot grant it.
      </p>
    </div>
  );
}
