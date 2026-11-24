/** Tunable recommender parameters. Defaults were tuned with the simulator (npm run sim). */
export const PARAMS = {
  /** Max long-term interest / negative prototypes. */
  maxInterests: 5,
  maxNegatives: 5,
  /** Cosine above which a positive reel updates an existing interest instead of creating one. */
  interestMergeSim: 0.6,
  interestLr: 0.1,
  sessionLr: 0.3,
  /** Session vector resets after this much inactivity. */
  sessionTimeoutMs: 30 * 60 * 1000,
  /** Effective reward below which a reel becomes a negative prototype. */
  negativeThreshold: -0.3,
  decay: 0.995,
  pruneWeight: 0.05,
  /** Interactions at which confidence reaches 1 - 1/e. */
  confidenceScale: 40,
  /** Topic feed signals count half: the user chose the context. */
  topicModeFactor: 0.5,
  /** Extra Beta failures for "less like this topic". */
  lessTopicPenalty: 3,
  /** Reels viewed before a "less like this topic" field may reappear in the main feed. */
  lessTopicCooldown: 20,

  exploreStart: 0.25,
  exploreEnd: 0.1,
  topicExplore: 0.1,
  poolSize: 100,
  mmrPenalty: 0.3,
  exploitTemp: 0.05,
  exploreTemp: 0.1,
  maxSameFieldRun: 3,
  /** cos(profile now, profile when queue was built) below this drops queued reels. */
  driftCos: 0.9,
  dislikeDropSim: 0.6,
  similarReasonSim: 0.55,
};
export type Params = typeof PARAMS;
