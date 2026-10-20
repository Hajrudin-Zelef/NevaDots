import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from './request-context.js';
import type { SkillLibrary } from './skills-library.js';
import type { WorkspaceStore } from './workspace.js';

/** Diagnostic + reindex de la bibliothèque de skills (host). */
export function skillRoutes(skills: SkillLibrary, workspace: WorkspaceStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  // Bundle d'un skill (tar.gz) : ticket à usage unique minté par load_skill.
  // Appelé par le conteneur du Dot via le bridge Docker ; exempté de session
  // dans app.ts, l'authentification EST le ticket.
  app.get('/skills/bundle', (c) => {
    const bound = skills.consumeBundle(c.req.query('ticket') ?? '');
    if (!bound) return c.json({ error: 'Invalid or expired ticket.' }, 401);
    const skill = skills.get(bound.skillId);
    if (!skill) return c.json({ error: 'Skill not found.' }, 404);
    const child = spawn('tar', ['-czf', '-', '-C', skill.dir, '.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.on('error', () => {});
    return c.body(Readable.toWeb(child.stdout) as ReadableStream, 200, {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  // Diagnostic Admin : mint un ticket de bundle (30 s) pour vérifier le
  // transfert vers un conteneur sans passer par un tour de modèle.
  app.post('/skills/:id/ticket', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    const id = decodeURIComponent(c.req.param('id'));
    if (!skills.get(id)) return c.json({ error: 'Skill not found.' }, 404);
    return c.json({
      id,
      ticket: skills.mintBundle(id, `admin:${c.get('userId')}`),
      expiresInMs: 30_000,
    });
  });
  // Gouvernance Admin : kill switch global + allowlist par compte + usage.
  app.get('/skills/policy', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    return c.json({
      policy: workspace.skillsPolicy(),
      usage: workspace.skillUsageAll(),
    });
  });
  app.put('/skills/policy', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    const data = z
      .object({
        enabled: z.boolean().optional(),
        allowedUsers: z
          .array(z.string().trim().min(1).max(100))
          .max(1000)
          .nullable()
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Invalid skills policy.' }, 400);
    return c.json({ policy: workspace.setSkillsPolicy(data.data) });
  });
  app.get('/skills/usage', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    return c.json({ usage: workspace.skillUsageAll() });
  });
  app.get('/skills', (c) => {
    const query = (c.req.query('query') ?? '').trim();
    const raw = Number(c.req.query('limit') ?? 5);
    const limit = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 1), 10)
      : 5;
    return c.json({
      size: skills.size,
      skipped: skills.skippedCount,
      indexedAt: skills.lastLoadedAt,
      query,
      skills: query ? skills.search(query, limit) : skills.list(limit),
    });
  });
  // Instance-wide: réservé à l'Admin (le propriétaire bootstrap l'est).
  app.post('/skills/reindex', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    const count = skills.reindex();
    return c.json({
      count,
      skipped: skills.skippedCount,
      indexedAt: skills.lastLoadedAt,
    });
  });
  return app;
}
