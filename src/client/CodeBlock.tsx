import { useMemo, useState } from 'react';
import { Check, Copy, Maximize2, X } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';

// Langages enregistrés (bundle maîtrisé) : `xml` couvre `html`.
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);

/** Échappement HTML minimal pour le repli texte brut. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function displayLanguage(language: string): string {
  if (!language) return 'Texte';
  const short: Record<string, string> = {
    js: 'JavaScript',
    ts: 'TypeScript',
    md: 'Markdown',
    sh: 'Shell',
    yml: 'YAML',
  };
  const known = short[language.toLowerCase()] ?? language;
  return known.charAt(0).toUpperCase() + known.slice(1);
}

/**
 * Bloc de code façon carte sombre : en-tête (langage, copier, agrandir),
 * coloration syntaxique highlight.js. `expand` ouvre la même carte en
 * plein écran. Utilisé pour les blocs clôturés ; le code inline garde
 * la pastille bleue (`code` dans `markdown-components.tsx`).
 */
export function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const supported = !!language && !!hljs.getLanguage(language.toLowerCase());
  const html = useMemo(() => {
    try {
      if (supported)
        return hljs.highlight(code, { language: language.toLowerCase() }).value;
    } catch {
      /* repli : texte brut échappé ci-dessous */
    }
    return escapeHtml(code);
  }, [language, code, supported]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Repli : sélection manuelle (contexte non sécurisé, vieux navigateur).
      const area = document.createElement('textarea');
      area.value = code;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const label = supported ? displayLanguage(language) : 'Texte';
  return (
    <>
      <div className="code-card">
        <div className="code-card-header">
          <span className="code-card-lang">{label}</span>
          <span className="code-card-actions">
            <button
              type="button"
              className="code-card-button"
              aria-label={copied ? 'Copié' : 'Copier le code'}
              title={copied ? 'Copié' : 'Copier le code'}
              onClick={() => void copy()}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button
              type="button"
              className="code-card-button"
              aria-label="Agrandir le code"
              title="Agrandir"
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={15} />
            </button>
          </span>
        </div>
        <pre className="code-card-body">
          <code
            className={language ? `language-${language}` : undefined}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      </div>
      {expanded && (
        <div
          className="code-card-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Code ${label} en plein écran`}
          onClick={() => setExpanded(false)}
        >
          <div
            className="code-card code-card-full"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="code-card-header">
              <span className="code-card-lang">{label}</span>
              <span className="code-card-actions">
                <button
                  type="button"
                  className="code-card-button"
                  aria-label={copied ? 'Copié' : 'Copier le code'}
                  title={copied ? 'Copié' : 'Copier le code'}
                  onClick={() => void copy()}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
                <button
                  type="button"
                  className="code-card-button"
                  aria-label="Fermer le plein écran"
                  title="Fermer"
                  onClick={() => setExpanded(false)}
                >
                  <X size={16} />
                </button>
              </span>
            </div>
            <pre className="code-card-body">
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        </div>
      )}
    </>
  );
}
