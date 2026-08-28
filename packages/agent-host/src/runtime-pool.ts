export type RuntimeSessionStatus =
  | "starting"
  | "streaming"
  | "waiting-approval"
  | "occupied-idle";

export interface RuntimeAcquireMeta {
  profileId: string;
  profileName?: string;
  label?: string;
}

export interface RuntimeSlotView {
  slotId: string;
  sessionId: string;
  profileId: string;
  profileName: string;
  label: string;
  status: RuntimeSessionStatus;
  startedAt: number;
}

export interface RuntimeQueueItemView {
  queueId: string;
  profileId: string;
  profileName: string;
  label: string;
  position: number;
}

export interface RuntimePoolSnapshot {
  maxAgents: number;
  active: number;
  queued: number;
  slots: RuntimeSlotView[];
  queue: RuntimeQueueItemView[];
}
