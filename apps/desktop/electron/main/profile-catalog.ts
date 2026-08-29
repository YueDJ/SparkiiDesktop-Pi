export interface ProfileWithKnowledge {
  id?: string;
  profile: { agent: { knowledge: unknown[] } };
}

export function firstProfileWithKnowledge<T extends ProfileWithKnowledge>(profiles: Iterable<T>): T | undefined {
  for (const profile of profiles) {
    if (profile.profile.agent.knowledge.length > 0) return profile;
  }
  return undefined;
}
