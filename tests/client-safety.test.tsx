import { expect, it, vi } from 'vitest';
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

it('safeHref ne laisse passer que http/https/mailto et les liens Spaces', () => {
  expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
  expect(safeHref('http://example.com')).toBe('http://example.com');
  expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
  expect(safeHref('/#/spaces/abc')).toBe('/#/spaces/abc');
  // Neutralisés : texte affiché sans lien cliquable.
  expect(safeHref('javascript:alert(1)')).toBeNull();
  expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
  expect(safeHref('java\tscript:alert(1)')).toBeNull();
  expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  expect(safeHref('vbscript:msgbox(1)')).toBeNull();
  expect(safeHref('//evil.com/x')).toBeNull();
  expect(safeHref('/relative/path')).toBeNull();
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

it('ChatTranscript neutralise les liens piégés du modèle', () => {
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

it('PageReviewCard neutralise les liens piégés du brouillon', () => {
  const html = renderToStaticMarkup(
    <PageReviewCard
      args={{
        title: 'T',
        content: '[piège](data:text/html,phishing) [ok](mailto:a@b.c)',
        spaceId: 's1',
      }}
      status="complete"
      threadId="t"
      toolCallId="c"
      onSaved={() => {}}
    />,
  );
  expect(html).not.toContain('data:text/html');
  expect(html).toContain('href="mailto:a@b.c"');
  expect(html).toContain('piège');
});

it('ResultPane neutralise les liens piégés et ne plante pas sur une URL source malformée', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ResultPane
        latest={{
          text: '[piège](javascript:alert(1)) [ok](https://example.com)',
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
  // Onglet Brief (l'onglet initial est Computer).
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
  const json = JSON.stringify(renderer!.toJSON());
  expect(json).not.toContain('javascript:');
  expect(json).toContain('https://example.com');
  // Carte source rendue malgré l'URL malformée (pas de hostname affiché).
  expect(json).toContain('T');
  expect(json).toContain('E');
});

it('ErrorBoundary affiche un repli au lieu de l’écran blanc', () => {
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

it('FilePreviewModal : iframe PDF avec sandbox=""', () => {
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
