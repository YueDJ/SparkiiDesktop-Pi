import type { AgentSurfaceProps } from '../../../src/surface/contract.js';
import { PackPage } from './pack.js';
import './styles.css';

export default function ProcurementSurface(props: AgentSurfaceProps) {
  return <PackPage {...props} />;
}
