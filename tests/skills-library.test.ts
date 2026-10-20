import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLibrary } from '../src/server/skills-library';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function write(root: string, rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    'repo-a/skills/alpha/SKILL.md',
    `---
name: alpha
description: >
  Folded description about alpha
  playbooks and planning.
---

# Alpha
Body.`,
  );
  write(root, 'repo-a/skills/alpha/scripts/run.sh', '#!/bin/sh\necho hi\n');
  write(
    root,
    'repo-b/skills/alpha/SKILL.md',
    `---
name: alpha
description: |
  Literal description for the second alpha.
---
# Alpha two`,
  );
  write(
    root,
    'repo-c/skills/broken/SKILL.md',
    `---
name: broken
description: >-
  Unclosed? no: this is valid.
---

Paragraph fallback is not needed here.`,
  );
  // Frontmatter invalide : repli sur le premier paragraphe du corps.
  write(
    root,
    'repo-c/skills/nofm/SKILL.md',
    `# No frontmatter

A useful paragraph that explains what this skill does in detail.`,
  );
  const lib = new SkillLibrary(root);
  return { root, lib };
}

describe('SkillLibrary', () => {
  it('indexe les SKILL.md et désambiguïse les noms identiques par repo', () => {
    const { lib } = fixture();
    expect(lib.size).toBe(4);
    const ids = lib.list(10).map((skill) => skill.id);
    expect(ids).toContain('repo-a/alpha');
    expect(ids).toContain('repo-b/alpha');
    expect(ids).toContain('repo-c/nofm');
  });

  it('parse les descriptions YAML pliées/littérales et replie sans frontmatter', () => {
    const { lib } = fixture();
    expect(lib.get('repo-a/alpha')?.descriptionFull).toContain(
      'Folded description about alpha playbooks and planning.',
    );
    expect(lib.get('repo-b/alpha')?.descriptionFull).toContain(
      'Literal description for the second alpha.',
    );
    expect(lib.get('repo-c/nofm')?.name).toBe('nofm');
    expect(lib.get('repo-c/nofm')?.descriptionFull).toContain(
      'A useful paragraph',
    );
  });

  it('recherche déterministe sur nom + description', () => {
    const { lib } = fixture();
    expect(lib.search('planning playbooks', 5)[0]?.id).toBe('repo-a/alpha');
    expect(lib.search('literal second', 5)[0]?.id).toBe('repo-b/alpha');
    expect(lib.search('zzz-absent', 5)).toEqual([]);
  });

  it('ignore les symlinks et les dossiers techniques', () => {
    const { root, lib } = fixture();
    symlinkSync(join(root, 'repo-a'), join(root, 'repo-link'));
    mkdirSync(join(root, 'repo-a/skills/alpha/node_modules/x'), {
      recursive: true,
    });
    write(
      root,
      'repo-a/skills/alpha/node_modules/x/SKILL.md',
      '---\nname: nope\n---',
    );
    lib.reindex();
    expect(lib.size).toBe(4);
  });

  it('borne le contenu et change de version quand une ressource change', () => {
    const { root, lib } = fixture();
    const before = lib.get('repo-a/alpha')!.version;
    const content = lib.content('repo-a/alpha', 20);
    expect(content?.text.length).toBe(20);
    expect(content?.truncated).toBe(true);
    expect(content?.totalChars).toBeGreaterThan(20);
    write(
      root,
      'repo-a/skills/alpha/scripts/run.sh',
      '#!/bin/sh\necho changed\n',
    );
    lib.reindex();
    expect(lib.get('repo-a/alpha')!.version).not.toBe(before);
  });
});
