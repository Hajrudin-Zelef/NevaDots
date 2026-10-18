import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  Monitor,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Dot, Result, Status } from '../shared/types';
import { Mascot } from './Mascot';
import { ComputerPanel } from './ComputerPanel';
import { safeHostname, safeHref } from './safe-href';
export function ResultPane({
  latest,
  status,
  dotState,
  onClose,
  dots,
  defaultDotId,
}: {
  dots: Dot[];
  defaultDotId: string;
  latest?: Result | null;
  status?: Status;
  dotState: string;
  onClose: () => void;
}) {
  const [resultTab, setResultTab] = useState<'Brief' | 'Computer'>('Computer');
  const [computerDotId, setComputerDotId] = useState(defaultDotId);
  const computerDot =
    dots.find((dot) => dot.id === computerDotId) ??
    dots.find((dot) => dot.id === defaultDotId) ??
    dots[0];
  return (
    <aside className="result-pane">
      <div className="pane-header">
        <div className="pane-tabs">
          <button
            className={resultTab === 'Brief' ? 'selected' : ''}
            onClick={() => setResultTab('Brief')}
          >
            <BookOpen size={15} />
            Brief
          </button>
          <button
            className={resultTab === 'Computer' ? 'selected' : ''}
            onClick={() => setResultTab('Computer')}
          >
            <Monitor size={15} /> Navigateur
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="Close result panel"
          onClick={() => onClose()}
        >
          <X size={16} />
        </button>
      </div>
      {resultTab === 'Computer' ? (
        <>
          <label className="computer-dot-picker">
            Ordinateur de
            <select
              value={computerDot?.id ?? ''}
              onChange={(event) => setComputerDotId(event.target.value)}
              aria-label="Select Dot computer"
            >
              {dots.map((dot) => (
                <option key={dot.id} value={dot.id}>
                  {dot.name}
                </option>
              ))}
            </select>
          </label>
          {computerDot ? (
            <ComputerPanel key={computerDot.id} dot={computerDot} />
          ) : (
            <p className="computer-panel">
              Create a Dot to give it a computer.
            </p>
          )}
        </>
      ) : latest ? (
        <div className="result-content">
          <div className="result-meta">
            <span className="eyebrow">
              {latest.sample ? 'FICTIONAL SAMPLE BRIEF' : 'RESEARCH BRIEF'}
            </span>
            <button
              className="icon-button"
              aria-label="Download brief"
              onClick={() => {
                const blob = new Blob(
                  [
                    latest.text +
                      '\n\nSources\n' +
                      latest.sources
                        .map((s) => `${s.title}: ${s.url}`)
                        .join('\n'),
                  ],
                  { type: 'text/plain' },
                );
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = 'opendots-brief.txt';
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              <ArrowDownToLine size={16} />
            </button>
          </div>
          {latest.sample && (
            <div className="sample-note">
              An example of what Dot can do. The findings and sources below are
              invented.
            </div>
          )}
          <article className="brief">
            <ReactMarkdown
              components={{
                img: ({ alt }) => (
                  <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>
                ),
                a: ({ children, href }) => {
                  const safe = safeHref(href);
                  if (safe === null) return <span>{children}</span>;
                  return (
                    <a href={safe} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {latest.text}
            </ReactMarkdown>
          </article>
          <section className="sources">
            <h3>
              Source notes <span>{latest.sources.length}</span>
            </h3>
            {latest.sources.map((source) => {
              if (latest.sample) {
                return (
                  <div className="source-card" key={source.url}>
                    <span className="source-icon">
                      <BookOpen size={15} />
                    </span>
                    <div>
                      <strong>{source.title}</strong>
                      <p>{source.excerpt}</p>
                      <small>Fictional source · not a live link</small>
                    </div>
                  </div>
                );
              }
              const safe = safeHref(source.url);
              const hostname = safeHostname(source.url);
              const body = (
                <>
                  <span className="source-icon">
                    <ExternalLink size={15} />
                  </span>
                  <div>
                    <strong>{source.title}</strong>
                    <p>{source.excerpt}</p>
                    {hostname ? <small>{hostname}</small> : null}
                  </div>
                  <ArrowUpRight size={15} />
                </>
              );
              if (safe === null) {
                return (
                  <div className="source-card" key={source.url}>
                    {body}
                  </div>
                );
              }
              return (
                <a
                  className="source-card"
                  href={safe}
                  key={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {body}
                </a>
              );
            })}
          </section>
        </div>
      ) : (
        <div className="pane-empty">
          <Mascot
            identity={defaultDotId}
            name={dots.find((dot) => dot.id === defaultDotId)?.name}
            state={dotState}
          />
          <h3>A little space for your findings.</h3>
          <p>
            {status === 'failed'
              ? 'Resolve the error and retry to create a research brief.'
              : 'Your brief and sources will appear here after a successful run.'}
          </p>
        </div>
      )}
    </aside>
  );
}
