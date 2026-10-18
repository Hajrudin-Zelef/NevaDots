import { expect, it } from 'vitest';
import { resolveUploadType, sniffMime } from '../src/server/magic-bytes.js';

it('sniffs PDF/PNG/JPEG/GIF/WebP signatures', () => {
  expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
  expect(
    sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ).toBe('image/png');
  expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
    'image/jpeg',
  );
  expect(sniffMime(Buffer.from('GIF87a'))).toBe('image/gif');
  expect(sniffMime(Buffer.from('GIF89a'))).toBe('image/gif');
  expect(sniffMime(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp');
});

it('returns null for unknown, truncated or empty content', () => {
  expect(sniffMime(Buffer.from('<!DOCTYPE html>'))).toBeNull();
  expect(sniffMime(Buffer.from('hello'))).toBeNull();
  expect(sniffMime(new Uint8Array([]))).toBeNull();
  expect(sniffMime(new Uint8Array([0x89, 0x50]))).toBeNull(); // PNG tronqué
  expect(sniffMime(Buffer.from('RIFFxxxxXXXX'))).toBeNull(); // RIFF sans WEBP
});

it('keeps a declared type whose bytes match (and normalizes aliases)', () => {
  expect(
    resolveUploadType(Buffer.from('%PDF-1.7'), 'application/pdf', 'doc.pdf'),
  ).toEqual({ mime: 'application/pdf', ok: true });
  expect(
    resolveUploadType(
      new Uint8Array([0xff, 0xd8, 0xff]),
      'image/jpg',
      'photo.jpg',
    ),
  ).toEqual({ mime: 'image/jpeg', ok: true });
  expect(
    resolveUploadType(Buffer.from('hello'), 'text/plain', 'notes.txt'),
  ).toEqual({ mime: 'text/plain', ok: true });
  expect(
    resolveUploadType(Buffer.from('<svg></svg>'), 'image/svg+xml', 'icon.svg'),
  ).toEqual({ mime: 'image/svg+xml', ok: true });
});

it('downgrades a declared image/pdf whose bytes do not match', () => {
  expect(
    resolveUploadType(Buffer.from('<!DOCTYPE html>'), 'image/png', 'fake.png'),
  ).toEqual({ mime: 'application/octet-stream', ok: false });
  expect(
    resolveUploadType(Buffer.from('hello'), 'application/pdf', 'fake.pdf'),
  ).toEqual({ mime: 'application/octet-stream', ok: false });
  // Extension .pdf seule (déclaré octet-stream) : aussi vérifiée.
  expect(
    resolveUploadType(
      Buffer.from('hello'),
      'application/octet-stream',
      'fake.pdf',
    ),
  ).toEqual({ mime: 'application/octet-stream', ok: false });
  // ... mais un vrai PDF déclaré octet-stream passe (octets = preuve).
  expect(
    resolveUploadType(
      Buffer.from('%PDF-1.7'),
      'application/octet-stream',
      'doc.pdf',
    ),
  ).toEqual({ mime: 'application/octet-stream', ok: true });
});
