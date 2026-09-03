export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlNode | string>;
}

const VOID = new Set(['br', 'hr', 'img']);

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[4] !== undefined) {
      const text = decodeEntities(m[4]);
      if (text) stack[stack.length - 1].children.push(text);
      continue;
    }
    const closing = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: HtmlNode = { tag, attrs: parseAttrs(m[3] ?? ''), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !/\/>$/.test(m[0])) stack.push(node);
  }
  return root;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:A-Za-z_][:A-Za-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function styleColor(style: string | undefined): string | undefined {
  if (!style) return undefined;
  const color = /(?:^|;)\s*color:\s*([^;]+)/i.exec(style)?.[1]?.trim();
  if (!color) return undefined;
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex === '000000' || hex === 'FFFFFF' ? undefined : hex;
  }
  if (/^#?[0-9a-f]{6}$/i.test(color)) return color.replace('#', '').toUpperCase();
  return undefined;
}

export function styleFontWeight(style: string | undefined): boolean {
  if (!style) return false;
  const weight = /(?:^|;)\s*font-weight:\s*([^;]+)/i.exec(style)?.[1]?.trim();
  if (!weight) return false;
  if (weight === 'bold' || weight === 'bolder') return true;
  const n = Number(weight);
  return Number.isFinite(n) && n >= 600;
}
