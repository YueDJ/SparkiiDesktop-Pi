/**
 * Generic Markdown + images → DOCX compiler (P1 main-process capability).
 * No business semantics. Parses a deterministic subset of Markdown (headings,
 * paragraphs, bullet lists, images) into a DOCX via the existing `docx` dep.
 */
export interface CompileImage {
  /** Reference as written in Markdown, e.g. figures/arch-3-2.png */
  ref: string;
  /** PNG bytes */
  data: Buffer;
}

export interface CompileSection {
  title: string;
  markdown: string;
}

export interface CompileResult {
  ok: boolean;
  docx?: Buffer;
  error?: string;
}

/** Resolve the width for an embedded image from its pixel dimensions if available. */
function imageSize(data: Buffer): { w: number; h: number } | null {
  // PNG IHDR: signature 8 + length 4 + 'IHDR' 4 + width 4 + height 4
  if (data.length > 24 && data.subarray(12, 16).toString('ascii') === 'IHDR') {
    const w = data.readUInt32BE(16);
    const h = data.readUInt32BE(20);
    if (w > 0 && h > 0) return { w, h };
  }
  return null;
}

/**
 * Compile sections into a DOCX buffer. `docx` is dynamically imported so this
 * module stays importable in tests that don't need the real library.
 */
export async function compileDocx(
  sections: CompileSection[],
  images: CompileImage[],
  title: string,
): Promise<CompileResult> {
  try {
    const {
      Document, Packer, Paragraph, HeadingLevel, ImageRun, TextRun, AlignmentType,
    } = await import('docx');
    const byRef = new Map(images.map((i) => [i.ref.replace(/\\/g, '/'), i.data]));

    const children: import('docx').FileChild[] = [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    ];

    for (const section of sections) {
      children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }));
      const lines = String(section.markdown ?? '').replace(/\r/g, '').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // Image: ![alt](ref)
        const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
        if (img) {
          const ref = img[2].trim();
          const data = byRef.get(ref) ?? byRef.get(ref.replace(/^\.\//, ''));
          if (data) {
            const dims = imageSize(data) ?? { w: 600, h: 300 };
            const scale = Math.min(1, 620 / dims.w);
            children.push(new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({
                type: 'png',
                data: new Uint8Array(data),
                transformation: { width: Math.round(dims.w * scale), height: Math.round(dims.h * scale) },
                altText: { name: img[1] || ref, title: img[1] || '图', description: img[1] || '' },
              })],
            }));
            continue;
          }
        }
        // Headings: ## / ###
        const h = /^(#{2,4})\s+(.*)$/.exec(line);
        if (h) {
          const level = h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
          children.push(new Paragraph({ text: h[2], heading: level }));
          continue;
        }
        // Bullet: - / *
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          children.push(new Paragraph({ children: [new TextRun({ text: `• ${bullet[1]}` })] }));
          continue;
        }
        // Anchor comments → skip.
        if (line.startsWith('<!--')) continue;
        children.push(new Paragraph({ children: [new TextRun({ text: line })] }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const docx = await Packer.toBuffer(doc);
    return { ok: true, docx: Buffer.from(docx) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
