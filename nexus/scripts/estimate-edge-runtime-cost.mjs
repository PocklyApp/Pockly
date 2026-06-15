#!/usr/bin/env node

const defaults = Object.freeze({
  daysPerMonth: 30,
  edgeRequestUSDPerMillion: 0.30,
  coordinationRequestUSDPerMillion: 0.15,
  sqlReadUSDPerMillion: 0.001,
  sqlWriteUSDPerMillion: 1.00,
  objectWriteUSDPerMillion: 4.50,
  objectReadUSDPerMillion: 0.36,
  objectStorageUSDPerGBMonth: 0.015,
  coordinationDurationUSDPerMillionGBS: 12.50,
});

const profiles = Object.freeze({
  typical: Object.freeze({
    foregroundMinutesPerDay: 30,
    hostPollIntervalSeconds: 15,
    catalogRefreshIntervalSeconds: 60,
    activeTurnMinutesPerDay: 10,
    activeEventPollIntervalSeconds: 2,
    openedSessionsPerDay: 10,
    openHintsPerDay: 10,
    sessionMetadataWritesPerDay: 10,
    agentTurnsPerDay: 10,
    averageBlocksPerTurn: 4,
    sqlReadRowsPerMonth: 250_000,
    objectWritesPerMonth: 0,
    objectReadsPerMonth: 0,
    objectGBMonth: 0.05,
    coordinationDurationGBSPerMonth: 120,
  }),
  multi_tab_visible: Object.freeze({
    foregroundMinutesPerDay: 30,
    hostPollIntervalSeconds: 15,
    catalogRefreshIntervalSeconds: 60,
    activeTurnMinutesPerDay: 10,
    activeEventPollIntervalSeconds: 2,
    openedSessionsPerDay: 10,
    openHintsPerDay: 10,
    sessionMetadataWritesPerDay: 10,
    agentTurnsPerDay: 10,
    averageBlocksPerTurn: 4,
    // Three visible tabs share one workspace network leader. Follower tabs
    // receive local BroadcastChannel updates and do not multiply presence,
    // catalog, or realtime coordination work.
    visibleTabs: 3,
    followerLocalBroadcastOnly: true,
    sqlReadRowsPerMonth: 260_000,
    objectWritesPerMonth: 0,
    objectReadsPerMonth: 0,
    objectGBMonth: 0.05,
    coordinationDurationGBSPerMonth: 120,
  }),
  background_hanging_tab: Object.freeze({
    foregroundMinutesPerDay: 0,
    hostPollIntervalSeconds: 15,
    catalogRefreshIntervalSeconds: 60,
    // A tab hidden for a full month must only poll during the initial
    // background grace window. The Web client pauses presence polling after
    // 10 minutes in the background.
    backgroundPresenceMinutesPerMonth: 10,
    backgroundPollIntervalSeconds: 60,
    activeTurnMinutesPerDay: 0,
    activeEventPollIntervalSeconds: 2,
    openedSessionsPerDay: 0,
    openHintsPerDay: 0,
    sessionMetadataWritesPerDay: 0,
    agentTurnsPerDay: 0,
    averageBlocksPerTurn: 0,
    sqlReadRowsPerMonth: 100,
    objectWritesPerMonth: 0,
    objectReadsPerMonth: 0,
    objectGBMonth: 0.001,
    coordinationDurationGBSPerMonth: 1,
  }),
  large_local_first: Object.freeze({
    foregroundMinutesPerDay: 45,
    hostPollIntervalSeconds: 15,
    // Large-session readers rely on IndexedDB + delta catalog refresh. The
    // foreground safety refresh is intentionally slower than the normal profile
    // because older history is pulled from the local daemon on demand.
    catalogRefreshIntervalSeconds: 120,
    activeTurnMinutesPerDay: 15,
    activeEventPollIntervalSeconds: 3,
    openedSessionsPerDay: 12,
    // Large sessions are acknowledged on open but do not write
    // session_open_hints or push SYNC_HINT. The first window is loaded only
    // when the user explicitly requests earlier context.
    openHintsPerDay: 0,
    manualHistoryWindowsPerDay: 12,
    sessionMetadataWritesPerDay: 12,
    agentTurnsPerDay: 12,
    averageBlocksPerTurn: 5,
    sqlReadRowsPerMonth: 500_000,
    objectWritesPerMonth: 0,
    objectReadsPerMonth: 0,
    objectGBMonth: 0.05,
    coordinationDurationGBSPerMonth: 120,
  }),
});

const optionAliases = Object.freeze({
  daysPerMonth: "daysPerMonth",
  edgeRequestUsdPerMillion: "edgeRequestUSDPerMillion",
  coordinationRequestUsdPerMillion: "coordinationRequestUSDPerMillion",
  sqlReadUsdPerMillion: "sqlReadUSDPerMillion",
  sqlWriteUsdPerMillion: "sqlWriteUSDPerMillion",
  objectWriteUsdPerMillion: "objectWriteUSDPerMillion",
  objectReadUsdPerMillion: "objectReadUSDPerMillion",
  objectStorageUsdPerGbMonth: "objectStorageUSDPerGBMonth",
  coordinationDurationUsdPerMillionGbs: "coordinationDurationUSDPerMillionGBS",
});

function main(argv = process.argv.slice(2)) {
  const { options, names } = parseArgs(argv);
  const selected = names.length ? names : Object.keys(profiles);
  const output = {};
  for (const name of selected) {
    const profile = profiles[name];
    if (!profile) throw new Error(`unknown profile: ${name}`);
    output[name] = estimateProfile(profile, options);
  }
  console.log(JSON.stringify(output, null, 2));
}

function parseArgs(args) {
  const options = { ...defaults };
  const names = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage(0);
      return { options, names };
    }
    if (arg.startsWith("--")) {
      const rawKey = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const key = optionAliases[rawKey] || rawKey;
      if (!(key in options)) throw new Error(`unknown option: ${arg}`);
      options[key] = positiveNumber(args[++i], arg);
      continue;
    }
    names.push(arg);
  }
  return { options, names };
}

function estimateProfile(profile, prices) {
  const days = prices.daysPerMonth;
  const hostPolls = Math.ceil(profile.foregroundMinutesPerDay * 60 / profile.hostPollIntervalSeconds) * days;
  const backgroundHostPolls = Math.ceil((profile.backgroundPresenceMinutesPerMonth || 0) * 60 / (profile.backgroundPollIntervalSeconds || profile.hostPollIntervalSeconds));
  const catalogRefreshes = Math.ceil(profile.foregroundMinutesPerDay * 60 / profile.catalogRefreshIntervalSeconds) * days;
  const activeEventPolls = Math.ceil(profile.activeTurnMinutesPerDay * 60 / profile.activeEventPollIntervalSeconds) * days;
  const openedSessionRequests = (profile.openedSessionsPerDay || 0) * days;
  const openHintWrites = positiveNumber(profile.openHintsPerDay ?? profile.openedSessionsPerDay ?? 0, 0) * days;
  const manualHistoryRequests = (profile.manualHistoryWindowsPerDay || 0) * days;
  const injectRequests = profile.agentTurnsPerDay * days;
  const turnBlockWrites = profile.agentTurnsPerDay * profile.averageBlocksPerTurn * days;
  const sessionMetadataWrites = positiveNumber(profile.sessionMetadataWritesPerDay ?? profile.agentTurnsPerDay ?? 0, 0) * days;

  const edgeRequests =
    hostPolls +
    backgroundHostPolls +
    catalogRefreshes +
    activeEventPolls +
    openedSessionRequests +
    manualHistoryRequests +
    injectRequests;

  const coordinationRequests =
    hostPolls +
    backgroundHostPolls +
    injectRequests +
    manualHistoryRequests +
    openHintWrites;

  const sqlWrites =
    turnBlockWrites +
    sessionMetadataWrites +
    openHintWrites;

  const cost = {
    edge_requests: edgeRequests / 1_000_000 * prices.edgeRequestUSDPerMillion,
    coordination_requests: coordinationRequests / 1_000_000 * prices.coordinationRequestUSDPerMillion,
    coordination_duration: profile.coordinationDurationGBSPerMonth / 1_000_000 * prices.coordinationDurationUSDPerMillionGBS,
    sql_reads: profile.sqlReadRowsPerMonth / 1_000_000 * prices.sqlReadUSDPerMillion,
    sql_writes: sqlWrites / 1_000_000 * prices.sqlWriteUSDPerMillion,
    object_writes: profile.objectWritesPerMonth / 1_000_000 * prices.objectWriteUSDPerMillion,
    object_reads: profile.objectReadsPerMonth / 1_000_000 * prices.objectReadUSDPerMillion,
    object_storage: profile.objectGBMonth * prices.objectStorageUSDPerGBMonth,
  };
  const total = Object.values(cost).reduce((sum, value) => sum + value, 0);
  return {
    assumptions: profile,
    usage: {
      edge_requests: edgeRequests,
      coordination_requests: coordinationRequests,
      opened_session_requests: openedSessionRequests,
      open_hint_writes: openHintWrites,
      manual_history_requests: manualHistoryRequests,
      turn_block_writes: turnBlockWrites,
      session_metadata_writes: sessionMetadataWrites,
      coordination_duration_gb_s: profile.coordinationDurationGBSPerMonth,
      sql_read_rows: profile.sqlReadRowsPerMonth,
      sql_write_rows: sqlWrites,
      object_writes: profile.objectWritesPerMonth,
      object_reads: profile.objectReadsPerMonth,
      object_gb_month: profile.objectGBMonth,
    },
    marginal_usd_per_month: {
      ...roundObject(cost),
      total: roundUSD(total),
    },
  };
}

function roundObject(value) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundUSD(entry)]));
}

function roundUSD(value) {
  return Number(value.toFixed(8));
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function printUsage(exitCode) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: estimate-edge-runtime-cost.mjs [options] [profile...]

Profiles:
  ${Object.keys(profiles).join("\n  ")}

Options accept camel-cased price names as dashed CLI flags, for example:
  --edge-request-usd-per-million 0.30
  --coordination-request-usd-per-million 0.15
`);
  process.exitCode = exitCode;
}

main();
