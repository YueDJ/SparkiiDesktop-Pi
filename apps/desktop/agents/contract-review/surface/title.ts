export function stripLastExt(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

export function contractSessionTitle(fileName: string): string {
  const base = stripLastExt(fileName).trim().slice(0, 20);
  return base || '合同审核';
}
