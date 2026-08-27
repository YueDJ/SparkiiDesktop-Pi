export function RiskBadge({ risk }: { risk: string | undefined }) {
  const level = risk === 'high-risk' || risk === '高风险' ? 'high' : risk === 'read' || risk === '低风险' || risk === '低' ? 'low' : 'mid';
  const label = level === 'high' ? '高风险' : level === 'low' ? '低风险' : '中风险';
  return <span className={`ui-risk-badge ui-risk-badge--${level}`}>{label}</span>;
}
