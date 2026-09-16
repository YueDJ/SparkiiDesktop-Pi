export function stripLastExt(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

export function procurementSessionTitle(planNo: string | null, fileName: string | null): string {
  const plan = planNo?.trim();
  if (plan) return plan;
  const base = fileName ? stripLastExt(fileName).trim() : '';
  return base || '财务采购审核';
}
