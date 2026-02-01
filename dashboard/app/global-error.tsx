"use client";

/**
 * Global error boundary — catches errors in the root layout itself.
 * Must provide its own <html> and <body> since the root layout may have failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "#fafafa",
          color: "#111",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: 14, color: "#666", marginTop: 8 }}>
            A critical error occurred. Please try refreshing the page.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: 12,
                color: "#999",
                fontFamily: "monospace",
                marginTop: 8,
              }}
            >
              Error ID: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              fontSize: 14,
              border: "1px solid #ddd",
              borderRadius: 6,
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
