import { describe, expect, it } from 'vitest';
import { parseGitStatus, parseLanternProject, parseLaunchctlList } from '@process/cockpit/lanternProjects';

describe('parseLaunchctlList', () => {
  it('keeps prefixed labels and reads pid and exit code', () => {
    const out =
      'PID\tStatus\tLabel\n123\t0\tcom.rayak.grocery.dashboard\n-\t1\tcom.rayak.grocery.refresh\n55\t0\tcom.apple.x\n';
    expect(parseLaunchctlList(out, ['com.rayak.'])).toEqual([
      { label: 'com.rayak.grocery.dashboard', pid: 123, lastExit: 0, running: true },
      { label: 'com.rayak.grocery.refresh', pid: null, lastExit: 1, running: false },
    ]);
  });
});

describe('parseGitStatus', () => {
  it('reads branch, ahead/behind and dirty files', () => {
    const out =
      '# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file.ts\n? new.txt\n';
    expect(parseGitStatus('C:/r', out)).toEqual({ dir: 'C:/r', branch: 'main', ahead: 2, behind: 1, dirty: 2 });
  });
});

describe('parseLanternProject', () => {
  it('resolves folders and tolerates bad modules', async () => {
    const project = await parseLanternProject('C:/nowhere/Rayak', {
      name: 'Rayak',
      members: ['../data'],
      modules: [{ id: 'web', name: 'Website', kind: 'weird', folder: '.' }, { name: 'no id' }],
    });
    expect(project.name).toBe('Rayak');
    expect(project.members[0].toLowerCase()).toContain('data');
    expect(project.modules).toHaveLength(1);
    expect(project.modules[0].kind).toBe('agent');
    expect(project.modules[0].context).toBeUndefined();
  });
});

describe('listLanternProjects', () => {
  it('skips hidden folders such as Lantern', async () => {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-projects-'));
    await fs.mkdir(path.join(root, 'Lantern'));
    await fs.mkdir(path.join(root, 'Rayak'));
    const { listLanternProjects } = await import('@process/cockpit/lanternProjects');
    expect((await listLanternProjects(root)).map((p) => p.name)).toEqual(['Rayak']);
    await fs.rm(root, { recursive: true, force: true });
  });
});
