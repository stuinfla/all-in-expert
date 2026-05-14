import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Takedown & Corrections · Ask the All-In Experts",
  description:
    "DMCA takedown, correction, and removal-request workflow for the All-In Expert research tool. Response SLA: 7 business days.",
};

export default function LegalPage() {
  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-[var(--border)] relative">
        <div className="max-w-3xl mx-auto px-6 pt-10 pb-8 sm:pt-14 sm:pb-12">
          <nav className="flex items-center justify-between mb-8 gap-3 flex-wrap">
            <div className="flex items-center gap-4">
              <div className="eyebrow">№ 02 · Legal Notices</div>
            </div>
            <Link
              href="/"
              className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition border border-[var(--border)] px-3 py-1.5 hover:border-[var(--gold-rule)]"
            >
              ← Return to Dossier
            </Link>
          </nav>

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-4xl sm:text-6xl leading-[0.92] tracking-tight">
                Takedown &amp;
                <br />
                <span className="text-[var(--gold-bright)] font-display-italic">
                  Correction
                </span>{" "}
                <span className="font-display">Requests</span>
              </h1>
              <p className="mt-5 text-[var(--ink-dim)] text-base sm:text-lg max-w-xl leading-relaxed">
                Rights-holder and named-subject workflow. Response SLA:{" "}
                <span className="text-[var(--gold)] font-mono text-sm tracking-wider">
                  7 BUSINESS DAYS
                </span>
                .
              </p>
            </div>
            <div className="hidden sm:flex flex-col items-end gap-1 text-right">
              <div className="font-mono text-[10px] tracking-[0.2em] text-[var(--ink-mute)] uppercase">
                Vol. I
              </div>
              <div className="font-display text-2xl text-[var(--gold)]">§</div>
              <div className="font-mono text-[10px] tracking-[0.2em] text-[var(--ink-mute)] uppercase">
                MMXXVI
              </div>
            </div>
          </div>

          <div className="rule-gold mt-10" />
        </div>
      </header>

      {/* ─── Body ────────────────────────────────────────────────── */}
      <div className="flex-1 max-w-3xl mx-auto px-6 py-10 sm:py-14 w-full">
        <article className="p-6 sm:p-10 border border-[var(--border-gold)] bg-[var(--bg-card)] relative">
          <div className="absolute top-0 left-0 w-full rule-gold" />

          <div className="prose-dossier">
            <p className="font-display italic text-lg leading-relaxed text-[var(--ink)]">
              The All-In Expert is a research tool that synthesizes positions
              from the publicly-broadcast{" "}
              <a
                href="https://allin.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--gold)] hover:text-[var(--gold-bright)] transition"
              >
                All-In Podcast
              </a>
              . All transcripts are derived from publicly-available YouTube
              auto-captions. Quoted segments are limited to ≤280 characters per
              fair-use guidelines for transformative research and citation.
            </p>

            <div className="my-8 rule-gold" />

            <div className="eyebrow mb-4">§ Scope of requests</div>
            <p className="text-[var(--ink-dim)] mb-3">
              If you are a rights-holder or named subject and wish to:
            </p>
            <ul className="space-y-2 mb-8 text-[var(--ink-dim)]">
              <li className="flex gap-3">
                <span className="text-[var(--gold)] font-mono text-xs mt-1.5">
                  ◆
                </span>
                <span>
                  <strong className="text-[var(--ink)]">
                    Remove specific transcript excerpts
                  </strong>{" "}
                  from the index
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-[var(--gold)] font-mono text-xs mt-1.5">
                  ◆
                </span>
                <span>
                  <strong className="text-[var(--ink)]">
                    Correct misattributed statements
                  </strong>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-[var(--gold)] font-mono text-xs mt-1.5">
                  ◆
                </span>
                <span>
                  <strong className="text-[var(--ink)]">
                    Update biographical facts
                  </strong>{" "}
                  in the speaker profiles
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-[var(--gold)] font-mono text-xs mt-1.5">
                  ◆
                </span>
                <span>
                  <strong className="text-[var(--ink)]">
                    Disable the entire site
                  </strong>
                </span>
              </li>
            </ul>

            <div className="eyebrow mb-4">§ How to file</div>
            <p className="text-[var(--ink-dim)] mb-4">
              Send an email to{" "}
              <code className="font-mono text-sm text-[var(--gold-bright)] bg-[var(--bg-elev)] border border-[var(--gold-rule)] px-2 py-0.5">
                takedown@asktheallinexperts.vercel.app
              </code>{" "}
              with:
            </p>
            <ol className="space-y-2 mb-8 text-[var(--ink-dim)] list-none counter-reset">
              <li className="flex gap-3">
                <span className="font-mono text-xs text-[var(--gold)] tracking-widest mt-1">
                  01
                </span>
                <span>
                  Your name + relationship to the content (rights-holder, named
                  subject, legal representative)
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-xs text-[var(--gold)] tracking-widest mt-1">
                  02
                </span>
                <span>
                  URL or screenshot of the specific synthesis or citation
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-xs text-[var(--gold)] tracking-widest mt-1">
                  03
                </span>
                <span>The episode + timestamp of the source content</span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-xs text-[var(--gold)] tracking-widest mt-1">
                  04
                </span>
                <span>
                  Brief description of the issue (factual error, copyright,
                  defamation, privacy)
                </span>
              </li>
            </ol>

            <div className="mb-8 inline-flex items-center gap-3 px-4 py-2 border border-[var(--border-gold)] bg-[var(--gold-soft)]">
              <span className="w-2 h-2 rounded-full bg-[var(--gold)] anim-shimmer"></span>
              <div className="font-mono text-[10px] sm:text-[11px] tracking-widest uppercase">
                <span className="text-[var(--gold-bright)]">Response SLA</span>{" "}
                <span className="text-[var(--ink)]">
                  · within 7 business days, with action or substantive reply
                </span>
              </div>
            </div>

            <div className="eyebrow mb-4">§ DMCA notices</div>
            <p className="text-[var(--ink-dim)] mb-8">
              For DMCA notices specifically, follow the standard DMCA template
              (
              <span className="font-mono text-sm text-[var(--gold)]">
                17 USC § 512(c)(3)
              </span>
              ) and send to the same address. The site operator is an
              individual research project; designated agent contact is the same
              email.
            </p>

            <div className="rule-gold-double my-8" />

            <div className="eyebrow mb-4">§ Affiliation disclaimer</div>
            <p className="font-display italic text-base text-[var(--ink)] leading-relaxed">
              This tool is{" "}
              <strong className="not-italic text-[var(--gold-bright)] uppercase tracking-wider text-sm">
                not affiliated with
              </strong>
              , endorsed by, or operated by the All-In Podcast, its hosts, or
              guests. All names and likenesses are used for research,
              commentary, and citation under fair use.
            </p>
          </div>

          <div className="absolute bottom-0 left-0 w-full rule-gold" />
        </article>

        <div className="mt-8 flex justify-center">
          <Link
            href="/"
            className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition border border-[var(--border)] px-4 py-2 hover:border-[var(--gold-rule)]"
          >
            ← Return to Dossier
          </Link>
        </div>
      </div>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--border)] mt-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="font-mono text-[10px] text-[var(--ink-faint)] tracking-widest uppercase flex items-center justify-between flex-wrap gap-2">
            <div>Ask the All-In Experts · Vol. I · MMXXVI</div>
            <div>© {new Date().getFullYear()} IsoVision AI</div>
          </div>
        </div>
      </footer>
    </main>
  );
}
