import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../electron/main/logger.js';

function encodeEveryJsonEscape(value: string): string {
  const body = Array.from(value, (char) => {
    switch (char) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '/': return '\\/';
      case '\b': return '\\b';
      case '\f': return '\\f';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return Array.from({ length: char.length }, (_, index) =>
        `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join('');
    }
  }).join('');
  return `"${body}"`;
}

describe('Logger', () => {
  it.each(['redactSession', 'redactMemoryPromptLogs'] as const)(
    'R8 final review %s cannot be undone by an unawaited append',
    async (operation) => {
      const dir = mkdtempSync(join(tmpdir(), 'log-append-race-'));
      const path = join(dir, 'sparkii.log.jsonl');
      const secret = 'R8_LOG_APPEND_RACE_71C';
      const logger = new Logger(dir, false);
      logger.redactSession('removed', [secret]);
      writeFileSync(path, `${JSON.stringify({ level: 'info', msg: 'memory prompt block appended to saddle', ctx: { sessionId: 'removed' } })}\n`);
      const appending = logger.log({ level: 'info', msg: `future ${secret}`, ctx: { sessionId: 'removed', detail: secret } });
      if (operation === 'redactSession') logger.redactSession('removed', [secret]);
      else logger.redactMemoryPromptLogs();
      await appending;
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toContain(secret);
      if (operation === 'redactSession') {
        expect(raw).not.toContain('removed');
        expect(raw.split('\n').filter(Boolean)).toHaveLength(0);
      } else {
        expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
      }
    },
  );

  it('R8 final review keeps future log writes redacted after restart without plaintext in the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-restart-redaction-'));
    const secret = 'R8_LOG_RESTART_SECRET_92D';
    new Logger(dir, false).redactSession('removed', [secret]);
    const registry = readFileSync(join(dir, 'privacy-redactions.json'), 'utf8');
    expect(registry).not.toContain(secret);
    const logger = new Logger(dir, false);
    await logger.log({ level: 'info', msg: `future ${secret}`, ctx: { detail: secret } });
    expect(readFileSync(join(dir, 'sparkii.log.jsonl'), 'utf8')).not.toContain(secret);
    expect(await logger.export()).not.toContain(secret);
  });

  it.each(['已删除', '[已删除]'])('R7 never preserves the registered marker secret %s', async (secret) => {
    const dir = mkdtempSync(join(tmpdir(), 'log-marker-'));
    const path = join(dir, 'sparkii.log.jsonl');
    const logger = new Logger(dir, false);
    writeFileSync(path, [
      JSON.stringify({ level: 'info', msg: `before ${secret}`, ctx: { detail: secret } }),
      `not-json ${secret}`,
    ].join('\n'), 'utf8');
    logger.redactSession('removed', [secret]);
    await logger.log({ level: 'info', msg: `future ${secret}`, ctx: { detail: secret } });

    const rewritten = readFileSync(path, 'utf8');
    const exported = await logger.export();
    for (const output of [rewritten, exported]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(output.endsWith('\n')).toBe(true);
      const records = output.split('\n').filter(Boolean);
      expect(records.length).toBeGreaterThanOrEqual(3);
      for (const record of records) {
        if (record.startsWith('{')) expect(() => JSON.parse(record)).not.toThrow();
      }
    }
    const first = JSON.parse(rewritten.split('\n')[0]);
    expect(Object.keys(first).sort()).toEqual(['ctx', 'level', 'msg']);
    expect(Object.keys(first.ctx)).toEqual(['detail']);
  });

  it.each(['x"[已删除]', 'x\\[已删除]', 'x\n[已删除]'])(
    'R7 redaction cannot recreate a registered secret across the marker boundary: %j',
    async (secret) => {
      const dir = mkdtempSync(join(tmpdir(), 'log-boundary-'));
      const path = join(dir, 'sparkii.log.jsonl');
      const wrapped = secret[0] + secret;
      writeFileSync(path, [
        JSON.stringify({ level: 'info', msg: wrapped, ctx: { detail: wrapped } }),
        `not-json ${wrapped}`,
      ].join('\n'), 'utf8');
      const logger = new Logger(dir, false);
      logger.redactSession('removed', [secret]);
      await logger.log({ level: 'info', msg: wrapped, ctx: { detail: wrapped } });

      for (const output of [readFileSync(path, 'utf8'), await logger.export()]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(encodeEveryJsonEscape(secret).slice(1, -1));
        expect(output.endsWith('\n')).toBe(true);
        for (const line of output.split('\n').filter(Boolean)) {
          if (line.startsWith('{')) expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    },
  );

  it('appends structured jsonl and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'info', msg: 'start', ctx: { profile: 'contract-review' } });
    const exported = await l.export();
    expect(JSON.parse(exported.trim().split('\n')[0]).msg).toBe('start');
  });

  it('drops entries below the configured level', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    l.level = 'warn';
    await l.log({ level: 'info', msg: 'should-drop' });
    await l.log({ level: 'warn', msg: 'kept' });
    const exported = await l.export();
    expect(exported).not.toContain('should-drop');
    expect(exported).toContain('kept');
  });

  it('echoes to console with level mapping', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'warn', msg: 'careful' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not echo to console when echo is disabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir, false);
    await l.log({ level: 'info', msg: 'silent' });
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('constructor and logging stay non-blocking when the log file path is a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    mkdirSync(join(dir, 'sparkii.log.jsonl'));
    expect(() => new Logger(dir, false)).not.toThrow();
    const logger = new Logger(dir, false);
    await expect(logger.log({ level: 'info', msg: 'write failure is non-blocking' })).resolves.toBeUndefined();
    await expect(logger.export()).resolves.toBe('');
  });

  it('circular console context cannot reject logging or lose the message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const logger = new Logger(dir);
    const ctx: Record<string, unknown> = {};
    ctx.self = ctx;
    try {
      await expect(logger.log({ level: 'info', msg: '循环上下文仍应记录', ctx })).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
      expect(readFileSync(join(dir, 'sparkii.log.jsonl'), 'utf8')).toContain('循环上下文仍应记录');
      expect(await logger.export()).toContain('循环上下文仍应记录');
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each(['redactSession', 'redactMemoryPromptLogs'] as const)(
    '%s terminates a rewritten nonempty JSONL file before the next append',
    async (operation) => {
      const dir = mkdtempSync(join(tmpdir(), 'log-'));
      const path = join(dir, 'sparkii.log.jsonl');
      writeFileSync(path, JSON.stringify({ level: 'info', msg: 'kept', ctx: { sessionId: 'other' } }), 'utf8');
      const logger = new Logger(dir, false);

      if (operation === 'redactSession') logger.redactSession('removed', []);
      else logger.redactMemoryPromptLogs();

      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
      await logger.log({ level: 'info', msg: 'appended' });
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line).msg)).toEqual(['kept', 'appended']);
    },
  );

  it('redacts string values without changing JSON schema field names during session redaction or export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const path = join(dir, 'sparkii.log.jsonl');
    writeFileSync(path, JSON.stringify({
      ts: 1,
      level: 'info',
      msg: 'msg',
      ctx: {
        sessionId: 'kept-session',
        msg: 'level',
        level: 'ctx',
        ctx: 'msg',
        nested: { level: 'prefix msg suffix', value: 'normal' },
        items: ['ctx', 'level'],
      },
    }), 'utf8');
    const logger = new Logger(dir, false);

    logger.redactSession('removed-session', ['msg', 'level', 'ctx']);

    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const entry = JSON.parse(raw);
    expect(Object.keys(entry).sort()).toEqual(['ctx', 'level', 'msg', 'ts']);
    expect(entry).toMatchObject({
      level: 'info',
      msg: '[已删除]',
      ctx: {
        sessionId: 'kept-session',
        msg: '[已删除]',
        level: '[已删除]',
        ctx: '[已删除]',
        nested: { level: 'prefix [已删除] suffix', value: 'normal' },
        items: ['[已删除]', '[已删除]'],
      },
    });
    expect(Object.keys(entry.ctx).sort()).toEqual(['ctx', 'items', 'level', 'msg', 'nested', 'sessionId']);
    expect(JSON.parse(await logger.export())).toEqual(entry);
  });

  it('uses structured redaction for future writes and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const logger = new Logger(dir, false);
    logger.redactSession('removed-session', ['msg', 'level', 'ctx']);

    await logger.log({
      level: 'info',
      msg: 'msg',
      ctx: { msg: 'level', level: 'ctx', ctx: 'msg', nested: ['ctx', { msg: 'normal' }] },
    });

    const expected = {
      level: 'info',
      msg: '[已删除]',
      ctx: {
        msg: '[已删除]',
        level: '[已删除]',
        ctx: '[已删除]',
        nested: ['[已删除]', { msg: 'normal' }],
      },
    };
    const written = JSON.parse(readFileSync(join(dir, 'sparkii.log.jsonl'), 'utf8'));
    expect(written).toMatchObject(expected);
    expect(Object.keys(written).sort()).toEqual(['ctx', 'level', 'msg', 'ts']);
    expect(Object.keys(written.ctx).sort()).toEqual(['ctx', 'level', 'msg', 'nested']);
    expect(JSON.parse(await logger.export())).toEqual(written);
  });

  it.each(['redactSession', 'redactMemoryPromptLogs', 'export'] as const)(
    'R8 round3 %s replaces dynamic registered keys with a schema-safe placeholder',
    async (operation) => {
      const dir = mkdtempSync(join(tmpdir(), 'log-r8-round3-keys-'));
      const path = join(dir, 'sparkii.log.jsonl');
      const secret = 'R8_LOG_DYNAMIC_KEY_SECRET_71C';
      const unsafe = {
        ts: 1, level: 'info', msg: 'unsafe dynamic key',
        ctx: { sessionId: 'kept-session', profileId: 'kept-profile', [secret]: 1 },
      };
      const normal = {
        ts: 2, level: 'info', msg: `normal ${secret}`,
        ctx: { sessionId: `session-${secret}`, profileId: 'kept-profile', note: 'unchanged' },
      };
      new Logger(dir, false).redactSession('removed', [secret]);
      writeFileSync(path, `${JSON.stringify(unsafe)}\n${JSON.stringify(normal)}\n`, 'utf8');
      const logger = new Logger(dir, false);

      if (operation === 'redactSession') logger.redactSession('removed', [secret]);
      else if (operation === 'redactMemoryPromptLogs') logger.redactMemoryPromptLogs();
      const output = operation === 'export' ? await logger.export() : readFileSync(path, 'utf8');

      expect(output).not.toContain(secret);
      const records = output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(Object.keys(records[0]).sort()).toEqual(['ctx', 'level', 'msg']);
      expect(records[0]).toEqual({ level: 'error', msg: '[已删除]', ctx: {} });
      expect(Object.keys(records[1]).sort()).toEqual(['ctx', 'level', 'msg', 'ts']);
      expect(records[1]).toEqual({
        ...normal,
        msg: 'normal [已删除]',
        ctx: { ...normal.ctx, sessionId: 'session-[已删除]' },
      });
      expect(Object.keys(records[1].ctx).sort()).toEqual(['note', 'profileId', 'sessionId']);
    },
  );

  it('R8 round3 rejects dynamic keys in future appends and after restart while preserving normal schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-r8-round3-future-keys-'));
    const path = join(dir, 'sparkii.log.jsonl');
    const secret = 'R8_LOG_FUTURE_DYNAMIC_KEY_SECRET_92D';
    new Logger(dir, false).redactSession('removed', [secret]);
    const logger = new Logger(dir, false);

    await logger.log({
      level: 'info', msg: 'future dynamic key',
      ctx: { sessionId: 'kept-session', profileId: 'kept-profile', [secret]: 1 },
    });
    const restarted = new Logger(dir, false);
    await restarted.log({
      level: 'warn', msg: 'restart nested dynamic key',
      ctx: { profileId: 'kept-profile', nested: { [`prefix-${secret}`]: 'value' } },
    });
    await restarted.log({
      level: 'info', msg: `restart ${secret}`,
      ctx: { sessionId: `session-${secret}`, profileId: 'kept-profile' },
    });

    const raw = readFileSync(path, 'utf8');
    const exported = await restarted.export();
    expect(raw).not.toContain(secret);
    expect(exported).not.toContain(secret);
    const records = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    for (const record of records.slice(0, 2)) {
      expect(Object.keys(record).sort()).toEqual(['ctx', 'level', 'msg']);
      expect(record).toEqual({ level: 'error', msg: '[已删除]', ctx: {} });
    }
    expect(Object.keys(records[2]).sort()).toEqual(['ctx', 'level', 'msg', 'ts']);
    expect(records[2]).toMatchObject({
      level: 'info', msg: 'restart [已删除]',
      ctx: { sessionId: 'session-[已删除]', profileId: 'kept-profile' },
    });
    expect(Object.keys(records[2].ctx).sort()).toEqual(['profileId', 'sessionId']);
    expect(exported.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual(records);
  });

  it('R8 round3 uses a placeholder that cannot recreate a registered level secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-r8-round3-placeholder-'));
    const path = join(dir, 'sparkii.log.jsonl');
    const secret = 'error';
    const logger = new Logger(dir, false);
    logger.redactSession('removed', [secret]);

    await logger.log({ level: 'info', msg: 'dynamic key', ctx: { [`prefix-${secret}`]: 1 } });

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(secret);
    const record = JSON.parse(raw);
    expect(Object.keys(record).sort()).toEqual(['ctx', 'level', 'msg']);
    expect(record.level).not.toBe(secret);
    expect(record.msg).toBe('[已删除]');
    expect(record.ctx).toEqual({});
    expect(await logger.export()).not.toContain(secret);
  });

  it('memory-prompt redaction keeps normal logs as valid JSONL with structured value redaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const path = join(dir, 'sparkii.log.jsonl');
    const logger = new Logger(dir, false);
    logger.redactSession('removed-session', ['msg', 'level', 'ctx']);
    writeFileSync(path, [
      JSON.stringify({ level: 'info', msg: 'memory prompt block appended to saddle', ctx: { sessionId: 'kept' } }),
      JSON.stringify({ level: 'info', msg: 'msg', ctx: { sessionId: 'kept', level: 'ctx', ctx: 'msg' } }),
    ].join('\n'), 'utf8');

    logger.redactMemoryPromptLogs();

    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      msg: '[已删除]',
      ctx: { sessionId: 'kept', level: '[已删除]', ctx: '[已删除]' },
    });
  });

  it('retains malformed normal log lines while removing their registered secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const path = join(dir, 'sparkii.log.jsonl');
    writeFileSync(path, `${JSON.stringify({ level: 'info', msg: 'normal', ctx: { sessionId: 'kept' } })}\nnot-json msg`, 'utf8');
    const logger = new Logger(dir, false);

    logger.redactSession('removed-session', ['msg']);

    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('not-json [已删除]');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(raw.split('\n')[0]).msg).toBe('normal');
  });

  it.each(['redactSession', 'redactMemoryPromptLogs', 'export'] as const)(
    '%s scrubs every JSON escape encoding in malformed history without changing valid record schemas',
    async (operation) => {
      const dir = mkdtempSync(join(tmpdir(), 'log-'));
      const path = join(dir, 'sparkii.log.jsonl');
      const logger = new Logger(dir, false);
      const secret = 'R7/"\\\b\f\n\r\t雪😀';
      const encodedSecret = encodeEveryJsonEscape(secret);
      const uppercaseUnicodeSecret = encodedSecret.replace(/\\u[0-9a-f]{4}/g, (escape) => escape.toUpperCase());
      const canonicalSecret = JSON.stringify(secret);
      const forbiddenEncodings = [
        secret,
        canonicalSecret,
        canonicalSecret.slice(1, -1),
        encodedSecret,
        encodedSecret.slice(1, -1),
        uppercaseUnicodeSecret,
        uppercaseUnicodeSecret.slice(1, -1),
        '\\u0052',
        '\\u002f',
        '\\/',
      ];
      const before = {
        ts: 1,
        level: 'info',
        msg: 'before',
        ctx: { sessionId: 'kept', msg: 'msg', level: 'level', ctx: 'ctx', nested: { detail: secret } },
      };
      const after = { ts: 2, level: 'warn', msg: 'after', ctx: { sessionId: 'kept', note: 'untouched' } };
      writeFileSync(path, `${JSON.stringify(after)}\n`, 'utf8');
      logger.redactSession('removed-session', [secret]);
      writeFileSync(path, [
        JSON.stringify(before),
        `{"level":"info","msg":${encodedSecret},"ctx":{"sessionId":"kept","msg":"msg","level":"level","ctx":"ctx"}} trailing`,
        `{"level":"info","msg":"${encodedSecret.slice(1, -1)}\\q","ctx":{"sessionId":"kept"}}`,
        `{"level":"info","msg":"${encodedSecret.slice(1, -1)}\\u12`,
        JSON.stringify(after),
      ].join('\n') + '\n', 'utf8');

      if (operation === 'redactSession') logger.redactSession('removed-session', [secret]);
      else if (operation === 'redactMemoryPromptLogs') logger.redactMemoryPromptLogs();
      const output = operation === 'export' ? await logger.export() : readFileSync(path, 'utf8');

      for (const encoding of forbiddenEncodings) expect(output).not.toContain(encoding);
      expect(output.endsWith('\n')).toBe(true);
      const lines = output.split('\n').filter(Boolean);
      expect(lines).toHaveLength(5);
      expect(JSON.parse(lines[0])).toEqual({
        ...before,
        ctx: { ...before.ctx, nested: { detail: '[已删除]' } },
      });
      expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['ctx', 'level', 'msg', 'ts']);
      expect(Object.keys(JSON.parse(lines[0]).ctx).sort()).toEqual(['ctx', 'level', 'msg', 'nested', 'sessionId']);
      expect(lines[1]).toContain('"level":"info"');
      expect(lines[1]).toContain('"msg":"[已删除]"');
      expect(lines[1]).toContain('"ctx":{"sessionId":"kept","msg":"msg","level":"level","ctx":"ctx"}');
      expect(lines[1].endsWith(' trailing')).toBe(true);
      for (const index of [2, 3]) {
        const placeholder = JSON.parse(lines[index]);
        expect(Object.keys(placeholder).sort()).toEqual(['ctx', 'level', 'msg']);
        expect(placeholder).toMatchObject({ level: 'error', msg: '[已删除]', ctx: {} });
      }
      expect(lines[4]).toBe(JSON.stringify(after));
    },
  );

  it.each([
    ['\n', '\n'], ['\n', '\r\n'], ['\n', '\r'],
    ['\r\n', '\n'], ['\r\n', '\r\n'], ['\r\n', '\r'],
    ['\r', '\n'], ['\r', '\r\n'], ['\r', '\r'],
  ])('R8-P1-2 preserves JSONL record boundaries when the registered secret is %j and records use %j', async (secret, separator) => {
    const dir = mkdtempSync(join(tmpdir(), 'log-r8-newline-'));
    const path = join(dir, 'sparkii.log.jsonl');
    const logger = new Logger(dir, false);
    const first = { ts: 1, level: 'info', msg: 'keep-one', ctx: { sessionId: 'kept', detail: `left${secret}right` } };
    const second = { ts: 2, level: 'warn', msg: 'keep-two', ctx: { sessionId: 'kept', note: 'unchanged' } };
    const input = [
      JSON.stringify(first),
      `malformed history`,
      JSON.stringify({ level: 'info', msg: 'memory prompt block appended to saddle', ctx: { sessionId: 'kept' } }),
      JSON.stringify({ level: 'info', msg: 'remove-me', ctx: { sessionId: 'removed' } }),
      JSON.stringify(second),
    ].join(separator) + separator;
    writeFileSync(path, input, 'utf8');
    logger.redactSession('removed', [secret]);

    for (const operation of ['redactSession', 'redactMemoryPromptLogs', 'export'] as const) {
      writeFileSync(path, input, 'utf8');
      if (operation === 'redactSession') logger.redactSession('removed', [secret]);
      else if (operation === 'redactMemoryPromptLogs') logger.redactMemoryPromptLogs();
      const output = operation === 'export' ? await logger.export() : readFileSync(path, 'utf8');
      const records = output.split(/\r\n|\r|\n/).filter(Boolean).map((line) => JSON.parse(line));
      const expectedCount = operation === 'export' ? 5 : 4;
      expect(records, operation).toHaveLength(expectedCount);
      expect(records[0]).toMatchObject({ ts: 1, level: 'info', msg: 'keep-one', ctx: { sessionId: 'kept' } });
      expect(records[0].ctx.detail).not.toContain(secret);
      expect(records[expectedCount - 1]).toEqual(second);
      expect(JSON.stringify(records)).not.toContain(secret);
      if (operation === 'redactSession') expect(records.map((record) => record.msg)).not.toContain('remove-me');
    }
    expect(input.split(/\r\n|\r|\n/).filter(Boolean)).toHaveLength(5);
  });

  it('serializes context once so a stateful toJSON cannot lose the basic message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const logger = new Logger(dir);
    let serializationCalls = 0;
    const ctx = {
      toJSON() {
        serializationCalls += 1;
        if (serializationCalls > 1) throw new Error('second serialization');
        return { profile: 'once' };
      },
    };
    try {
      await expect(logger.log({ level: 'info', msg: '单次序列化仍应记录', ctx })).resolves.toBeUndefined();
      expect(serializationCalls).toBe(1);
      expect(logSpy).toHaveBeenCalledWith('单次序列化仍应记录', '{"profile":"once"}');
      expect(readFileSync(join(dir, 'sparkii.log.jsonl'), 'utf8')).toContain('单次序列化仍应记录');
      expect(await logger.export()).toContain('单次序列化仍应记录');
    } finally {
      logSpy.mockRestore();
    }
  });
});
