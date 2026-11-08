import { expect, describe, it, vi } from 'vitest';
import { act, Children } from 'react';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';
import { safeHref, safeHost, safeHostname } from '../src/client/safe-href';
import { ErrorBoundary } from '../src/client/ErrorBoundary';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { PageReviewCard } from '../src/client/PageReviewCard';
import { ResultPane } from '../src/client/ResultPane';
import { FilePreviewModal } from '../src/client/FilePreviewModal';
import type { Message } from '@ag-ui/core';

const TABLE_MD = '| Élément | Détail |\n| --- | --- |\n| A | B |\n| C | D |';

function assistantTableMessage() {
  return [
    {
      id: 'm1',
      role: 'assistant',
      content: TABLE_MD,
    } as unknown as Message,
  ];
}

describe('safeHref', () => {
  it('ne laisse passer que http/https/mailto, liens Spaces et téléchargements attachments', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('/#/spaces/abc')).toBe('/#/spaces/abc');
    // F1 : lien de fichier généré par le Dot — cliquable + téléchargeable.
    const dl =
      '/api/attachments/907998d3-bf18-46a9-9bc2-03c0153d6705/content?download=1';
    expect(safeHref(dl)).toBe(dl);
    expect(
      safeHref('/api/attachments/907998d3-bf18-46a9-9bc2-03c0153d6705/content'),
    ).toBe('/api/attachments/907998d3-bf18-46a9-9bc2-03c0153d6705/content');
    // Neutralisés : texte affiché sans lien cliquable.
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeHref('//evil.com/x')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('/api/attachments/not-a-uuid/content')).toBeNull();
    expect(
      safeHref('/api/attachments/xxx/content?download=1&evil=1'),
    ).toBeNull();
    expect(safeHref('/api/other')).toBeNull();
    expect(safeHref('#anchor')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });

  it('safeHostname / safeHost ne jettent jamais sur une URL malformée', () => {
    expect(safeHostname('https://example.com:8080/x')).toBe('example.com');
    expect(safeHostname('not a url')).toBeNull();
    expect(safeHostname(undefined)).toBeNull();
    expect(safeHost('https://example.com:8080/x')).toBe('example.com:8080');
    expect(safeHost('not a url')).toBeNull();
  });
});

describe('ChatTranscript', () => {
  it('neutralise les liens piégés du modèle', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'm1',
            role: 'user',
            content:
              '[piège](javascript:alert(1)) [ok](https://example.com) [interne](/#/spaces/abc)',
          } as unknown as Message,
        ]}
        calls={[]}
      />,
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="/#/spaces/abc"');
    expect(html).toContain('piège');
  });

  it('rend les tableaux GFM au lieu du brut', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript messages={assistantTableMessage()} calls={[]} />,
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Élément</th>');
    expect(html).toContain('<td>B</td>');
    expect(html).not.toContain('| --- |');
  });

  it('rend les liens de téléchargement attachments cliquables (F1)', () => {
    const id = '907998d3-bf18-46a9-9bc2-03c0153d6705';
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: `[dames.html](/api/attachments/${id}/content?download=1)`,
          } as unknown as Message,
        ]}
        calls={[]}
      />,
    );
    expect(html).toContain(`/api/attachments/${id}/content?download=1`);
    expect(html).toContain('download');
    expect(html).toContain('dames.html');
  });

  it('rend les blocs de code en carte sombre avec langage et copie', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: '```html\n<div class="x">ok</div>\n```',
          } as unknown as Message,
        ]}
        calls={[]}
      />,
    );
    expect(html).toContain('code-card');
    expect(html).toContain('Html');
    expect(html).toContain('Copier le code');
    expect(html).toContain('Agrandir le code');
    // Coloration appliquée (pas de code brut) : balise mise en valeur.
    expect(html).toContain('hljs-');
  });

  it('bloc sans langage ou langage inconnu : repli texte sans planter', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: '```zzzlang\nligne 1\nligne 2\n```',
          } as unknown as Message,
        ]}
        calls={[]}
      />,
    );
    expect(html).toContain('code-card');
    expect(html).toContain('Texte');
    expect(html).toContain('ligne 1');
  });

  it('neutralise les images en texte (alt seul)', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: '![piège](https://example.com/x.png)',
          } as unknown as Message,
        ]}
        calls={[]}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('piège');
  });
});

describe('PageReviewCard', () => {
  function renderCard(content: string): string {
    return renderToStaticMarkup(
      <PageReviewCard
        args={{ title: 'T', content, spaceId: 's1' }}
        status="complete"
        threadId="t"
        toolCallId="c"
        onSaved={() => {}}
      />,
    );
  }

  it('neutralise les liens piégés du brouillon', () => {
    const html = renderCard(
      '[piège](data:text/html,phishing) [ok](mailto:a@b.c)',
    );
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('piège');
  });

  it('rend les tableaux GFM du brouillon', () => {
    const html = renderCard(TABLE_MD);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Élément</th>');
    expect(html).not.toContain('| --- |');
  });
});

describe('ResultPane', () => {
  /** Rend l'onglet Brief (l'onglet initial est Computer) en JSON texte. */
  function renderBriefToJson(text: string): string {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ResultPane
          latest={{
            text,
            sources: [{ title: 'T', url: 'not a url', excerpt: 'E' }],
            sample: false,
          }}
          dotState=""
          onClose={() => {}}
          dots={[]}
          defaultDotId=""
        />,
      );
    });
    const briefTab = renderer!.root
      .findAllByType('button')
      .find((b) =>
        Children.toArray(b.props.children).some(
          (child) => typeof child === 'string' && child.includes('Brief'),
        ),
      );
    expect(briefTab).toBeTruthy();
    act(() => {
      briefTab!.props.onClick();
    });
    return JSON.stringify(renderer!.toJSON());
  }

  it('neutralise les liens piégés et ne plante pas sur une URL source malformée', () => {
    const json = renderBriefToJson(
      '[piège](javascript:alert(1)) [ok](https://example.com)',
    );
    expect(json).not.toContain('javascript:');
    expect(json).toContain('https://example.com');
    // Carte source rendue malgré l'URL malformée (pas de hostname affiché).
    expect(json).toContain('T');
    expect(json).toContain('E');
  });

  it('rend les tableaux GFM du brief', () => {
    const json = renderBriefToJson(TABLE_MD);
    expect(json).toContain('Élément');
    expect(json).not.toContain('| --- |');
  });
});

describe('ErrorBoundary', () => {
  it('affiche un repli au lieu de l’écran blanc', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      function Thrower(): never {
        throw new Error('boom');
      }
      let renderer: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <ErrorBoundary>
            <Thrower />
          </ErrorBoundary>,
        );
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        'Something went wrong',
      );
      let ok: TestRenderer.ReactTestRenderer;
      act(() => {
        ok = TestRenderer.create(
          <ErrorBoundary>
            <span>fine</span>
          </ErrorBoundary>,
        );
      });
      expect(JSON.stringify(ok!.toJSON())).toContain('fine');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FilePreviewModal', () => {
  it('iframe PDF avec sandbox=""', () => {
    const html = renderToStaticMarkup(
      <FilePreviewModal
        attachment={{
          id: 'att-1',
          name: 'doc.pdf',
          size: 1000,
          mime: 'application/pdf',
          category: 'pdf',
          status: 'ready',
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('sandbox=""');
  });
});
