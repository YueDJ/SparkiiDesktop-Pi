import { lstatSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivacyRedactions } from '../electron/main/privacy-redactions.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-redactions-'));
  const file = join(dir, 'registry.json');
  return { dir, file, initialized: `${file}.initialized` };
}

describe('PrivacyRedactions', () => {
  it('allows a genuinely empty first install and creates a secret-free tombstone on first registration', () => {
    const { file, initialized } = fixture();
    const redactions = new PrivacyRedactions(file);
    expect(redactions.size).toBe(0);
    expect(redactions.marker()).toBe('[已删除]');
    expect(() => lstatSync(file)).toThrow();
    expect(() => lstatSync(initialized)).toThrow();

    const secret = 'R8_PRIVACY_INITIAL_SECRET_71C';
    redactions.register([secret]);
    expect(lstatSync(initialized).isFile()).toBe(true);
    const registry = readFileSync(file, 'utf8');
    const parsed = JSON.parse(registry);
    expect(Object.keys(parsed).sort()).toEqual(['characters', 'patterns', 'physicalNewline', 'version']);
    expect(registry).not.toContain(secret);
    expect(readFileSync(initialized, 'utf8')).not.toContain(secret);
    expect(new PrivacyRedactions(file).redact(`future ${secret}`)).not.toContain(secret);
  });

  it('fails closed in a new process and the current process when the initialized registry is deleted', () => {
    const { file } = fixture();
    const redactions = new PrivacyRedactions(file);
    redactions.register(['R8_PRIVACY_DELETED_REGISTRY_92D']);
    unlinkSync(file);
    expect(() => redactions.redact('future write')).toThrow('隐私脱敏登记文件缺失');
    expect(() => new PrivacyRedactions(file)).toThrow('隐私脱敏登记文件缺失');
  });

  it('rejects malformed and dangling symlink registries after initialization', () => {
    const malformed = fixture();
    const first = new PrivacyRedactions(malformed.file);
    first.register(['R8_PRIVACY_MALFORMED_71C']);
    writeFileSync(malformed.file, '{broken', 'utf8');
    expect(() => new PrivacyRedactions(malformed.file)).toThrow();

    const linked = fixture();
    const linkedRedactions = new PrivacyRedactions(linked.file);
    linkedRedactions.register(['R8_PRIVACY_DANGLING_92D']);
    unlinkSync(linked.file);
    const target = join(linked.dir, 'missing-target');
    try {
      symlinkSync(target, linked.file, 'file');
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkSync(`${target}-dir`, linked.file, 'junction');
    }
    expect(lstatSync(linked.file).isSymbolicLink()).toBe(true);
    expect(() => new PrivacyRedactions(linked.file)).toThrow('隐私脱敏登记文件不安全');
    expect(() => linkedRedactions.size).toThrow('隐私脱敏登记文件不安全');
  });

  it('rejects a dangling initialization tombstone even when the registry is intact', () => {
    const { dir, file, initialized } = fixture();
    const redactions = new PrivacyRedactions(file);
    redactions.register(['R8_PRIVACY_TOMBSTONE_LINK_71C']);
    unlinkSync(initialized);
    try {
      symlinkSync(join(dir, 'missing-tombstone-target'), initialized, 'file');
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkSync(join(dir, 'missing-tombstone-target-dir'), initialized, 'junction');
    }
    expect(() => new PrivacyRedactions(file)).toThrow('隐私脱敏登记文件不安全');
    expect(() => redactions.size).toThrow('隐私脱敏登记文件不安全');
  });

  it.each(['已删除', '[已删除]'])('uses a collision-safe marker and verifies output for %s', (secret) => {
    const { file } = fixture();
    const redactions = new PrivacyRedactions(file);
    redactions.register([secret]);
    const marker = redactions.marker();
    expect(marker).not.toBe('[已删除]');
    expect(marker).not.toContain(secret);
    for (const character of Array.from(secret)) expect(redactions.usesCharacter(character)).toBe(true);
    for (const character of Array.from(marker)) expect(redactions.usesCharacter(character)).toBe(false);
    const output = redactions.redact(`before ${secret} after`);
    expect(output).toContain(marker);
    expect(output).not.toContain(secret);
    expect(redactions.contains(output)).toBe(false);
    expect(() => redactions.redact(secret, '[已删除]')).toThrow('隐私脱敏输出仍包含登记模式');
    expect(readFileSync(file, 'utf8')).not.toContain(secret);
  });

  it('rotates the marker when a previous marker becomes registered and never matches across boundaries', () => {
    const { file } = fixture();
    const redactions = new PrivacyRedactions(file);
    redactions.register(['已删除']);
    const first = redactions.marker();
    redactions.register([first]);
    const second = redactions.marker();
    expect(second).not.toBe(first);
    expect(redactions.redact(`${first}${first}`)).not.toContain(first);
    expect(redactions.contains(redactions.redact(`${first}${first}`))).toBe(false);
    const boundary = `x${second}x`;
    redactions.register([boundary]);
    const output = redactions.redact(`x${second}x`);
    expect(redactions.contains(output)).toBe(false);
    expect(readFileSync(file, 'utf8')).not.toContain(first);
    expect(readFileSync(file, 'utf8')).not.toContain(second);
  });
});
