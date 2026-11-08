// G7b · 安装目录解析单测（§0.7 P0-2 三级顺序 + fail closed；设计 §7.7「安装目录一致性」）。
//
// 表驱动喂 **固定 reg query 文本**：绝不依赖真机注册表、绝不写注册表。
// 唯一走真实读取器的用例只 `reg query` 一个必然不存在的 appId（只读），
// 用来钉住「默认实现 = 只读、取不到 ⇒ null」。
//
// 三级顺序（§0.7 P0-2 / task0-results D-2 本机实测）：
//   ① InstallLocation（非空且形态合法）
//   ② 为空时从 UninstallString 的带引号 exe 路径取父目录
//   ③ 仍失败 ⇒ null（fail closed：不传 /D、拒绝自管安装）
// 装错目录会产生两份安装 / 快捷方式指向旧版，是 B 关验收②项。

import { describe, expect, it, vi } from 'vitest';

import {
  installDirFromUninstallString, parseRegistryOutput, resolveInstallDirectory,
  resolveInstallDirectoryWith, sanitizeInstallDir,
} from '../../electron/main/update/installer.js';

const APP_ID = 'com.sparkii.desktop';
const HIVE = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop';

/** 按真实 `reg query` 版式拼输出：4 空格 + 值名 + 4 空格 + 类型 + 4 空格 + 数据。 */
function reg(values: Array<[name: string, type: string, data?: string]>): string {
  const lines = ['', HIVE];
  for (const [name, type, data = ''] of values) {
    lines.push(`    ${name}    ${type}    ${data}`);
  }
  return `${lines.join('\r\n')}\r\n\r\nEnd of search: 1 matching entries found.\r\n`;
}

async function resolveWith(text: string | null, appId = APP_ID): Promise<string | null> {
  return resolveInstallDirectoryWith(appId, { platform: 'win32', readRegistry: async () => text });
}

describe('① InstallLocation 优先（存在即用，不再看 UninstallString）', () => {
  it('非空 InstallLocation 直接采用', async () => {
    const text = reg([
      ['DisplayName', 'REG_SZ', 'Sparkii'],
      ['InstallLocation', 'REG_SZ', 'D:\\software\\SparkiiPi'],
      ['UninstallString', 'REG_SZ', '"C:\\Users\\ydej\\AppData\\Local\\Programs\\Sparkii\\Uninstall Sparkii.exe" /currentuser'],
    ]);
    expect(await resolveWith(text)).toBe('D:\\software\\SparkiiPi');
  });

  it('尾随分隔符与尾随空白都被去掉（契约：绝对路径且不含尾随空白）', async () => {
    const dir = await resolveWith(reg([['InstallLocation', 'REG_SZ', 'D:\\software\\SparkiiPi\\   ']]));
    expect(dir).toBe('D:\\software\\SparkiiPi');
    expect(dir).toBe(dir?.trimEnd());
    expect(dir?.endsWith('\\')).toBe(false);
  });

  it('值本身含空格（多级带空格目录）原样保留', async () => {
    expect(await resolveWith(reg([['InstallLocation', 'REG_SZ', 'D:\\My Programs\\Sparkii Pi']])))
      .toBe('D:\\My Programs\\Sparkii Pi');
  });

  it('成对引号包住的值先脱引号', async () => {
    expect(await resolveWith(reg([['InstallLocation', 'REG_SZ', '"D:\\software\\SparkiiPi"']])))
      .toBe('D:\\software\\SparkiiPi');
  });

  it('UNC 路径合法', async () => {
    expect(await resolveWith(reg([['InstallLocation', 'REG_SZ', '\\\\fileserver\\Sparkii']])))
      .toBe('\\\\fileserver\\Sparkii');
  });

  it('正斜杠形态归一成反斜杠', async () => {
    expect(await resolveWith(reg([['InstallLocation', 'REG_SZ', 'D:/software/SparkiiPi']])))
      .toBe('D:\\software\\SparkiiPi');
  });

  it('值名大小写不敏感（注册表语义）', async () => {
    expect(await resolveWith(reg([['INSTALLLOCATION', 'REG_SZ', 'D:\\x\\y']]))).toBe('D:\\x\\y');
  });

  it('盘符根保留（`D:\\` 不会被削成 `D:`）', async () => {
    expect(await resolveWith(reg([['InstallLocation', 'REG_SZ', 'D:\\']]))).toBe('D:\\');
  });
});

describe('② InstallLocation 为空 ⇒ UninstallString 回退取父目录', () => {
  it('本机实测形态：InstallLocation 空 + 带引号 UninstallString', async () => {
    const text = reg([
      ['DisplayName', 'REG_SZ', 'Sparkii 0.1.0'],
      ['DisplayVersion', 'REG_SZ', '0.1.0'],
      ['InstallLocation', 'REG_SZ', ''],
      ['UninstallString', 'REG_SZ', '"D:\\software\\SparkiiPi\\Uninstall Sparkii.exe" /currentuser'],
    ]);
    expect(await resolveWith(text)).toBe('D:\\software\\SparkiiPi');
  });

  it('完全没有 InstallLocation 行时同样回退', async () => {
    const text = reg([['UninstallString', 'REG_SZ', '"D:\\software\\SparkiiPi\\Uninstall Sparkii.exe" /currentuser']]);
    expect(await resolveWith(text)).toBe('D:\\software\\SparkiiPi');
  });

  it('InstallLocation 只有空白字符 ⇒ 视为空并回退', async () => {
    const text = reg([
      ['InstallLocation', 'REG_SZ', '   '],
      ['UninstallString', 'REG_SZ', '"E:\\Apps\\Sparkii\\Uninstall Sparkii.exe" /currentuser'],
    ]);
    expect(await resolveWith(text)).toBe('E:\\Apps\\Sparkii');
  });

  it('InstallLocation 形态非法 ⇒ 回退到 UninstallString', async () => {
    const text = reg([
      ['InstallLocation', 'REG_SZ', 'relative\\path'],
      ['UninstallString', 'REG_SZ', '"D:\\software\\SparkiiPi\\Uninstall Sparkii.exe" /currentuser'],
    ]);
    expect(await resolveWith(text)).toBe('D:\\software\\SparkiiPi');
  });

  it('无引号但带空格：以 .exe 结尾即可用（switch 从最后的 ` /x` 处切开）', async () => {
    const text = reg([['UninstallString', 'REG_SZ', 'C:\\Program Files\\Sparkii\\Uninstall.exe /currentuser']]);
    expect(await resolveWith(text)).toBe('C:\\Program Files\\Sparkii');
  });

  it('无引号带空格且父目录也带空格 ⇒ 仍能取到正确父目录', async () => {
    const text = reg([['InstallLocation', 'REG_SZ', ''], ['UninstallString', 'REG_SZ', 'D:\\software\\Sparkii Pi\\Uninstall Sparkii.exe /currentuser']]);
    expect(await resolveWith(text)).toBe('D:\\software\\Sparkii Pi');
  });

  it('默认安装目录形态（%LOCALAPPDATA%\\Programs\\Sparkii）也能取父目录', async () => {
    const text = reg([
      ['InstallLocation', 'REG_SZ', ''],
      ['UninstallString', 'REG_SZ', '"C:\\Users\\ydej\\AppData\\Local\\Programs\\Sparkii\\Uninstall Sparkii.exe" /currentuser'],
    ]);
    expect(await resolveWith(text)).toBe('C:\\Users\\ydej\\AppData\\Local\\Programs\\Sparkii');
  });
});

describe('③ fail closed：一律 null（不传 /D、拒绝自管安装）', () => {
  const cases: Array<[string, string | null]> = [
    ['注册表键不存在（读取器返回 null）', null],
    ['空输出', ''],
    ['只有噪声行', `${HIVE}\r\nEnd of search: 0 matching entries found.\r\n`],
    ['只有 DisplayName（两个候选值都缺）', reg([['DisplayName', 'REG_SZ', 'Sparkii']])],
    ['InstallLocation 空 + 无 UninstallString', reg([['InstallLocation', 'REG_SZ', '']])],
    ['UninstallString 是相对路径', reg([['InstallLocation', 'REG_SZ', ''], ['UninstallString', 'REG_SZ', '"Uninstall Sparkii.exe" /currentuser']])],
    ['UninstallString 无引号且不以 .exe 结尾（歧义，宁可不认）', reg([['InstallLocation', 'REG_SZ', ''], ['UninstallString', 'REG_SZ', 'D:\\software\\SparkiiPi\\Uninstall Sparkii /currentuser']])],
    ['恶意畸形：InstallLocation 含 .. 段', reg([['InstallLocation', 'REG_SZ', 'D:\\software\\..\\Windows']])],
    ['恶意畸形：InstallLocation 含内嵌引号', reg([['InstallLocation', 'REG_SZ', 'D:\\x" /E:\\y']])],
    ['恶意畸形：InstallLocation 含 NUL', reg([['InstallLocation', 'REG_SZ', 'D:\\x\u0000y']])],
    ['恶意畸形：InstallLocation 是相对路径', reg([['InstallLocation', 'REG_SZ', 'software\\SparkiiPi']])],
    ['恶意畸形：InstallLocation 是 `D:sparkii`（盘符相对）', reg([['InstallLocation', 'REG_SZ', 'D:sparkii']])],
    ['类型不对：InstallLocation 是 REG_DWORD', reg([['InstallLocation', 'REG_DWORD', '1']])],
    ['REG_EXPAND_SZ 带 %VAR%（绝不做环境变量展开）', reg([['InstallLocation', 'REG_EXPAND_SZ', '%LOCALAPPDATA%\\Programs\\Sparkii']])],
    ['只有 InnoSetup 风格噪声键', reg([['QuietUninstallString', 'REG_SZ', '"D:\\x\\unins000.exe" /SILENT']])],
  ];
  for (const [name, text] of cases) {
    it(`${name} ⇒ null`, async () => {
      expect(await resolveWith(text)).toBeNull();
    });
  }

  it('REG_MULTI_SZ 与重复块噪声并存时，第一个可用块赢', async () => {
    const noisy = [
      '',
      HIVE,
      '    InstallLocation    REG_SZ    ',
      '    SomeOther    REG_MULTI_SZ    alpha\\0beta\\0\\0',
      '    UninstallString    REG_SZ    "D:\\real\\dir\\Uninstall Sparkii.exe" /currentuser',
      '    UninstallString    REG_SZ    "E:\\second\\block\\Uninstall Sparkii.exe" /currentuser',
      '',
    ].join('\r\n');
    expect(await resolveWith(noisy)).toBe('D:\\real\\dir');
  });

  it('appId 形态非法 ⇒ 直接拒绝且完全不读注册表（防命令行注入）', async () => {
    for (const bad of ['', 'com sparkii', 'com.sparkii;shutdown', '..', 'com/sparkii', 'HKCU\\Software', 'x'.repeat(300)]) {
      const read = vi.fn(async () => reg([['InstallLocation', 'REG_SZ', 'D:\\x']]));
      const out = await resolveInstallDirectoryWith(bad, {
        platform: 'win32', readRegistry: read, logger: { info() {}, warn() {}, error() {} },
      });
      expect(out).toBeNull();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('非 win32 平台 ⇒ null 且不触碰注册表（NSIS 键只存在于 Windows）', async () => {
    const read = vi.fn(async () => reg([['InstallLocation', 'REG_SZ', 'D:\\software\\SparkiiPi']]));
    expect(await resolveInstallDirectoryWith(APP_ID, { platform: 'linux', readRegistry: read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('读取器抛错 ⇒ null（fail closed，不重试不猜测）', async () => {
    const out = await resolveInstallDirectoryWith(APP_ID, {
      platform: 'win32',
      readRegistry: async () => { throw new Error('reg.exe ENOENT'); },
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(out).toBeNull();
  });

  it('读取器返回非字符串 ⇒ null', async () => {
    const out = await resolveInstallDirectoryWith(APP_ID, {
      platform: 'win32',
      readRegistry: async () => undefined as unknown as string | null,
    });
    expect(out).toBeNull();
  });

  it('查询用的键就是 HKCU\\...\\Uninstall\\{appId}（只读查询，不写不删）', async () => {
    const read = vi.fn(async (key: string) => {
      expect(key).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop');
      return reg([['InstallLocation', 'REG_SZ', 'D:\\software\\SparkiiPi']]);
    });
    await resolveInstallDirectoryWith(APP_ID, { platform: 'win32', readRegistry: read });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('parseRegistryOutput 逐行口径', () => {
  it('忽略 HIVE 头与页脚，只收值行；同名值取第一次出现', () => {
    const values = parseRegistryOutput([
      '',
      HIVE,
      '    InstallLocation    REG_SZ    D:\\first',
      '    InstallLocation    REG_SZ    D:\\second',
      '',
      'End of search: 1 matching entries found.',
    ].join('\r\n'));
    expect(Object.keys(values)).toEqual(['InstallLocation']);
    expect(values.InstallLocation).toEqual({ type: 'REG_SZ', value: 'D:\\first' });
  });

  it('值名含空格也能切开（名字与类型之间以空白分列）', () => {
    const values = parseRegistryOutput('    Display Icon    REG_SZ    D:\\x\\icon.ico');
    expect(values['Display Icon']?.value).toBe('D:\\x\\icon.ico');
  });

  it('非值行（顶格的 HIVE / 噪声）一律不解析', () => {
    expect(parseRegistryOutput(`${HIVE}\r\n乱码行\r\n`)).toEqual({});
  });
});

describe('sanitizeInstallDir / installDirFromUninstallString 单元口径', () => {
  it('sanitizeInstallDir 正例', () => {
    expect(sanitizeInstallDir('D:\\a\\b')).toBe('D:\\a\\b');
    expect(sanitizeInstallDir('  D:\\a\\b\\  ')).toBe('D:\\a\\b');
    expect(sanitizeInstallDir('"\\\\srv\\share\\app"')).toBe('\\\\srv\\share\\app');
    expect(sanitizeInstallDir('C:\\')).toBe('C:\\');
    expect(sanitizeInstallDir('D:/a/b')).toBe('D:\\a\\b');
  });

  it('sanitizeInstallDir 反例一律 null', () => {
    for (const bad of [
      '', '   ', 'a\\b', '..\\x', 'D:\\a\\..\\b', 'D:\\a"b',
      'D:\u0001b', 'D:', 'C:/a\nb', '\\\\?\\D:\\x',
    ]) {
      expect(sanitizeInstallDir(bad)).toBeNull();
    }
  });

  it('installDirFromUninstallString 只接受绝对 exe 路径并取父目录', () => {
    expect(installDirFromUninstallString('"D:\\x\\Uninstall Sparkii.exe" /S')).toBe('D:\\x');
    expect(installDirFromUninstallString('"D:\\x\\y\\Uninstall.exe"')).toBe('D:\\x\\y');
    expect(installDirFromUninstallString('D:\\x\\Uninstall.exe')).toBe('D:\\x');
    expect(installDirFromUninstallString('"relative\\Uninstall.exe"')).toBeNull();
    expect(installDirFromUninstallString('D:\\x\\Uninstall.bat /S')).toBeNull();
    expect(installDirFromUninstallString('')).toBeNull();
  });

  it('带正斜杠的 UninstallString 也归一为反斜杠目录', () => {
    expect(installDirFromUninstallString('"D:/x/y/Uninstall.exe"')).toBe('D:\\x\\y');
  });
});

describe('契约导出的生产入口 resolveInstallDirectory', () => {
  it('签名保持不变：只接受 appId，返回 Promise<string|null>', async () => {
    expect(resolveInstallDirectory.length).toBe(1);
    const value = await resolveInstallDirectory('com.sparkii.not-installed-for-unit-test');
    expect(value === null || typeof value === 'string').toBe(true);
  });

  it('默认实现是只读 reg query：对必然不存在的 appId 返回 null（不写注册表）', async () => {
    expect(await resolveInstallDirectory('com.sparkii.not-installed-for-unit-test')).toBeNull();
  });
});
