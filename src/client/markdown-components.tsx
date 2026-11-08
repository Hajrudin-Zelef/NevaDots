import { Children, isValidElement, type ReactNode } from 'react';
import { openPageLink } from './page-navigation';
import { safeHref } from './safe-href';
import { CodeBlock } from './CodeBlock';

/**
 * Map de composants partagée par tous les rendus ReactMarkdown du client
 * (chat, brief, revue de page). Point unique : images neutralisées en texte,
 * liens filtrés par `safeHref`, liens internes `/#/spaces/` navigués dans
 * l'app. Stable (const) pour ne pas forcer de re-parse. Règle : tout nouveau
 * rendu Markdown DOIT réutiliser cette map (jamais de map inline).
 */
export const markdownComponents = {
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safe = safeHref(href);
    if (safe === null) return <span>{children}</span>;
    const internal = safe.startsWith('/#/spaces/');
    return (
      <a
        onClick={(event) => {
          if (internal) {
            event.preventDefault();
            openPageLink(safe);
          }
        }}
        href={safe}
        target={internal ? undefined : '_blank'}
        rel="noreferrer"
      >
        {children}
      </a>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => {
    // Bloc clôturé ```lang : carte sombre façon Claude (langage, copie,
    // agrandir, coloration). Le code inline n'a pas de `pre` : il garde
    // la pastille bleue via `code`.
    const child = Children.toArray(children)[0];
    if (isValidElement<{ className?: string; children?: unknown }>(child)) {
      const className = child.props.className ?? '';
      const language = /language-([\w+-]+)/.exec(className)?.[1] ?? '';
      const text = String(child.props.children ?? '').replace(/\n$/, '');
      if (language || text.includes('\n'))
        return <CodeBlock language={language} code={text} />;
    }
    return <pre>{children}</pre>;
  },
};
