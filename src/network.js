export const NETWORK_RETRY_LIMIT = 4;
export const NETWORK_RETRY_BASE_MS = 1000;
export const NETWORK_RETRY_MAX_MS = 8000;

export function retryDelay(attempt, baseMs = NETWORK_RETRY_BASE_MS, maxMs = NETWORK_RETRY_MAX_MS) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
}

export function createRecoveryRegistry(limit = NETWORK_RETRY_LIMIT) {
  const attempts = new Map();
  const inflight = new Set();
  return {
    begin(peerId) {
      if (inflight.has(peerId)) return false;
      inflight.add(peerId);
      return true;
    },
    fail(peerId) {
      inflight.delete(peerId);
      const attempt = (attempts.get(peerId) || 0) + 1;
      attempts.set(peerId, attempt);
      return attempt <= limit ? { attempt, delayMs: retryDelay(attempt) } : { attempt, delayMs: null };
    },
    complete(peerId) {
      inflight.delete(peerId);
      attempts.delete(peerId);
    },
    clear(peerId) {
      inflight.delete(peerId);
      attempts.delete(peerId);
    },
    isInflight(peerId) { return inflight.has(peerId); },
    attempts(peerId) { return attempts.get(peerId) || 0; },
  };
}

function reportsFrom(stats) {
  if (!stats) return [];
  if (typeof stats.values === 'function') return [...stats.values()];
  if (typeof stats.forEach === 'function') {
    const reports = [];
    stats.forEach((report) => reports.push(report));
    return reports;
  }
  return Array.isArray(stats) ? stats : [];
}

export function summarizePeerStats(stats) {
  const reports = reportsFrom(stats);
  const byId = new Map(reports.map((report) => [report.id, report]));
  const transport = reports.find((report) => report.type === 'transport' && report.selectedCandidatePairId);
  const candidatePair = (transport && byId.get(transport.selectedCandidatePairId))
    || reports.find((report) => report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated)
    || reports.find((report) => report.type === 'candidate-pair' && report.selected === true);
  const localCandidate = candidatePair && byId.get(candidatePair.localCandidateId);
  const remoteCandidate = candidatePair && byId.get(candidatePair.remoteCandidateId);
  const localType = localCandidate?.candidateType;
  const remoteType = remoteCandidate?.candidateType;
  const hasPair = Boolean(candidatePair && localType && remoteType);
  const path = !hasPair ? 'unknown' : (localType === 'relay' || remoteType === 'relay' ? 'relayed' : 'direct');

  const inbound = reports.filter((report) => report.type === 'inbound-rtp' && report.isRemote !== true);
  const received = inbound.reduce((sum, report) => sum + (Number.isFinite(report.packetsReceived) ? report.packetsReceived : 0), 0);
  const lost = inbound.reduce((sum, report) => sum + (Number.isFinite(report.packetsLost) ? Math.max(0, report.packetsLost) : 0), 0);
  const jitterReports = inbound.filter((report) => Number.isFinite(report.jitter));
  const remoteInboundRtt = reports.find((report) => report.type === 'remote-inbound-rtp' && Number.isFinite(report.roundTripTime));
  const pairRtt = Number.isFinite(candidatePair?.currentRoundTripTime) ? candidatePair.currentRoundTripTime : null;
  const rttSeconds = pairRtt ?? (remoteInboundRtt ? remoteInboundRtt.roundTripTime : null);

  return {
    rttMs: rttSeconds === null ? null : Math.round(rttSeconds * 1000),
    rttSource: pairRtt !== null ? 'selected-pair' : (rttSeconds !== null ? 'remote-report' : 'unavailable'),
    packetLossPercent: received + lost > 0 ? Math.round((lost / (received + lost)) * 1000) / 10 : null,
    jitterMs: jitterReports.length ? Math.round(jitterReports.reduce((sum, report) => sum + report.jitter, 0) / jitterReports.length * 10_000) / 10 : null,
    path,
    candidateTypes: hasPair ? `${localType} / ${remoteType}` : 'unavailable',
  };
}

export function safeConnectionState(value) {
  return ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'checking', 'completed'].includes(value) ? value : 'unknown';
}

export function isPeerInRoster(peerId, roster) {
  return Array.isArray(roster) && roster.some((person) => person && person.id === peerId);
}
