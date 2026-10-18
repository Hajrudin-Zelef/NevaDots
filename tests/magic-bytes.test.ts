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
  expect(
    sniffMime(
      Buffer.from([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      ]),
    ),
  ).toBe('image/avif');
  expect(sniffMime(Buffer.from('BM'))).toBe('image/bmp');
  expect(sniffMime(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe(
    'image/tiff',
  );
  expect(sniffMime(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]))).toBe(
    'image/tiff',
  );
  expect(sniffMime(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe(
    'image/x-icon',
  );
});

it('returns null for unknown, truncated or empty content', () => {
  expect(sniffMime(Buffer.from('<!DOCTYPE html>'))).toBeNull();
  expect(sniffMime(Buffer.from('hello'))).toBeNull();
  expect(sniffMime(new Uint8Array([]))).toBeNull();
  expect(sniffMime(new Uint8Array([0x89, 0x50]))).toBeNull(); // PNG tronqué
  expect(sniffMime(Buffer.from('RIFFxxxxXXXX'))).toBeNull(); // RIFF sans WEBP
  // ftyp + isom = MP4, pas AVIF.
  expect(
    sniffMime(
      Buffer.from([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ]),
    ),
  ).toBeNull();
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
  // Nouvelles signatures : AVIF / BMP / TIFF / ICO conservés.
  expect(
    resolveUploadType(
      Buffer.from([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      ]),
      'image/avif',
      'photo.avif',
    ),
  ).toEqual({ mime: 'image/avif', ok: true });
  expect(
    resolveUploadType(Buffer.from('BM'), 'image/bmp', 'photo.bmp'),
  ).toEqual({ mime: 'image/bmp', ok: true });
  expect(
    resolveUploadType(
      new Uint8Array([0x49, 0x49, 0x2a, 0x00]),
      'image/tiff',
      'scan.tiff',
    ),
  ).toEqual({ mime: 'image/tiff', ok: true });
  expect(
    resolveUploadType(
      new Uint8Array([0x00, 0x00, 0x01, 0x00]),
      'image/x-icon',
      'favicon.ico',
    ),
  ).toEqual({ mime: 'image/x-icon', ok: true });
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
