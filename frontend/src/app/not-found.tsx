import Link from "next/link";

export default function NotFound() {
  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <p style={codeStyle}>404</p>
        <h1 style={titleStyle}>Page not found.</h1>
        <p style={messageStyle}>
          The page you&rsquo;re looking for doesn&rsquo;t exist or has been moved.
        </p>
        <div style={actionsStyle}>
          <Link href="/dashboard" style={primaryBtnStyle}>
            Back to dashboard →
          </Link>
          <Link href="/evals" style={secondaryBtnStyle}>
            See the eval set
          </Link>
        </div>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-xl)",
  fontFamily: "var(--font-body)",
};

const cardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-2xl)",
  maxWidth: 480,
  width: "100%",
  textAlign: "center",
};

const codeStyle: React.CSSProperties = {
  color: "var(--accent-ink)",
  fontFamily: "var(--font-mono)",
  fontSize: "4rem",
  fontWeight: 700,
  letterSpacing: "-0.04em",
  lineHeight: 1,
  marginBottom: "var(--space-md)",
};

const titleStyle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "1.75rem",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  marginBottom: "var(--space-md)",
};

const messageStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "0.95rem",
  lineHeight: 1.55,
  marginBottom: "var(--space-lg)",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-md)",
  flexWrap: "wrap",
  justifyContent: "center",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--brand-primary)",
  color: "var(--text-inverse)",
  border: "none",
  borderRadius: "var(--radius-md)",
  padding: "10px 18px",
  fontFamily: "var(--font-mono)",
  fontWeight: 700,
  fontSize: "0.8rem",
  letterSpacing: "0.05em",
  textDecoration: "none",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  padding: "10px 18px",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "0.8rem",
  letterSpacing: "0.05em",
  textDecoration: "none",
};
