const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function matchesPartial(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesPartial(actual[index], item))
    );
  if (object(expected))
    return (
      object(actual) &&
      Object.entries(expected).every(
        ([key, value]) => Object.hasOwn(actual, key) && matchesPartial(actual[key], value),
      )
    );
  return actual === expected;
}

function containsSentinel(value, sentinels) {
  const pending = [value];
  const visited = new Set();
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    if (typeof item === "string") {
      if (
        sentinels.some(
          (sentinel) =>
            typeof sentinel === "string" && sentinel.length > 0 && item.includes(sentinel),
        )
      )
        return true;
      if (item.trimStart().startsWith("{") || item.trimStart().startsWith("[")) {
        try {
          const decoded = JSON.parse(item);
          if (!visited.has(item)) {
            visited.add(item);
            pending.push(decoded);
          }
        } catch {}
      }
    } else if (item !== null && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      pending.push(...Object.keys(item), ...Object.values(item));
    }
  }
  return false;
}

const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function coverage(value) {
  return object(value) &&
    Number.isInteger(value.expected) &&
    value.expected >= 0 &&
    Number.isInteger(value.found) &&
    value.found >= 0 &&
    value.found <= value.expected
    ? {
        expected: value.expected,
        found: value.found,
        ratio: value.expected ? value.found / value.expected : null,
      }
    : null;
}

export function gradeTrial(caseSpec, trial) {
  const offline = caseSpec.track === "offline-selection";
  const failures = [];
  const fail = (category, detail) => failures.push({ category, detail });
  const expected = caseSpec.expected;
  const wanted = expected.actions;
  const metrics = {
    actionsExpected: wanted.filter((item) => typeof item.action === "string").length,
    actionsActual: 0,
    actionsCorrect: 0,
    targetsExpected: wanted.filter((action) => action.outcome === "found").length,
    targetsCorrect: 0,
    wrongTargets: 0,
    duplicateTargets: 0,
    falseNotFound: 0,
  };
  Object.assign(metrics, {
    targetsReturned: 0,
    unsupportedExpected: wanted.filter((action) => action.outcome === "unsupported").length,
    unsupportedCorrect: 0,
    stateExpected: wanted.filter((action) => action.state).length,
    stateCorrect: 0,
    readinessExpected: wanted.filter((action) => action.interactability).length,
    readinessCorrect: 0,
    summaryExpected: Object.hasOwn(expected, "summary") ? 1 : 0,
    summaryCorrect: 0,
    decompositionCorrect: 0,
    processingComplete: trial?.result?.summary?.processingComplete ?? null,
  });
  const requestError = !!trial?.error || trial?.result?.outcome === "error";
  const actionErrors = Array.isArray(trial?.result?.actions)
    ? trial.result.actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => action?.outcome === "error")
    : [];
  metrics.operationalError = requestError || actionErrors.length > 0;
  metrics.expectedOperationalError =
    metrics.operationalError &&
    !trial?.error &&
    (!requestError || expected.outcome === "error") &&
    actionErrors.every(({ index }) => wanted[index]?.outcome === "error") &&
    object(trial?.result) &&
    (!Object.hasOwn(expected, "code") || trial.result.diagnostics?.code === expected.code);
  metrics.privacyLeak =
    trial?.observation?.privacyLeak === true ||
    trial?.captureObservation?.privacyLeak === true ||
    containsSentinel([trial?.result, trial?.evidence], caseSpec.privacySentinels ?? []);
  metrics.oracleLeak =
    trial?.observation?.oracleLeak === true ||
    containsSentinel([trial?.result, trial?.evidence], caseSpec.oracleSentinels ?? []);
  if (metrics.privacyLeak) fail("privacy", "A privacy sentinel reached retained result/evidence.");
  if (metrics.oracleLeak)
    fail("oracle_leak", "Oracle information reached model-visible or returned evidence.");
  if (trial?.observation?.passiveStateUnchanged === false)
    fail("passive_state", "Resolution changed page state beyond the permitted highlight.");
  metrics.savedLocator = null;
  metrics.freshResolution = null;
  if (caseSpec.mutation) {
    const mutation = trial?.mutation;
    const disposition =
      caseSpec.mutation.expected ??
      (["remove", "replacement"].includes(caseSpec.mutation.kind) ? "removed" : "preserved");
    const matches = mutation?.matches;
    const count = wanted.filter((action) => action.outcome === "found").length;
    const passed =
      ["preserved", "removed"].includes(disposition) &&
      mutation?.expected === disposition &&
      Array.isArray(matches) &&
      matches.length === count &&
      count > 0 &&
      matches.every((match) =>
        disposition === "removed"
          ? match?.count === 0
          : match?.count === 1 && match.intended === true,
      );
    metrics.savedLocator = { passed, expected: disposition ?? null };
    if (!passed)
      fail(
        "saved_locator",
        "Saved XPath reuse differs from the independently labelled mutation expectation.",
      );
    if (caseSpec.mutation.afterExpected) {
      const fresh = gradeTrial(
        { ...caseSpec, mutation: null, expected: caseSpec.mutation.afterExpected },
        mutation?.fresh,
      );
      metrics.freshResolution = fresh;
      for (const failure of fresh.failures) fail(`fresh_${failure.category}`, failure.detail);
    }
  }
  for (const [key, category] of [
    ["captureCoverage", "capture_coverage"],
    ["modelInputCoverage", "model_input_coverage"],
  ]) {
    metrics[key] = coverage(trial?.observation?.[key]);
    if (metrics[key] && metrics[key].found < metrics[key].expected)
      fail(category, "Independently labelled eligible targets are missing.");
    if (trial?.observation?.[key] != null && !metrics[key])
      fail("contract", `${key} observation is malformed.`);
  }
  metrics.latencyMs = number(trial?.elapsedMs);
  metrics.reportedCostUsd = number(trial?.result?.diagnostics?.usage?.cost);
  metrics.estimatedCostUsd = number(trial?.result?.diagnostics?.costEstimate?.totalCost);
  metrics.usage = object(trial?.result?.diagnostics?.usage)
    ? Object.fromEntries(
        ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedTokens"].map(
          (key) => [key, number(trial.result.diagnostics.usage[key])],
        ),
      )
    : null;
  metrics.accountingSource = metrics.usage ? "response_diagnostics" : "unavailable";
  if (Array.isArray(trial?.provider)) {
    const calls = trial.provider.filter((record) => record?.forwarded === true);
    const sum = (value) => {
      const values = calls.map((call) => number(value(call)));
      return values.length
        ? values.every((value) => value !== null)
          ? number(values.reduce((total, value) => total + value, 0))
          : null
        : trial.result?.diagnostics?.modelCalls === 0
          ? 0
          : null;
    };
    metrics.accountingSource = "provider_records";
    metrics.reportedCostUsd = sum((call) => call.reportedUsd);
    metrics.usage = {
      inputTokens: sum((call) => call.usage?.prompt_tokens),
      outputTokens: sum((call) => call.usage?.completion_tokens),
      totalTokens: sum((call) => call.usage?.total_tokens),
      reasoningTokens: sum((call) => call.usage?.completion_tokens_details?.reasoning_tokens),
      cachedTokens: sum((call) => call.usage?.prompt_tokens_details?.cached_tokens),
    };
  }
  metrics.stageTimingsMs = object(trial?.result?.diagnostics?.timingsMs)
    ? Object.fromEntries(
        Object.entries(trial.result.diagnostics.timingsMs).map(([key, value]) => [
          key,
          number(value),
        ]),
      )
    : null;
  if (metrics.operationalError && !metrics.expectedOperationalError)
    fail("operational", "An unexpected operational failure prevented resolution.");
  if (!object(trial?.result) || !Array.isArray(trial.result.actions)) {
    fail("contract", "Required resolution result/actions are missing or malformed.");
  } else {
    metrics.actionsActual = trial.result.actions.length;
    if (trial.result.target != null)
      fail("contract", "Unexpected top-level target or legacy action.");
    if (
      trial.result.outcome !== "error" &&
      (!trial.result.action ||
        trial.result.actions.some((item) => item?.action !== trial.result.action))
    )
      fail("contract", "All target items must share the command's one action.");
    if (
      trial.result.outcome === "error" &&
      (trial.result.actions.length > 0 ||
        trial.result.summary != null ||
        trial.result.action != null)
    )
      fail("contract", "Request errors must have empty actions and no summary.");
    if (Object.hasOwn(expected, "code") && trial.result.diagnostics?.code !== expected.code)
      fail("operational", "Operational diagnostic code differs from its label.");
    const unexpectedOperationalError =
      metrics.operationalError && !metrics.expectedOperationalError;
    if (
      !unexpectedOperationalError &&
      Object.hasOwn(expected, "outcome") &&
      trial.result.outcome !== expected.outcome
    )
      fail("outcome", "Request outcome differs from its label.");
    if (!unexpectedOperationalError && Object.hasOwn(expected, "summary")) {
      if (!matchesPartial(trial.result.summary, expected.summary))
        fail("summary", "Request summary differs from its label.");
      else metrics.summaryCorrect++;
    }
    if (
      !(requestError && expected.outcome !== "error") &&
      trial.result.actions.length !== wanted.length
    )
      fail("action_decomposition", "Required actions are missing or extra actions were returned.");
    const ids = new Set();
    const selectedTargets = new Set();
    if (
      trial.result.outcome !== "error" &&
      (trial.result.actions.length < 1 || trial.result.actions.length > 16)
    )
      fail("contract", "A command must return between one and sixteen target items.");
    for (const [index, action] of trial.result.actions.entries()) {
      const before = failures.length;
      let duplicateTarget = false;
      const label = wanted[index];
      if (!object(action)) {
        fail("contract", `Action ${index + 1} is malformed.`);
        continue;
      }
      if (typeof action.actionId !== "string" || !action.actionId || ids.has(action.actionId))
        fail("action_decomposition", `Action ${index + 1} has a missing or duplicate identity.`);
      if (trial.result.attemptId != null && action.diagnosticsReference !== trial.result.attemptId)
        fail("contract", `Action ${index + 1} does not reference the request diagnostics.`);
      ids.add(action.actionId);
      if (
        !label ||
        action.order !== index + 1 ||
        action.step !== label.step ||
        (typeof label.action === "string" && action.action !== label.action)
      )
        fail("action_decomposition", `Action ${index + 1} differs in order, step or action type.`);
      if (action.outcome === "error" && label?.outcome !== "error") {
        if (action.target != null)
          fail("contract", `Action ${index + 1} returned a target for an error outcome.`);
        continue;
      }
      if (label && action.outcome !== label.outcome)
        fail("outcome", `Action ${index + 1} outcome differs from its label.`);
      const reasonMatches = !label || !Object.hasOwn(label, "code") || action.code === label.code;
      if (!reasonMatches)
        fail("outcome", `Action ${index + 1} reason code differs from its label.`);
      if (label?.outcome === "found" && action.outcome === "not_found") metrics.falseNotFound++;
      if (label?.outcome === "unsupported" && action.outcome === "unsupported" && reasonMatches)
        metrics.unsupportedCorrect++;
      if (action.outcome === "found") {
        metrics.targetsReturned++;
        if (action.target?.candidateId) {
          if (selectedTargets.has(action.target.candidateId)) {
            duplicateTarget = true;
            metrics.duplicateTargets++;
            fail(
              "target_identity",
              "The same candidate was returned more than once for one command.",
            );
          }
          selectedTargets.add(action.target.candidateId);
        }
        if (offline) {
          const target = action.target;
          if (!object(target) || Object.keys(target).some((key) => key !== "candidateId"))
            fail(
              "contract",
              "Offline selection cannot claim browser XPath, geometry or readiness evidence.",
            );
          if (
            typeof target?.candidateId !== "string" ||
            target.candidateId !== label?.target?.candidateId
          ) {
            metrics.wrongTargets++;
            fail(
              "target_identity",
              `Target ${index + 1} differs from its independent source mapping.`,
            );
          } else if (!duplicateTarget) metrics.targetsCorrect++;
        } else {
          if (
            !object(action.target?.state) ||
            [
              "rendered",
              "inViewport",
              "enabled",
              "editable",
              "accessibilityExposed",
              "readonly",
            ].some((key) => typeof action.target.state[key] !== "boolean") ||
            action.target?.interactability?.action !== action.action
          )
            fail("contract", `Action ${index + 1} must return matching action interactability.`);
          const paths = action.target?.xpaths;
          const matches = trial.observation?.actions?.[index]?.matches;
          if (
            !Array.isArray(paths) ||
            paths.length !== 1 ||
            typeof paths[0] !== "string" ||
            !paths[0].trim()
          )
            fail("contract", `Action ${index + 1} must return exactly one XPath.`);
          const correct =
            Array.isArray(paths) &&
            paths.length > 0 &&
            Array.isArray(matches) &&
            matches.length === paths.length &&
            matches.every((match) => match?.count === 1 && match.intended === true);
          if (!correct) {
            fail(
              "target_identity",
              `Action ${index + 1} does not uniquely identify the intended node.`,
            );
            metrics.wrongTargets++;
          } else if (label?.outcome === "found" && !duplicateTarget) metrics.targetsCorrect++;
        }
      } else if (action.target != null) {
        fail("contract", `Action ${index + 1} returned a target for a non-found outcome.`);
      }
      if (label?.state) {
        if (offline) fail("contract", "Historical state is unavailable in offline selection.");
        if (!matchesPartial(action.target?.state, label.state))
          fail("target_state", `Action ${index + 1} state differs from its label.`);
        else metrics.stateCorrect++;
      }
      if (label?.interactability) {
        if (offline) fail("contract", "Historical readiness is unavailable in offline selection.");
        if (!matchesPartial(action.target?.interactability, label.interactability))
          fail("interactability", `Action ${index + 1} readiness differs from its label.`);
        else metrics.readinessCorrect++;
      }
      if (label?.action && failures.length === before) metrics.actionsCorrect++;
    }
    metrics.decompositionCorrect =
      (requestError && expected.outcome !== "error") ||
      failures.some(
        ({ category }) => category === "action_decomposition" || category === "contract",
      )
        ? 0
        : 1;
  }
  metrics.missingTargets = Math.max(0, metrics.targetsExpected - metrics.targetsCorrect);
  // Extra returned entries include wrong nodes and duplicate occurrences; duplicateTargets separates the latter.
  metrics.extraTargets = Math.max(0, metrics.targetsReturned - metrics.targetsCorrect);
  metrics.targetSetsExpected = metrics.targetsExpected > 0 ? 1 : 0;
  metrics.targetSetsComplete =
    metrics.targetSetsExpected &&
    !metrics.missingTargets &&
    !metrics.extraTargets &&
    !metrics.duplicateTargets
      ? 1
      : 0;
  metrics.semanticFailure = failures.some(({ category }) =>
    [
      "action_decomposition",
      "outcome",
      "target_identity",
      "target_state",
      "interactability",
      "summary",
    ].includes(category),
  );
  return { passed: failures.length === 0, failures, metrics };
}

function distribution(values) {
  const available = values.filter((value) => number(value) !== null).sort((a, b) => a - b);
  const percentile = (fraction) =>
    available.length ? available[Math.ceil(available.length * fraction) - 1] : null;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    observed: available.length,
    unavailable: values.length - available.length,
  };
}

function totals(values) {
  const available = values.filter((value) => number(value) !== null);
  const observedTotal = available.length ? available.reduce((sum, value) => sum + value, 0) : null;
  return {
    total: available.length === values.length && available.length ? observedTotal : null,
    observedTotal,
    observed: available.length,
    unavailable: values.length - available.length,
  };
}

function aggregate(entries) {
  const grades = entries.map((entry) => entry.grade);
  const metrics = {};
  for (const key of [
    "actionsExpected",
    "actionsActual",
    "actionsCorrect",
    "targetsExpected",
    "targetsReturned",
    "targetsCorrect",
    "wrongTargets",
    "missingTargets",
    "extraTargets",
    "duplicateTargets",
    "targetSetsExpected",
    "targetSetsComplete",
    "falseNotFound",
    "unsupportedExpected",
    "unsupportedCorrect",
    "stateExpected",
    "stateCorrect",
    "readinessExpected",
    "readinessCorrect",
    "summaryExpected",
    "summaryCorrect",
    "decompositionCorrect",
    "operationalError",
    "expectedOperationalError",
    "semanticFailure",
    "privacyLeak",
    "oracleLeak",
  ]) {
    metrics[key] = grades.reduce((sum, grade) => sum + Number(grade.metrics[key] ?? 0), 0);
  }
  metrics.actionAccuracy = metrics.actionsExpected
    ? metrics.actionsCorrect / metrics.actionsExpected
    : null;
  metrics.targetSetCompleteness = metrics.targetSetsExpected
    ? metrics.targetSetsComplete / metrics.targetSetsExpected
    : null;
  metrics.topOneAccuracy = metrics.targetsExpected
    ? metrics.targetsCorrect / metrics.targetsExpected
    : null;
  metrics.wrongTargetRate = metrics.targetsReturned
    ? metrics.wrongTargets / metrics.targetsReturned
    : null;
  metrics.falseNotFoundRate = metrics.targetsExpected
    ? metrics.falseNotFound / metrics.targetsExpected
    : null;
  for (const key of ["unsupported", "state", "readiness", "summary"])
    metrics[`${key}Accuracy`] = metrics[`${key}Expected`]
      ? metrics[`${key}Correct`] / metrics[`${key}Expected`]
      : null;
  metrics.decompositionAccuracy = grades.length
    ? metrics.decompositionCorrect / grades.length
    : null;
  metrics.processingComplete = {
    complete: grades.filter((grade) => grade.metrics.processingComplete === true).length,
    incomplete: grades.filter((grade) => grade.metrics.processingComplete === false).length,
    unavailable: grades.filter((grade) => typeof grade.metrics.processingComplete !== "boolean")
      .length,
  };
  for (const key of ["captureCoverage", "modelInputCoverage"]) {
    const observed = grades.map((grade) => grade.metrics[key]).filter((value) => value !== null);
    const expected = observed.reduce((sum, value) => sum + value.expected, 0);
    const found = observed.reduce((sum, value) => sum + value.found, 0);
    metrics[key] = {
      expected: observed.length ? expected : null,
      found: observed.length ? found : null,
      ratio: expected ? found / expected : null,
      observed: observed.length,
      unavailable: grades.length - observed.length,
    };
  }
  const mutations = grades.map((grade) => grade.metrics.savedLocator).filter(Boolean);
  const fresh = grades.flatMap((grade) =>
    grade.metrics.freshResolution ? [{ grade: grade.metrics.freshResolution }] : [],
  );
  const passed = grades.filter((grade) => grade.passed).length;
  const stages = [
    ...new Set(grades.flatMap((grade) => Object.keys(grade.metrics.stageTimingsMs ?? {}))),
  ].sort();
  return {
    trials: entries.length,
    passed,
    failed: entries.length - passed,
    passRate: entries.length ? passed / entries.length : null,
    metrics,
    latencyMs: distribution(grades.map((grade) => grade.metrics.latencyMs)),
    stageTimingsMs: Object.fromEntries(
      stages.map((key) => [
        key,
        distribution(grades.map((grade) => grade.metrics.stageTimingsMs?.[key])),
      ]),
    ),
    cost: {
      reportedUsd: totals(grades.map((grade) => grade.metrics.reportedCostUsd)),
      estimatedUsd: totals(grades.map((grade) => grade.metrics.estimatedCostUsd)),
    },
    usage: Object.fromEntries(
      ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedTokens"].map(
        (key) => [key, totals(grades.map((grade) => grade.metrics.usage?.[key]))],
      ),
    ),
    accountingSources: Object.fromEntries(
      ["provider_records", "response_diagnostics", "unavailable"].map((source) => [
        source,
        grades.filter((grade) => (grade.metrics.accountingSource ?? "unavailable") === source)
          .length,
      ]),
    ),
    savedLocator: {
      trials: mutations.length,
      passed: mutations.filter((mutation) => mutation.passed).length,
      failed: mutations.filter((mutation) => !mutation.passed).length,
    },
    freshResolution: fresh.length ? aggregate(fresh) : null,
  };
}

function datasetForecast(manifest, trials) {
  const measured = trials.filter(
    (trial) =>
      number(trial.result?.diagnostics?.usage?.inputTokens) !== null &&
      number(trial.result?.diagnostics?.usage?.outputTokens) !== null,
  );
  const mean = (key) =>
    measured.length
      ? measured.reduce((sum, trial) => sum + trial.result.diagnostics.usage[key], 0) /
        measured.length
      : null;
  const input = mean("inputTokens"),
    output = mean("outputTokens");
  const pricing = manifest.pricing;
  const perRecord =
    input !== null && pricing
      ? input * Number(pricing.prompt) +
        output * Number(pricing.completion) +
        Number(pricing.request ?? 0)
      : null;
  return {
    basis:
      "Sample mean tokens at recorded route prices; extrapolation, not a spending authorization or worst-case bound",
    sampleSelection: manifest.selection,
    measuredTrials: measured.length,
    inputTokensPerRecord: input,
    outputTokensPerRecord: output,
    repetitions: manifest.plan.repetitions,
    pricing: pricing ?? null,
    splits: Object.fromEntries(
      Object.entries(manifest.inventory?.splits ?? {}).map(([split, inventory]) => {
        const eligible = inventory.statuses?.["offline-eligible"] ?? 0;
        return [
          split,
          {
            eligible,
            projectedUsd:
              perRecord === null ? null : eligible * perRecord * manifest.plan.repetitions,
            limitation:
              split === manifest.selection?.split
                ? "Pilot may not represent the full split"
                : "Extrapolated from another split; no held-out inference was performed",
          },
        ];
      }),
    ),
  };
}

export function summarize(manifest, trials) {
  const cases = new Map(manifest.cases.map((caseSpec) => [caseSpec.id, caseSpec]));
  const order = manifest.plan.caseOrder;
  const repetitions = manifest.plan.repetitions;
  const planned = new Map();
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const caseId of order)
      planned.set(JSON.stringify([caseId, repetition]), { caseId, repetition, attempt: 1 });
  }
  const failures = [];
  const first = new Map();
  const reruns = [];
  const attempts = new Set();
  const record = (entry) => {
    for (const failure of entry.grade.failures)
      failures.push({
        caseId: entry.caseId,
        repetition: entry.repetition,
        attempt: entry.attempt,
        ...failure,
      });
  };
  for (const trial of trials) {
    const caseId = trial?.caseId;
    const repetition = trial?.repetition ?? 1;
    const attempt = trial?.attempt ?? 1;
    const identity = { caseId: caseId ?? null, repetition, attempt };
    const key = JSON.stringify([caseId, repetition]);
    const attemptKey = JSON.stringify([caseId, repetition, attempt]);
    if (!planned.has(key) || !cases.has(caseId) || !Number.isInteger(attempt) || attempt < 1) {
      failures.push({
        ...identity,
        category: "unplanned_trial",
        detail: "Trial is outside the declared case/repetition plan.",
      });
      continue;
    }
    if (attempts.has(attemptKey)) {
      failures.push({
        ...identity,
        category: "duplicate_trial",
        detail: "A case/repetition/attempt identity occurs more than once.",
      });
      continue;
    }
    attempts.add(attemptKey);
    const entry = { ...identity, grade: gradeTrial(cases.get(caseId), trial) };
    record(entry);
    if (attempt === 1) first.set(key, entry);
    else reruns.push(entry);
  }
  const completedTrials = first.size;
  for (const [key, identity] of planned) {
    if (first.has(key)) continue;
    const grade = gradeTrial(cases.get(identity.caseId), null);
    grade.failures.unshift({
      category: "missing_trial",
      detail: "A planned first attempt is absent from retained trials.",
    });
    const entry = { ...identity, grade };
    first.set(key, entry);
    record(entry);
  }
  const entries = [...first.values()];
  const groups = Object.fromEntries(
    ["family", "split", "category", "dataset", "track"].map((key) => [
      key,
      Object.fromEntries(
        [...new Set(entries.map((entry) => cases.get(entry.caseId)[key] ?? "unspecified"))]
          .sort()
          .map((value) => [
            value,
            aggregate(
              entries.filter((entry) => (cases.get(entry.caseId)[key] ?? "unspecified") === value),
            ),
          ]),
      ),
    ]),
  );
  return {
    passed: failures.length === 0 && planned.size > 0,
    qualification: "incomplete",
    mode: manifest.mode ?? "unavailable",
    modelQualityMeasured: manifest.mode === "live",
    ...(manifest.track === "offline-selection"
      ? {
          inventory: manifest.inventory,
          forecast: datasetForecast(manifest, trials),
          measurement: manifest.measurement,
          unavailable: manifest.unavailable,
        }
      : {}),
    plannedTrials: planned.size,
    completedTrials,
    missingTrials: planned.size - completedTrials,
    firstAttempt: aggregate(entries),
    diagnosticReruns: aggregate(reruns),
    groups,
    failures,
  };
}
